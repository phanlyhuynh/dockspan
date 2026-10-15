import { create } from 'zustand';
import { api, on, type Cluster, type ClusterCheck, type K8sDeployment, type K8sKind, type K8sPod, type K8sService, type PortFwd } from './api';
import { useApp } from './store';
import { isAuthError } from './lib/k8s';
import { t } from './i18n';

/**
 * Kubernetes state, independent of the Docker context (switching one never touches the other).
 * Lists of the shown cluster come from `k8s_list` and are reloaded on `k8s://watch` events (debounced), not by polling.
 */
export type ClusterState = { state: 'checking' | 'ok' | 'auth' | 'offline'; check?: ClusterCheck; error?: string };
export type KTab = 'deployments' | 'pods' | 'services' | 'pf';

interface K8sStore {
  clusters: Cluster[];
  activeId: string | null;
  loaded: boolean;
  status: Record<string, ClusterState>;
  /** Namespaces of the shown cluster; `ns` null = all namespaces. */
  namespaces: string[];
  ns: string | null;
  deployments: K8sDeployment[]; pods: K8sPod[]; services: K8sService[];
  listsLoaded: boolean;
  pfs: PortFwd[];
  tab: KTab;
  /** Running actions, keyed `d:<ns>/<name>`, `p:<ns>/<name>`, `s:<ns>/<name>:<port>`. */
  busy: Record<string, boolean>;

  init: () => Promise<void>;
  loadClusters: () => Promise<void>;
  select: (id: string) => Promise<void>;
  connect: (id: string, relogin?: boolean) => Promise<void>;
  check: (id: string) => Promise<ClusterCheck | null>;
  setNs: (ns: string | null) => Promise<void>;
  setTab: (tab: KTab) => void;
  refresh: (kind: K8sKind) => Promise<void>;
  watch: () => void;
  unwatch: () => void;
  scale: (d: K8sDeployment, delta: number) => Promise<void>;
  restart: (d: K8sDeployment) => void;
  deletePod: (p: K8sPod) => void;
  startPf: (s: K8sService, port: number) => Promise<void>;
  stopPf: (id: string) => Promise<void>;
  remove: (c: Cluster) => void;
}

let inited = false;
/** Bumped on every cluster/namespace change so late responses of the previous selection are dropped. */
let gen = 0;
let watching = false;
const timers: Record<string, ReturnType<typeof setTimeout>> = {};
const toast = (msg: string, kind?: 'ok' | 'info' | 'err') => useApp.getState().toast(msg, kind);
const msgOf = (e: unknown) => (e as Error).message;

export const useK8s = create<K8sStore>()((set, get) => ({
  clusters: [], activeId: null, loaded: false, status: {},
  namespaces: [], ns: null,
  deployments: [], pods: [], services: [], listsLoaded: false,
  pfs: [], tab: 'deployments', busy: {},

  init: async () => {
    if (inited) return;
    inited = true;
    await on<{ cluster: string; kind: K8sKind }>('k8s://watch', (e) => {
      if (e.cluster !== get().activeId) return;
      clearTimeout(timers[e.kind]);
      timers[e.kind] = setTimeout(() => void get().refresh(e.kind), 300);
    });
    await get().loadClusters();
    void api.k8sPfList().then((pfs) => set({ pfs })).catch(() => {});
  },

  loadClusters: async () => {
    try {
      const r = await api.k8sClusters();
      set({ clusters: r.clusters, activeId: get().activeId && r.clusters.some((c) => c.id === get().activeId) ? get().activeId : r.activeId, loaded: true });
    } catch (e) {
      set({ loaded: true });
      toast(msgOf(e), 'err');
    }
  },

  select: async (id) => {
    if (id === get().activeId && get().status[id]?.state === 'ok') return;
    gen++;
    set({ activeId: id, ns: null, namespaces: [], deployments: [], pods: [], services: [], listsLoaded: false });
    void api.k8sSelect(id).catch(() => {});
    await get().connect(id);
  },

  connect: async (id, relogin = false) => {
    const my = ++gen;
    set((s) => ({ status: { ...s.status, [id]: { state: 'checking', check: s.status[id]?.check } } }));
    try {
      const check = await api.k8sTest(id, relogin);
      set((s) => ({ status: { ...s.status, [id]: { state: 'ok', check } } }));
      if (id !== get().activeId || my !== gen) return;
      const namespaces = await api.k8sNamespaces(id).catch(() => [] as string[]);
      if (my !== gen) return;
      // A user limited to one namespace sees only that one: select it instead of "All".
      set({ namespaces, ns: namespaces.length === 1 ? namespaces[0] : get().ns });
      await Promise.all([get().refresh('deployments'), get().refresh('pods'), get().refresh('services')]);
      set({ listsLoaded: true });
      if (watching) get().watch();
    } catch (e) {
      const error = msgOf(e);
      set((s) => ({ status: { ...s.status, [id]: { state: isAuthError(error) ? 'auth' : 'offline', error } } }));
      if (relogin) toast(error, 'err');
    }
  },

  check: async (id) => {
    set((s) => ({ status: { ...s.status, [id]: { state: 'checking', check: s.status[id]?.check } } }));
    try {
      const check = await api.k8sTest(id);
      set((s) => ({ status: { ...s.status, [id]: { state: 'ok', check } } }));
      return check;
    } catch (e) {
      const error = msgOf(e);
      set((s) => ({ status: { ...s.status, [id]: { state: isAuthError(error) ? 'auth' : 'offline', error } } }));
      toast(error, 'err');
      return null;
    }
  },

  setNs: async (ns) => {
    gen++;
    set({ ns });
    await Promise.all([get().refresh('deployments'), get().refresh('pods'), get().refresh('services')]);
    if (watching) get().watch();
  },

  setTab: (tab) => set({ tab }),

  refresh: async (kind) => {
    const id = get().activeId;
    if (!id || get().status[id]?.state !== 'ok') return;
    const my = gen;
    try {
      const rows = await api.k8sList<never>(id, kind, get().ns);
      if (my !== gen || id !== get().activeId) return;
      set({ [kind]: rows } as Partial<K8sStore>);
    } catch (e) {
      if (my === gen) toast(msgOf(e), 'err');
    }
  },

  // Watch only while the Kubernetes page is open.
  watch: () => {
    watching = true;
    const id = get().activeId;
    if (id && get().status[id]?.state === 'ok') void api.k8sWatch(id, get().ns).catch(() => {});
  },
  unwatch: () => {
    watching = false;
    void api.k8sUnwatch().catch(() => {});
  },

  scale: async (d, delta) => {
    const id = get().activeId;
    const key = `d:${d.namespace}/${d.name}`;
    if (!id || get().busy[key]) return;
    const replicas = Math.max(0, d.replicas + delta);
    const run = async () => {
      set((s) => ({ busy: { ...s.busy, [key]: true }, deployments: s.deployments.map((x) => (x === d ? { ...x, replicas } : x)) }));
      try {
        await api.k8sScale(id, d.namespace, d.name, replicas);
        toast(t("Scaled {name} to {replicas} replicas", { name: d.name, replicas }));
      } catch (e) {
        toast(msgOf(e), 'err');
      } finally {
        set((s) => { const b = { ...s.busy }; delete b[key]; return { busy: b }; });
        void get().refresh('deployments');
      }
    };
    if (replicas === 0) {
      useApp.getState().ask({
        title: t("Scale {name} to 0?", { name: d.name }), body: t("Every pod of the deployment will be stopped until it is scaled up again."),
        yes: t("Scale to 0"), danger: true, action: run,
      });
    } else await run();
  },

  restart: (d) => {
    const id = get().activeId;
    if (!id) return;
    const key = `d:${d.namespace}/${d.name}`;
    useApp.getState().ask({
      title: t("Rollout restart {name}?", { name: d.name }),
      body: t("Pods are replaced one by one with new pods (kubectl rollout restart deployment/{name}).", { name: d.name }),
      yes: 'Rollout restart',
      action: async () => {
        set((s) => ({ busy: { ...s.busy, [key]: true } }));
        try {
          await api.k8sRestart(id, d.namespace, d.name);
          toast(t("Restarting {name}", { name: d.name }));
        } catch (e) {
          toast(msgOf(e), 'err');
        } finally {
          set((s) => { const b = { ...s.busy }; delete b[key]; return { busy: b }; });
        }
      },
    });
  },

  deletePod: (p) => {
    const id = get().activeId;
    if (!id) return;
    const managed = p.owner?.kind === 'ReplicaSet' || p.owner?.kind === 'StatefulSet' || p.owner?.kind === 'DaemonSet';
    useApp.getState().ask({
      title: t("Delete pod {name}?", { name: p.name }),
      body: managed ? t("The pod is managed by {kind} {owner}, which will create a replacement.", { kind: p.owner!.kind, owner: p.owner!.name }) : t("This pod has no controller, so it will not be recreated."),
      yes: t("Delete pod"), danger: true,
      action: async () => {
        const key = `p:${p.namespace}/${p.name}`;
        set((s) => ({ busy: { ...s.busy, [key]: true } }));
        try {
          await api.k8sDeletePod(id, p.namespace, p.name);
          toast(managed && p.owner?.kind === 'ReplicaSet' ? t("Deleted pod {name}, the ReplicaSet is creating a new pod", { name: p.name }) : t("Deleted pod {name}", { name: p.name }));
        } catch (e) {
          toast(msgOf(e), 'err');
        } finally {
          set((s) => { const b = { ...s.busy }; delete b[key]; return { busy: b }; });
          void get().refresh('pods');
        }
      },
    });
  },

  startPf: async (svc, port) => {
    const id = get().activeId;
    const key = `s:${svc.namespace}/${svc.name}:${port}`;
    if (!id || get().busy[key]) return;
    set((s) => ({ busy: { ...s.busy, [key]: true } }));
    try {
      const pf = await api.k8sPfStart(id, svc.namespace, svc.name, port);
      set((s) => ({ pfs: [...s.pfs.filter((x) => x.id !== pf.id), pf].sort((a, b) => a.localPort - b.localPort) }));
      toast(t("Forwarding localhost:{local} → svc/{name}:{port}", { local: pf.localPort, name: svc.name, port }));
    } catch (e) {
      toast(msgOf(e), 'err');
    } finally {
      set((s) => { const b = { ...s.busy }; delete b[key]; return { busy: b }; });
    }
  },

  stopPf: async (pfId) => {
    const pf = get().pfs.find((p) => p.id === pfId);
    await api.k8sPfStop(pfId).catch(() => {});
    set((s) => ({ pfs: s.pfs.filter((p) => p.id !== pfId) }));
    if (pf) toast(t("Stopped forwarding localhost:{local}", { local: pf.localPort }), 'info');
  },

  remove: (c) => {
    const n = get().pfs.filter((p) => p.clusterId === c.id).length;
    useApp.getState().ask({
      title: t("Remove cluster {name}?", { name: c.name }),
      body: t("Only removes it from the app; the kubeconfig file is not changed.") + (n ? '\n' + t("{n} port-forwards of this cluster will be stopped.", { n }) : ''),
      yes: t("Remove"), danger: true,
      action: async () => {
        try {
          await api.k8sRemove(c.id);
          set((s) => ({ pfs: s.pfs.filter((p) => p.clusterId !== c.id), activeId: s.activeId === c.id ? null : s.activeId }));
          await get().loadClusters();
          toast(t("Removed cluster {name}", { name: c.name }), 'info');
        } catch (e) {
          toast(msgOf(e), 'err');
        }
      },
    });
  },
}));
