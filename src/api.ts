import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { tBackend } from './i18n';

// ---------- data types (matching the Rust backend) ----------

export type CState = 'running' | 'exited' | 'created' | 'paused' | 'restarting' | 'dead' | 'removing';

export interface PortMap { ip?: string | null; privatePort: number; publicPort?: number | null; type: string }
export interface Mount { type: string; name: string | null; source: string; destination: string }

export interface Container {
  id: string; name: string; image: string; imageId: string;
  state: CState; status: string; health: 'healthy' | 'unhealthy' | 'starting' | null;
  created: number; project: string | null; service: string | null; workingDir: string | null;
  ports: PortMap[]; networks: string[]; mounts: Mount[];
}

export interface ImageRow { id: string; repo: string; tag: string; size: number; created: number; dangling: boolean }
export interface NetworkRow { id: string; name: string; driver: string; scope: string; subnet: string; gateway: string; system: boolean }
export interface VolumeRow { name: string; driver: string; mountpoint: string; createdAt: string }

export interface DfInfo {
  imagesSize: number; volumesSize: number; cacheSize: number; containersSize: number;
  volumes: { name: string; size: number; refCount: number }[];
  cache: { id: string; description: string; size: number; inUse: boolean; type: string }[];
  containerSizes: Record<string, number>;
}

export interface ServiceInfo { name: string; image: string; ports: string[] }
export interface Project {
  id: string; name: string; path: string; composeProject: string; contextId: string;
  composeFile: string | null; hasDockerfile: boolean; services: ServiceInfo[];
  lastOpenedAt: string; createdAt: string;
}
export interface ScanResult {
  path: string; suggestedName: string; composeFile: string | null; hasDockerfile: boolean;
  composeProject: string; services: ServiceInfo[]; warning: string | null;
}

export interface CtxInfo { id: string; name: string; kind: 'local' | 'ssh' | 'tcp'; endpoint: string; supported: boolean; active: boolean }
export interface EngineInfo { version: string; apiVersion: string; os: string; osType: string; kernel: string; cpus: number; memTotal: number; name: string; latencyMs?: number }
export interface EngineStatus { state: 'on' | 'off'; ctx: { id: string; name: string; endpoint: string; kind: string }; info?: EngineInfo }

export interface RawLog { ts: string; stream: string; text: string }
export interface StatSample { cpu: number; memUsed: number; memLimit: number; netRx: number; netTx: number; blkRead: number; blkWrite: number; ts: number }

export interface DockerEvent { type: string; action: string; id: string | null; name: string | null; image: string | null; exitCode: string | null; attrs: Record<string, string>; time: number }

export interface Schedule {
  contextId: string; enabled: boolean; freq: 'daily' | 'weekly' | 'monthly'; keepCacheDays: 1 | 7 | 30;
  containers: boolean; danglingImages: boolean; buildCache: boolean; lastRunAt?: string | null; lastReclaimedBytes?: number | null;
}

export interface PruneSel { containers: boolean; images: boolean; networks: boolean; cache: boolean; volumes: boolean; keepCacheDays?: number }
export interface PruneResult { reclaimed: Record<string, number>; total: number; errors: string[] }

export interface CreateSpec { image: string; name?: string; ports: string[]; env: string[]; binds: string[]; restart: string; start: boolean }

export interface VolFile { name: string; isDir: boolean; size: number; mtime: number }
export interface NetDetail { id: string; name: string; driver: string; scope: string; subnet: string; gateway: string; containers: { id: string; name: string; ip: string }[] }
export interface ImageDetail { layers: { cmd: string; size: number }[]; os: string; architecture: string }

// ---------- Kubernetes ----------

export interface Cluster {
  id: string; name: string; kubeconfigPath: string; kubeContext: string; server: string;
  namespace: string | null; user: string | null; source: 'default' | 'file';
}
export interface ClusterCheck { version: string; nodes: number | null; latencyMs: number; server: string; namespace: string }
export interface KubeCtxOption { name: string; server: string; namespace: string | null; added: boolean }
export interface K8sDeployment {
  namespace: string; name: string; replicas: number; ready: number; updated: number; available: number;
  image: string; selector: Record<string, string>; created: number;
}
export interface K8sPod {
  namespace: string; name: string; status: string; phase: string; ready: string; restarts: number; created: number; node: string;
  containers: string[]; labels: Record<string, string>; owner: { kind: string; name: string } | null;
  waitingReason: string | null; waitingMessage: string | null; lastTerminatedReason: string | null; lastExitCode: number | null; deleting: boolean;
}
export interface K8sSvcPort { name: string | null; port: number; targetPort: string | null; nodePort: number | null; protocol: string }
export interface K8sService { namespace: string; name: string; type: string; clusterIp: string; ports: K8sSvcPort[]; selector: Record<string, string>; created: number }
export interface PortFwd { id: string; clusterId: string; clusterName: string; namespace: string; service: string; remotePort: number; localPort: number }
export type K8sKind = 'deployments' | 'pods' | 'services';

// ---------- backend calls ----------

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    // Backend error messages are fixed English text; translate them into the selected language when possible.
    throw new Error(tBackend(typeof e === 'string' ? e : (e as Error)?.message ?? String(e)));
  }
}

export const api = {
  engineStatus: () => call<EngineStatus>('engine_status'),
  engineStart: () => call<void>('engine_start'),
  engineStop: () => call<void>('engine_stop'),

  ctxList: () => call<CtxInfo[]>('ctx_list'),
  ctxTest: (id: string) => call<EngineInfo>('ctx_test', { id }),
  ctxSwitch: (id: string) => call<EngineStatus['ctx']>('ctx_switch', { id }),

  containers: () => call<Container[]>('containers_list'),
  containersStats: (ids: string[]) => call<Record<string, { cpu: number; memUsed: number; memLimit: number }>>('containers_stats', { ids }),
  start: (id: string) => call<void>('container_start', { id }),
  stop: (id: string) => call<void>('container_stop', { id }),
  restart: (id: string) => call<void>('container_restart', { id }),
  remove: (id: string, force: boolean) => call<void>('container_remove', { id, force }),
  create: (spec: CreateSpec) => call<{ id: string }>('container_create', { spec }),
  inspect: (id: string) => call<Record<string, unknown>>('container_inspect', { id }),
  logsSubscribe: (id: string, tail = 500, since?: number) => call<void>('logs_subscribe', { id, tail, since }),
  logsUnsubscribe: (id: string) => call<void>('logs_unsubscribe', { id }),
  statsSubscribe: (id: string) => call<void>('stats_subscribe', { id }),
  statsUnsubscribe: (id: string) => call<void>('stats_unsubscribe', { id }),
  execOpen: (sid: string, container: string, shell: string, cols: number, rows: number) => call<{ sid: string; shell: string }>('exec_open', { sid, container, shell, cols, rows }),
  execWrite: (sid: string, data: string) => call<void>('exec_write', { sid, data }),
  execResize: (sid: string, cols: number, rows: number) => call<void>('exec_resize', { sid, cols, rows }),
  execClose: (sid: string) => call<void>('exec_close', { sid }),

  images: () => call<ImageRow[]>('images_list'),
  pull: (image: string) => call<void>('image_pull', { image }),
  imageDetail: (id: string) => call<ImageDetail>('image_history', { id }),
  imageRemove: (id: string, force = false) => call<void>('image_remove', { id, force }),
  build: (projectId: string, tag: string, nocache: boolean) => call<void>('image_build', { projectId, tag, nocache }),

  networks: () => call<NetworkRow[]>('networks_list'),
  networkInspect: (id: string) => call<NetDetail>('network_inspect', { id }),
  networkCreate: (name: string, driver: string, subnet?: string) => call<string>('network_create', { spec: { name, driver, subnet } }),
  networkRemove: (id: string) => call<void>('network_remove', { id }),
  networkConnect: (network: string, container: string) => call<void>('network_connect', { network, container }),
  networkDisconnect: (network: string, container: string) => call<void>('network_disconnect', { network, container }),

  volumes: () => call<VolumeRow[]>('volumes_list'),
  volumeCreate: (name: string) => call<void>('volume_create', { name }),
  volumeRemove: (name: string) => call<void>('volume_remove', { name }),
  volumeFiles: (name: string, path?: string) => call<VolFile[]>('volume_ls_files', { name, path }),
  volumeDownload: (name: string, path: string, dest: string) => call<void>('volume_download_file', { name, path, dest }),
  volumeBackup: (name: string) => call<string>('volume_backup', { name }),
  volumeRestore: (name: string, file: string) => call<void>('volume_restore', { name, file }),
  backups: () => call<{ name: string; size: number }[]>('backups_list'),

  df: () => call<DfInfo>('system_df'),
  prune: (selection: PruneSel) => call<PruneResult>('prune_run', { selection }),
  scheduleGet: () => call<Schedule>('schedule_get'),
  scheduleSet: (schedule: Schedule) => call<Schedule>('schedule_set', { schedule }),

  projects: () => call<Project[]>('project_list'),
  scan: (path: string) => call<ScanResult>('project_scan', { path }).then((r) => ({ ...r, warning: r.warning ? tBackend(r.warning) : null })),
  discover: () => call<{ path: string; name: string; tag: string }[]>('discover_projects'),
  projectAdd: (name: string, path: string) => call<Project>('project_add', { spec: { name, path } }),
  projectRename: (id: string, name: string) => call<Project>('project_rename', { id, name }),
  projectRemove: (id: string) => call<void>('project_remove', { id }),
  projectRefresh: (id: string) => call<Project>('project_refresh', { id }),
  compose: (id: string, action: 'up' | 'stop' | 'restart' | 'down') => call<void>('compose_run', { id, action }),
  projectFiles: (id: string) => call<{ name: string; isDir: boolean }[]>('project_files', { id }),
  projectRead: (id: string, name: string) => call<string>('project_read_file', { id, name }).then(tBackend),
  projectWrite: (id: string, name: string, content: string) => call<void>('project_write_file', { id, name, content }),
  openEditor: (path: string) => call<void>('open_in_editor', { path }),
  openTerminal: (path: string) => call<void>('open_terminal', { path }),
  openFolder: (path: string) => call<void>('open_folder', { path }),
  openUrl: (url: string) => call<void>('open_url', { url }),
  saveText: (path: string, content: string) => call<void>('save_text', { path, content }),
  settingsGet: () => call<{ editorCommand: string }>('settings_get'),
  settingsSet: (editorCommand: string) => call<void>('settings_set', { editorCommand }),

  k8sClusters: () => call<{ clusters: Cluster[]; activeId: string | null }>('k8s_clusters'),
  k8sKubeconfigContexts: (path: string) => call<KubeCtxOption[]>('k8s_kubeconfig_contexts', { path }),
  k8sAdd: (path: string, context: string) => call<Cluster>('k8s_add', { path, context }),
  k8sRemove: (id: string) => call<void>('k8s_remove', { id }),
  k8sSelect: (id: string) => call<void>('k8s_select', { id }),
  k8sTest: (id: string, relogin = false) => call<ClusterCheck>('k8s_test', { id, relogin }),
  k8sProbe: (path: string, context: string) => call<ClusterCheck>('k8s_probe', { path, context }),
  k8sNamespaces: (id: string) => call<string[]>('k8s_namespaces', { id }),
  k8sList: <T,>(id: string, kind: K8sKind, ns: string | null) => call<T[]>('k8s_list', { id, kind, ns }),
  k8sScale: (id: string, ns: string, name: string, replicas: number) => call<void>('k8s_scale', { id, ns, name, replicas }),
  k8sRestart: (id: string, ns: string, name: string) => call<void>('k8s_restart', { id, ns, name }),
  k8sDeletePod: (id: string, ns: string, name: string) => call<void>('k8s_delete_pod', { id, ns, name }),
  k8sWatch: (id: string, ns: string | null) => call<void>('k8s_watch', { id, ns }),
  k8sUnwatch: () => call<void>('k8s_unwatch'),
  k8sLogs: (key: string, id: string, ns: string, pod: string, container: string | null, previous: boolean, follow: boolean, tail = 500) =>
    call<void>('k8s_logs', { key, id, ns, pod, container, previous, follow, tail }),
  k8sLogsStop: (key: string) => call<void>('k8s_logs_stop', { key }),
  k8sExec: (sid: string, id: string, ns: string, pod: string, container: string | null, shell: string, cols: number, rows: number) =>
    call<{ sid: string; shell: string }>('k8s_exec', { sid, id, ns, pod, container, shell, cols, rows }),
  k8sExecWrite: (sid: string, data: string) => call<void>('k8s_exec_write', { sid, data }),
  k8sExecResize: (sid: string, cols: number, rows: number) => call<void>('k8s_exec_resize', { sid, cols, rows }),
  k8sExecClose: (sid: string) => call<void>('k8s_exec_close', { sid }),
  k8sPfStart: (id: string, ns: string, service: string, port: number, localPort?: number) => call<PortFwd>('k8s_pf_start', { id, ns, service, port, localPort }),
  k8sPfStop: (pfId: string) => call<void>('k8s_pf_stop', { pfId }),
  k8sPfList: () => call<PortFwd[]>('k8s_pf_list'),
};

export function on<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => cb(e.payload));
}
