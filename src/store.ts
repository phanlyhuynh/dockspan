import { create } from 'zustand';
import {
  api, on, type Container, type CtxInfo, type DfInfo, type DockerEvent, type EngineInfo, type EngineStatus, type ImageRow,
  type NetworkRow, type Project, type Schedule, type VolumeRow,
} from './api';
import { hhmm, fmtBytes } from './lib/format';
import { DEFAULT_PRUNE_SEL, computePruneDefs, selectedTotal, type PruneId } from './lib/prune';
import { imgRef, withTag } from './lib/ui';
import { getLang, setLang as applyLang, t, type Lang } from './i18n';

export type View = 'dashboard' | 'projects' | 'containers' | 'images' | 'networks' | 'volumes' | 'kubernetes' | 'cleanup' | 'settings' | 'preferences';
export type Tab = 'logs' | 'terminal' | 'stats' | 'inspect';
export type ToastKind = 'ok' | 'info' | 'err';
export interface Toast { id: string; msg: string; kind: ToastKind }
export interface AppEvent { time: string; kind: string; text: string }

export type ModalState =
  | { kind: 'confirm'; title: string; body: string; yes: string; danger?: boolean; action: () => void | Promise<void> }
  | { kind: 'info'; title: string; body: string }
  | { kind: 'palette' }
  | { kind: 'add'; path?: string }
  | { kind: 'files'; projectId: string }
  | { kind: 'rename'; projectId: string }
  | { kind: 'run'; image?: string }
  | { kind: 'pull' }
  | { kind: 'build'; projectId?: string }
  | { kind: 'image'; ref: string }
  | { kind: 'netCreate' }
  | { kind: 'net'; id: string }
  | { kind: 'volCreate' }
  | { kind: 'vol'; name: string }
  | { kind: 'pruneConfirm' }
  | { kind: 'schedule' };

export type EngineState = 'on' | 'off' | 'starting' | 'stopping' | 'connecting';

export interface PullLayer { id: string; status: string; pct: number }
export interface PullState { image: string; layers: PullLayer[]; done: boolean; error?: string; note?: string }
export interface BuildState { tag: string; lines: string[]; done: boolean; error?: string }

interface Store {
  /** UI language; changing it makes App re-render the whole tree. */
  lang: Lang;
  setLang: (l: Lang) => void;
  view: View;
  /** `lost`: a running engine suddenly lost its connection (as opposed to the user stopping it on purpose). */
  engine: { state: EngineState; ctx?: EngineStatus['ctx']; info?: EngineInfo; lost?: boolean };
  contexts: CtxInfo[];
  ctxMenu: boolean;

  containers: Container[]; images: ImageRow[]; networks: NetworkRow[]; volumes: VolumeRow[]; projects: Project[];
  df: DfInfo | null; loaded: boolean;
  stats: Record<string, { cpu: number; memUsed: number; memLimit: number }>;
  events: AppEvent[];

  cq: string; onlyRunning: boolean; selected: string | null; tab: Tab;
  /** Containers that have a terminal open: their sessions are kept alive even when another container is selected. */
  terms: Record<string, boolean>;
  openTerm: (id: string) => void;
  closeTerm: (id: string) => void;
  busy: Record<string, string>;
  projectLine: Record<string, string>;
  backingUp: Record<string, boolean>;

  prune: Record<PruneId, boolean>; pruneOpen: Record<string, boolean>;
  pruneState: 'idle' | 'running' | 'done'; prunedBytes: number;
  schedule: Schedule | null;
  pull: PullState | null; build: BuildState | null;

  modal: ModalState | null; toasts: Toast[];

  init: () => Promise<void>;
  setView: (v: View) => void;
  toast: (msg: string, kind?: ToastKind) => void;
  dismissToast: (id: string) => void;
  ev: (kind: string, text: string) => void;
  openModal: (m: ModalState) => void;
  closeModal: () => void;
  ask: (cfg: Omit<Extract<ModalState, { kind: 'confirm' }>, 'kind'>) => void;

  loadAll: () => Promise<void>;
  refresh: (what: 'containers' | 'images' | 'networks' | 'volumes' | 'projects' | 'df') => Promise<void>;

  engineOk: () => boolean;
  toggleEngine: () => Promise<void>;
  switchCtx: (id: string) => Promise<void>;

  startC: (id: string) => Promise<void>;
  stopC: (id: string) => Promise<void>;
  restartC: (id: string) => Promise<void>;
  removeC: (id: string) => void;
  setSelected: (id: string | null, tab?: Tab) => void;
  setCq: (q: string) => void;
  setOnlyRunning: (v: boolean) => void;
  setTab: (t: Tab) => void;
  showProjectContainers: (name: string) => void;

  composeRun: (id: string, action: 'up' | 'stop' | 'restart' | 'down') => Promise<void>;
  forgetProject: (id: string) => void;
  composeDown: (id: string) => void;

  startPull: (image: string) => Promise<void>;
  resetPull: () => void;
  startBuild: (projectId: string, tag: string, nocache: boolean) => Promise<void>;
  resetBuild: () => void;
  removeImage: (im: ImageRow) => void;

  removeNetwork: (n: NetworkRow) => void;
  removeVolume: (name: string, size?: number) => void;
  backupVolume: (name: string) => Promise<void>;

  togglePrune: (id: PruneId) => void;
  togglePruneOpen: (id: string) => void;
  askPrune: () => void;
  doPrune: () => Promise<void>;
}

const EVENTS_CAP = 200;
let toastSeq = 0;
let inited = false;
const timers: Record<string, ReturnType<typeof setTimeout>> = {};

/** Coalesce several consecutive events into a single reload. */
function debounced(key: string, ms: number, fn: () => void) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, ms);
}

function loadEvents(ctxId: string): AppEvent[] {
  try {
    return JSON.parse(localStorage.getItem(`dockspan.events.${ctxId}`) ?? '[]');
  } catch {
    return [];
  }
}
function saveEvents(ctxId: string, ev: AppEvent[]) {
  try {
    localStorage.setItem(`dockspan.events.${ctxId}`, JSON.stringify(ev.slice(0, EVENTS_CAP)));
  } catch {
    /* localStorage may be unavailable */
  }
}

/** Translate a Docker event into a "Recent events" line; returns null for noise. */
export function describeEvent(e: DockerEvent): AppEvent | null {
  const name = e.name ?? e.id?.slice(0, 12) ?? '';
  const time = hhmm(new Date(e.time * 1000 || Date.now()));
  if (e.type === 'container') {
    switch (e.action) {
      case 'create': return { time, kind: 'create', text: t("{name} created", { name }) };
      case 'start': return { time, kind: 'start', text: t("{name} started", { name }) };
      case 'stop': return { time, kind: 'stop', text: t("{name} stopped", { name }) };
      case 'restart': return { time, kind: 'restart', text: `${name} restart` };
      case 'die':
        // A manual stop already has a `stop` event; only report when a container exits abnormally on its own.
        if (e.exitCode && !['0', '137', '143'].includes(e.exitCode)) return { time, kind: 'die', text: t("{name} exited (exit {exitCode})", { name, exitCode: e.exitCode }) };
        return null;
      case 'destroy': return { time, kind: 'remove', text: t("{name} removed", { name }) };
      default: return null;
    }
  }
  if (e.type === 'image') {
    if (e.action === 'pull') return { time, kind: 'pull', text: t("{name} pulled", { name }) };
    if (e.action === 'delete') return { time, kind: 'remove', text: t("{v0} removed", { v0: name || 'image' }) };
    return null;
  }
  if (e.type === 'network') {
    if (e.action === 'create') return { time, kind: 'create', text: t("Network {name} created", { name }) };
    if (e.action === 'destroy') return { time, kind: 'remove', text: t("Network {name} removed", { name }) };
    return null;
  }
  if (e.type === 'volume') {
    if (e.action === 'create') return { time, kind: 'create', text: t("Volume {name} created", { name }) };
    if (e.action === 'destroy') return { time, kind: 'remove', text: t("Volume {name} removed", { name }) };
    return null;
  }
  return null;
}

export function layerLabel(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('complete') && !s.includes('download')) return t("Done");
  if (s.includes('already exists')) return t("Done");
  if (s.includes('extract')) return t("Extracting");
  if (s.includes('download') || s.includes('verif')) return t("Downloading");
  return t("Waiting");
}

export const useApp = create<Store>()((set, get) => ({
  lang: getLang(),
  setLang: (l) => { applyLang(l); set({ lang: l }); },
  view: 'dashboard',
  engine: { state: 'connecting' },
  contexts: [],
  ctxMenu: false,
  containers: [], images: [], networks: [], volumes: [], projects: [], df: null, loaded: false,
  stats: {}, events: [],
  cq: '', onlyRunning: false, selected: null, tab: 'logs',
  terms: {}, busy: {}, projectLine: {}, backingUp: {},
  openTerm: (id) => set((s) => (s.terms[id] ? {} : { terms: { ...s.terms, [id]: true } })),
  closeTerm: (id) => set((s) => { if (!s.terms[id]) return {}; const t = { ...s.terms }; delete t[id]; return { terms: t }; }),
  prune: { ...DEFAULT_PRUNE_SEL }, pruneOpen: {}, pruneState: 'idle', prunedBytes: 0,
  schedule: null, pull: null, build: null,
  modal: null, toasts: [],

  setView: (v) => set({ view: v, ctxMenu: false }),

  toast: (msg, kind = 'ok') => {
    const id = String(++toastSeq);
    set((s) => ({ toasts: [...s.toasts, { id, msg, kind }].slice(-4) }));
    setTimeout(() => get().dismissToast(id), 3600);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  ev: (kind, text) => {
    const ctx = get().engine.ctx?.id ?? 'default';
    const events = [{ time: hhmm(), kind, text }, ...get().events].slice(0, EVENTS_CAP);
    set({ events });
    saveEvents(ctx, events);
  },

  openModal: (m) => set({ modal: m, ctxMenu: false }),
  closeModal: () => set({ modal: null }),
  ask: (cfg) => set({ modal: { kind: 'confirm', ...cfg }, ctxMenu: false }),

  // ---------- initialization ----------
  init: async () => {
    // Idempotent: React StrictMode (dev) runs effects twice, listeners must not be registered twice.
    if (inited) return;
    inited = true;
    await Promise.all([
      on<EngineStatus>('engine://status', (st) => {
        const cur = get().engine.state;
        const prevCtx = get().engine.ctx?.id;
        // While the user-triggered transition is in progress, only accept the final result.
        if (st.state === 'off' && (cur === 'starting' || cur === 'connecting')) return;
        if (st.state === 'on' && cur === 'stopping') return;
        set({ engine: { state: st.state, ctx: st.ctx, info: st.info, lost: st.state === 'off' && cur === 'on' } });
        if (st.state === 'on') {
          if (prevCtx !== st.ctx.id) set({ events: loadEvents(st.ctx.id) });
          void get().loadAll();
        }
      }),
      on<DockerEvent>('docker://events', (e) => {
        const d = describeEvent(e);
        if (d) {
          const ctx = get().engine.ctx?.id ?? 'default';
          const events = [d, ...get().events].slice(0, EVENTS_CAP);
          set({ events });
          saveEvents(ctx, events);
        }
        const t = e.type;
        if (t === 'container') {
          debounced('containers', 250, () => void get().refresh('containers'));
          debounced('networks-c', 800, () => void get().refresh('networks'));
        }
        if (t === 'image') debounced('images', 300, () => void get().refresh('images'));
        if (t === 'network') debounced('networks', 300, () => void get().refresh('networks'));
        if (t === 'volume') debounced('volumes', 300, () => void get().refresh('volumes'));
        if (['container', 'image', 'volume', 'builder'].includes(t)) debounced('df', 4000, () => void get().refresh('df'));
      }),
      on<{ image: string; id: string | null; status: string | null; current: number | null; total: number | null }>('pull://progress', (p) => {
        const cur = get().pull;
        if (!cur || cur.image !== p.image) return;
        const status = p.status ?? '';
        // "Pulling from <repo>" carries the tag as its id, not a layer; lines without an id are just notes.
        if (!p.id || /^pulling from/i.test(status)) {
          set({ pull: { ...cur, note: status } });
          return;
        }
        const complete = /pull complete|already exists/i.test(status);
        const pct = complete ? 100 : p.total ? Math.min(99, ((p.current ?? 0) / p.total) * 100) : /extract|verif|download complete/i.test(status) ? 99 : 0;
        const layers = cur.layers.slice();
        const ix = layers.findIndex((l) => l.id === p.id);
        const next = { id: p.id, status: layerLabel(status), pct: Math.max(ix >= 0 ? layers[ix].pct : 0, pct) };
        if (ix >= 0) layers[ix] = next;
        else layers.push(next);
        set({ pull: { ...cur, layers } });
      }),
      on<{ key: string; line: string }>('build://log', (p) => {
        const b = get().build;
        if (!b || p.key !== 'build') return;
        set({ build: { ...b, lines: [...b.lines, p.line].slice(-2000) } });
      }),
      on<{ key: string; line: string }>('compose://progress', (p) => {
        if (get().busy[`p:${p.key}`]) set((s) => ({ projectLine: { ...s.projectLine, [p.key]: p.line } }));
      }),
      on<{ auto?: boolean; total: number }>('prune://done', (r) => {
        if (r.auto) {
          get().toast(t("Automatic cleanup finished, freed {v0}", { v0: fmtBytes(r.total) }), 'info');
          get().ev('prune', t("Automatic prune freed {v0}", { v0: fmtBytes(r.total) }));
          void get().loadAll();
        }
      }),
    ]);
    const [st, ctxs] = await Promise.all([api.engineStatus(), api.ctxList()]);
    set({ engine: { state: st.state, ctx: st.ctx, info: st.info }, contexts: ctxs, events: loadEvents(st.ctx.id) });
    if (st.state === 'on') await get().loadAll();
    else set({ loaded: true });
    // Gently refresh the context list in the background (the CLI may add/remove contexts).
    void api.ctxList().then((c) => set({ contexts: c }));
  },

  loadAll: async () => {
    const r = get().refresh;
    await Promise.allSettled([r('containers'), r('images'), r('networks'), r('volumes'), r('projects'), api.scheduleGet().then((schedule) => set({ schedule }))]);
    set({ loaded: true });
    void r('df');
  },

  refresh: async (what) => {
    try {
      if (what === 'containers') {
        const containers = await api.containers();
        const sel = get().selected;
        set({ containers, selected: containers.some((c) => c.id === sel) ? sel : (containers[0]?.id ?? null) });
      } else if (what === 'images') set({ images: await api.images() });
      else if (what === 'networks') set({ networks: await api.networks() });
      else if (what === 'volumes') set({ volumes: await api.volumes() });
      else if (what === 'projects') set({ projects: await api.projects() });
      else set({ df: await api.df() });
    } catch (e) {
      // Engine stopped midway: keep the old data, the banner already reports it; show a toast for other errors.
      if (get().engine.state === 'on') get().toast((e as Error).message, 'err');
    }
  },

  // ---------- engine & context ----------
  engineOk: () => {
    if (get().engine.state === 'on') return true;
    get().toast(t("Docker Engine is not running. Start it first."), 'err');
    return false;
  },

  toggleEngine: async () => {
    const cur = get().engine;
    if (cur.state === 'on') {
      set({ engine: { ...cur, state: 'stopping' } });
      try {
        await api.engineStop();
        set({ engine: { ...cur, state: 'off' } });
        get().toast(t("Docker Engine has stopped"), 'info');
        get().ev('engine', t("Docker Engine stopped"));
      } catch (e) {
        set({ engine: cur });
        get().toast((e as Error).message, 'err');
      }
    } else if (cur.state === 'off') {
      set({ engine: { ...cur, state: 'starting' } });
      try {
        await api.engineStart();
        const st = await api.engineStatus();
        set({ engine: { state: st.state, ctx: st.ctx, info: st.info } });
        get().toast(t("Docker Engine is ready, containers with a restart policy were started again"));
        get().ev('engine', t("Docker Engine started"));
        await get().loadAll();
      } catch (e) {
        set({ engine: cur });
        get().toast((e as Error).message, 'err');
      }
    }
  },

  switchCtx: async (id) => {
    set({ ctxMenu: false });
    const cur = get().engine;
    if (id === cur.ctx?.id || cur.state === 'connecting') return;
    set({ engine: { ...cur, state: 'connecting' } });
    try {
      const ctx = await api.ctxSwitch(id);
      const st = await api.engineStatus();
      set({
        engine: { state: st.state, ctx: st.ctx, info: st.info },
        containers: [], images: [], networks: [], volumes: [], projects: [], df: null, stats: {},
        cq: '', onlyRunning: false, selected: null, tab: 'logs', pruneState: 'idle', prunedBytes: 0, pruneOpen: {},
        prune: { ...DEFAULT_PRUNE_SEL }, events: loadEvents(ctx.id), contexts: await api.ctxList(), loaded: false,
      });
      get().toast(t("Switched to context {name}", { name: ctx.name }));
      get().ev('engine', t("Switched context → {name}", { name: ctx.name }));
      if (st.state === 'on') await get().loadAll();
      else set({ loaded: true });
    } catch (e) {
      set({ engine: cur });
      get().toast((e as Error).message, 'err');
    }
  },

  // ---------- containers ----------
  startC: async (id) => {
    if (!get().engineOk() || get().busy[id]) return;
    const name = get().containers.find((c) => c.id === id)?.name ?? id;
    set((s) => ({ busy: { ...s.busy, [id]: 'starting' } }));
    try {
      await api.start(id);
      get().toast(t("{name} is now running", { name }));
    } catch (e) {
      get().toast((e as Error).message, 'err');
    } finally {
      set((s) => { const b = { ...s.busy }; delete b[id]; return { busy: b }; });
      void get().refresh('containers');
    }
  },
  stopC: async (id) => {
    if (!get().engineOk() || get().busy[id]) return;
    const name = get().containers.find((c) => c.id === id)?.name ?? id;
    set((s) => ({ busy: { ...s.busy, [id]: 'stopping' } }));
    try {
      await api.stop(id);
      get().toast(t("{name} has stopped", { name }), 'info');
    } catch (e) {
      get().toast((e as Error).message, 'err');
    } finally {
      set((s) => { const b = { ...s.busy }; delete b[id]; return { busy: b }; });
      void get().refresh('containers');
    }
  },
  restartC: async (id) => {
    if (!get().engineOk() || get().busy[id]) return;
    const name = get().containers.find((c) => c.id === id)?.name ?? id;
    set((s) => ({ busy: { ...s.busy, [id]: 'stopping' } }));
    // Goes through stopping → starting → running; the backend restart is a single command, so switch the label after a beat.
    const timer = setTimeout(() => set((s) => (s.busy[id] ? { busy: { ...s.busy, [id]: 'starting' } } : {})), 700);
    try {
      await api.restart(id);
      get().toast(t("{name} restarted", { name }));
    } catch (e) {
      get().toast((e as Error).message, 'err');
    } finally {
      clearTimeout(timer);
      set((s) => { const b = { ...s.busy }; delete b[id]; return { busy: b }; });
      void get().refresh('containers');
    }
  },
  removeC: (id) => {
    const c = get().containers.find((x) => x.id === id);
    if (!c) return;
    const run = c.state === 'running';
    get().ask({
      title: t("Delete container {name}?", { name: c.name }),
      body: run ? t("The container is running. It will be stopped and removed (docker rm -f).\\nVolumes are kept.") : t("The container will be removed. Volumes are kept."),
      yes: run ? t("Force delete") : t("Delete"), danger: true,
      action: async () => {
        if (!get().engineOk()) return;
        try {
          await api.remove(id, run);
          get().toast(t("Removed {name}", { name: c.name }));
          await get().refresh('containers');
        } catch (e) {
          get().toast((e as Error).message, 'err');
        }
      },
    });
  },
  setSelected: (id, tab) => set((s) => ({ selected: id, tab: tab ?? s.tab })),
  setCq: (q) => set({ cq: q }),
  setOnlyRunning: (v) => set({ onlyRunning: v }),
  setTab: (t) => set({ tab: t }),
  showProjectContainers: (name) => set({ view: 'containers', cq: name, onlyRunning: false }),

  // ---------- projects ----------
  composeRun: async (id, action) => {
    if (!get().engineOk()) return;
    const p = get().projects.find((x) => x.id === id);
    if (!p || get().busy[`p:${id}`]) return;
    const label = { up: 'docker compose up -d …', stop: 'docker compose stop …', restart: 'docker compose restart …', down: 'docker compose down …' }[action];
    set((s) => ({ busy: { ...s.busy, [`p:${id}`]: label }, projectLine: { ...s.projectLine, [id]: '' } }));
    try {
      await api.compose(id, action);
      const done = { up: t("all services are running"), stop: t("services stopped"), restart: t("restarted"), down: t("compose down done") }[action];
      get().toast(`${p.name}: ${done}`, action === 'stop' ? 'info' : 'ok');
      get().ev(action === 'up' ? 'start' : action === 'stop' ? 'stop' : action === 'restart' ? 'restart' : 'remove', `${p.name} compose ${action}`);
    } catch (e) {
      get().toast(`${p.name}: ${(e as Error).message}`, 'err');
    } finally {
      set((s) => { const b = { ...s.busy }; delete b[`p:${id}`]; return { busy: b }; });
      void Promise.all([get().refresh('containers'), get().refresh('networks')]);
    }
  },
  composeDown: (id) => {
    const p = get().projects.find((x) => x.id === id);
    if (!p) return;
    get().ask({
      title: `Compose down "${p.name}"?`,
      body: t("Stop and remove all containers of the project and the network {composeProject}_default.\\nVolumes are kept.", { composeProject: p.composeProject }),
      yes: 'Compose down', danger: true,
      action: () => get().composeRun(id, 'down'),
    });
  },
  forgetProject: (id) => {
    const p = get().projects.find((x) => x.id === id);
    if (!p) return;
    get().ask({
      title: t("Forget folder \"{name}\"?", { name: p.name }),
      body: t("Only removes it from the app's list. The folder and containers on this machine are not affected."),
      yes: t("Forget folder"), danger: true,
      action: async () => {
        await api.projectRemove(id);
        await get().refresh('projects');
        get().toast(t("Stopped remembering {name}", { name: p.name }), 'info');
      },
    });
  },

  // ---------- images ----------
  startPull: async (raw) => {
    if (!get().engineOk()) return;
    const image = withTag(raw);
    set({ pull: { image, layers: [], done: false } });
    try {
      await api.pull(image);
      const cur = get().pull;
      if (cur && cur.image === image) set({ pull: { ...cur, done: true, layers: cur.layers.map((l) => ({ ...l, pct: 100, status: t("Done") })) } });
      get().toast(t("Pulled {image}", { image }));
      void get().refresh('images');
    } catch (e) {
      const cur = get().pull;
      if (cur && cur.image === image) set({ pull: { ...cur, error: (e as Error).message } });
      get().toast((e as Error).message, 'err');
    }
  },
  resetPull: () => set({ pull: null }),

  startBuild: async (projectId, tag, nocache) => {
    if (!get().engineOk()) return;
    const full = withTag(tag);
    set({ build: { tag: full, lines: [], done: false } });
    try {
      await api.build(projectId, full, nocache);
      const cur = get().build;
      if (cur && cur.tag === full) set({ build: { ...cur, done: true } });
      get().toast(t("Built {full}", { full }));
      get().ev('build', `${full} build xong`);
      void Promise.all([get().refresh('images'), get().refresh('df')]);
    } catch (e) {
      const cur = get().build;
      if (cur && cur.tag === full) set({ build: { ...cur, error: (e as Error).message } });
      get().toast(t("Build failed: {message}", { message: (e as Error).message }), 'err');
    }
  },
  resetBuild: () => set({ build: null }),

  removeImage: (im) => {
    const users = get().containers.filter((c) => c.imageId === im.id);
    if (users.length) {
      get().toast(t("Image is in use by {name}", { name: users[0].name }), 'err');
      return;
    }
    get().ask({
      title: t("Delete image?"),
      body: `${imgRef(im)}\n${im.id.replace(/^sha256:/, '').slice(0, 12)} · ${fmtBytes(im.size)}`,
      yes: t("Delete image"), danger: true,
      action: async () => {
        if (!get().engineOk()) return;
        try {
          // The image still has other tags: only untag this one, do not delete shared layers.
          const sameId = get().images.filter((x) => x.id === im.id).length;
          await api.imageRemove(im.dangling || sameId <= 1 ? im.id : imgRef(im));
          get().toast(t("Removed image, freed {v0}", { v0: fmtBytes(im.size) }));
          await get().refresh('images');
        } catch (e) {
          get().toast((e as Error).message, 'err');
        }
      },
    });
  },

  // ---------- networks / volumes ----------
  removeNetwork: (n) => {
    get().ask({
      title: t("Delete network {name}?", { name: n.name }), body: t("No container is connected to this network."), yes: t("Delete network"), danger: true,
      action: async () => {
        try {
          await api.networkRemove(n.id);
          get().toast(t("Removed network {name}", { name: n.name }));
          await get().refresh('networks');
        } catch (e) {
          get().toast((e as Error).message, 'err');
        }
      },
    });
  },
  removeVolume: (name, size) => {
    get().ask({
      title: t("Delete volume {name}?", { name }),
      body: t("All data{v0} will be lost permanently. Back up first.", { v0: size && size > 0 ? ` (${fmtBytes(size)})` : '' }),
      yes: t("Delete volume"), danger: true,
      action: async () => {
        try {
          await api.volumeRemove(name);
          get().toast(t("Removed volume {name}", { name }));
          await Promise.all([get().refresh('volumes'), get().refresh('df')]);
        } catch (e) {
          get().toast((e as Error).message, 'err');
        }
      },
    });
  },
  backupVolume: async (name) => {
    if (get().backingUp[name] || !get().engineOk()) return;
    const using = get().containers.filter((c) => c.state === 'running' && c.mounts.some((m) => m.name === name));
    if (using.length) get().toast(t("Stop {name} first for consistent data", { name: using[0].name }), 'info');
    set((s) => ({ backingUp: { ...s.backingUp, [name]: true } }));
    try {
      const file = await api.volumeBackup(name);
      get().toast(t("Backed up → {v0}", { v0: file.replace(/^.*[\\/]docker-backups[\\/]/, '~/docker-backups/') }));
      get().ev('create', `Backup volume ${name}`);
    } catch (e) {
      get().toast((e as Error).message, 'err');
    } finally {
      set((s) => { const b = { ...s.backingUp }; delete b[name]; return { backingUp: b }; });
    }
  },

  // ---------- cleanup ----------
  togglePrune: (id) => set((s) => ({ prune: { ...s.prune, [id]: !s.prune[id] }, pruneState: s.pruneState === 'done' ? 'idle' : s.pruneState })),
  togglePruneOpen: (id) => set((s) => ({ pruneOpen: { ...s.pruneOpen, [id]: !s.pruneOpen[id] } })),
  askPrune: () => {
    const s = get();
    const defs = computePruneDefs(s);
    if (!defs.some((d) => s.prune[d.id] && d.items.length)) {
      s.toast(t("Nothing to clean in the selected items"), 'info');
      return;
    }
    if (!s.engineOk()) return;
    set({ modal: { kind: 'pruneConfirm' } });
  },
  doPrune: async () => {
    const s = get();
    const sel = s.prune;
    set({ modal: null, pruneState: 'running' });
    try {
      const r = await api.prune({ ...sel });
      set({ pruneState: 'done', prunedBytes: r.total, pruneOpen: {} });
      get().toast(r.errors.length ? t("Cleanup partly done: {v0}", { v0: r.errors[0] }) : t("Cleanup done, freed {v0}", { v0: fmtBytes(r.total) }), r.errors.length ? 'err' : 'ok');
      get().ev('prune', t("Prune freed {v0}", { v0: fmtBytes(r.total) }));
      await get().loadAll();
    } catch (e) {
      set({ pruneState: 'idle' });
      get().toast((e as Error).message, 'err');
    }
  },
}));

// ---------- handy selectors ----------
export function usePruneDefs() {
  const containers = useApp((s) => s.containers);
  const images = useApp((s) => s.images);
  const networks = useApp((s) => s.networks);
  const volumes = useApp((s) => s.volumes);
  const df = useApp((s) => s.df);
  return computePruneDefs({ containers, images, networks, volumes, df });
}

export { selectedTotal };
