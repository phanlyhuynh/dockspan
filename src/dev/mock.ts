/**
 * Fake backend ONLY for developing the UI in a browser: run `pnpm dev` then open `/?mock`.
 * Builds enough of `window.__TAURI_INTERNALS__` for api.ts to run, with sample data taken from the prototype.
 * Not part of the production build (main.tsx only loads it when import.meta.env.DEV).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const w = window as Any;
const cbs = new Map<number, (e: Any) => void>();
const listeners = new Map<string, number[]>();
let cbSeq = 1;
const now = Math.floor(Date.now() / 1000);
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emit(event: string, payload: Any) {
  for (const id of listeners.get(event) ?? []) cbs.get(id)?.({ event, id, payload });
}

const svc = (name: string, image: string, ports: string[]) => ({ name, image, ports });
const projects: Any[] = [
  { id: 'p1', name: 'myshop', path: '/Users/dev/code/myshop', composeProject: 'myshop', contextId: 'default', composeFile: 'docker-compose.yml', hasDockerfile: true, services: [svc('api', 'myshop-api:latest', ['3000→3000']), svc('web', 'myshop-web:dev', ['5173→5173']), svc('db', 'postgres:16-alpine', ['5432→5432']), svc('redis', 'redis:7-alpine', ['6379→6379'])], lastOpenedAt: new Date().toISOString(), createdAt: '' },
  { id: 'p2', name: 'blog', path: '/Users/dev/sites/blog-wordpress', composeProject: 'blog', contextId: 'default', composeFile: 'compose.yaml', hasDockerfile: false, services: [svc('wordpress', 'wordpress:6.6', ['8080→80']), svc('mysql', 'mysql:8.4', ['3306'])], lastOpenedAt: new Date(Date.now() - 86400000).toISOString(), createdAt: '' },
  { id: 'p3', name: 'landing-page', path: '/Users/dev/code/landing-page', composeProject: 'landing-page', contextId: 'default', composeFile: null, hasDockerfile: true, services: [], lastOpenedAt: new Date(Date.now() - 3 * 86400000).toISOString(), createdAt: '' },
];
const imageIdOf = (image: string) => imgs.find((i) => `${i.repo}:${i.tag}` === image)?.id ?? 'sha256:' + hex(64);
const ctr = (name: string, image: string, project: string | null, service: string | null, ports: [number, number][], state: string, nets: string[], vols: string[]) => ({
  id: hex(64), name, image, imageId: imageIdOf(image), state, status: state === 'running' ? 'Up 2 hours' : 'Exited (0) 3 hours ago', health: null, created: now - 7200,
  project, service, workingDir: null, ports: ports.map(([pub, priv]) => ({ ip: '0.0.0.0', privatePort: priv, publicPort: pub, type: 'tcp' })), networks: nets,
  mounts: vols.map((v) => ({ type: 'volume', name: v, source: '', destination: '/data' })),
});
const imgs: Any[] = [];
const I = (repo: string, tag: string, mb: number, ago: number, dangling = false) => imgs.push({ id: 'sha256:' + hex(64), repo, tag, size: mb * 1e6, created: now - ago, dangling });
I('myshop-api', 'latest', 312, 7200); I('myshop-web', 'dev', 541, 7200); I('postgres', '16-alpine', 243, 86400); I('redis', '7-alpine', 41, 14 * 86400);
I('wordpress', '6.6', 702, 30 * 86400); I('mysql', '8.4', 598, 30 * 86400); I('nginx', 'alpine', 48, 21 * 86400); I('<none>', '<none>', 890, 3 * 86400, true); I('<none>', '<none>', 676, 5 * 86400, true);
const cs: Any[] = [
  ctr('myshop-api-1', 'myshop-api:latest', 'myshop', 'api', [[3000, 3000]], 'running', ['myshop_default'], []),
  ctr('myshop-web-1', 'myshop-web:dev', 'myshop', 'web', [[5173, 5173]], 'running', ['myshop_default'], []),
  ctr('myshop-db-1', 'postgres:16-alpine', 'myshop', 'db', [[5432, 5432]], 'running', ['myshop_default'], ['myshop_pgdata']),
  ctr('myshop-redis-1', 'redis:7-alpine', 'myshop', 'redis', [[6379, 6379]], 'running', ['myshop_default'], ['myshop_redis']),
  ctr('blog-wordpress-1', 'wordpress:6.6', 'blog', 'wordpress', [[8080, 80]], 'running', ['blog_default'], ['blog_wp-content']),
  ctr('blog-mysql-1', 'mysql:8.4', 'blog', 'mysql', [], 'exited', ['blog_default'], ['blog_db']),
];
const nets: Any[] = ['bridge', 'host', 'none'].map((n) => ({ id: hex(12), name: n, driver: n === 'none' ? 'null' : n, scope: 'local', subnet: n === 'bridge' ? '172.17.0.0/16' : '—', gateway: '—', system: true }));
['myshop_default:172.20.0.0/16', 'blog_default:172.21.0.0/16', 'old-project_net:172.23.0.0/16'].forEach((x) => { const [name, subnet] = x.split(':'); nets.push({ id: hex(12), name, driver: 'bridge', scope: 'local', subnet, gateway: subnet.replace('0.0/16', '0.1'), system: false }); });
const vols: Any[] = [['myshop_pgdata', 820], ['myshop_redis', 24], ['blog_db', 410], ['blog_wp-content', 260], ['a71c0f2be93b', 112], ['old-project_uploads', 340]].map(([name, mb]) => ({ name, driver: 'local', mountpoint: `/var/lib/docker/volumes/${name}/_data`, createdAt: '', mb }));
let schedule: Any = { contextId: 'default', enabled: false, freq: 'weekly', keepCacheDays: 7, containers: true, danglingImages: true, buildCache: true };

function df() {
  return {
    imagesSize: imgs.reduce((a, i) => a + i.size, 0) * 0.8, volumesSize: vols.reduce((a, v) => a + v.mb * 1e6, 0), cacheSize: 3.48e9, containersSize: 180e6,
    volumes: vols.map((v) => ({ name: v.name, size: v.mb * 1e6, refCount: cs.some((c) => c.mounts.some((m: Any) => m.name === v.name)) ? 1 : 0 })),
    cache: [{ id: hex(12), description: 'myshop-api build layers', size: 2.1e9, inUse: false, type: 'regular' }, { id: hex(12), description: 'myshop-web build layers', size: 1.1e9, inUse: false, type: 'regular' }, { id: hex(12), description: 'npm cache mounts', size: 0.28e9, inUse: false, type: 'exec.cachemount' }],
    containerSizes: Object.fromEntries(cs.map((c) => [c.id, 30e6])),
  };
}

const find = (id: string) => cs.find((c) => c.id === id || c.name === id);
function ev(type: string, action: string, c: Any) { emit('docker://events', { type, action, id: c.id, name: c.name, image: c.image, exitCode: null, attrs: {}, time: Math.floor(Date.now() / 1000) }); }

const LOGS: [string, string][] = [['stdout', 'Server listening on http://0.0.0.0:3000'], ['stdout', 'Connected to postgres://db:5432/myshop'], ['stdout', 'DEBUG Redis client ready (redis:6379)'], ['stdout', 'GET /api/products 200 18ms'], ['stdout', 'GET /api/cart 200 7ms'], ['stdout', 'WARN Slow query: SELECT * FROM orders … 812ms'], ['stderr', 'ERROR POST /api/checkout 500 — payment gateway timeout'], ['stdout', 'GET /health 200 1ms']];

const handlers: Record<string, (a: Any) => Any> = {
  engine_status: () => ({ state: 'on', ctx: { id: 'default', name: 'desktop-linux', endpoint: 'unix:///var/run/docker.sock', kind: 'local' }, info: { version: '27.3.1', apiVersion: '1.47', os: 'Docker Desktop aarch64', osType: 'linux', kernel: '6.8', cpus: 8, memTotal: 16 * 2 ** 30, name: 'docker-desktop' } }),
  ctx_list: () => [
    { id: 'default', name: 'desktop-linux', kind: 'local', endpoint: 'unix:///var/run/docker.sock', supported: true, active: true },
    { id: 'colima', name: 'colima', kind: 'local', endpoint: 'unix:///Users/dev/.colima/default/docker.sock', supported: true, active: false },
    { id: 'prod', name: 'prod-server', kind: 'ssh', endpoint: 'ssh://deploy@203.0.113.10', supported: false, active: false },
  ],
  ctx_test: () => ({ version: '27.3.1', apiVersion: '1.47', os: 'Docker Desktop aarch64', cpus: 8, memTotal: 16 * 2 ** 30, latencyMs: 12 }),
  containers_list: () => cs.map((c) => ({ ...c })), containers_stats: (a) => Object.fromEntries(a.ids.map((id: string) => [id, { cpu: 0.2 + (id.charCodeAt(0) % 25) / 10, memUsed: (12 + (id.charCodeAt(1) % 300)) * 2 ** 20, memLimit: 2 ** 30 }])),
  images_list: () => imgs.map((i) => ({ ...i })), networks_list: () => nets.map((n) => ({ ...n })), volumes_list: () => vols.map(({ mb: _mb, ...v }) => v), project_list: () => projects.map((p) => ({ ...p })), schedule_get: () => schedule,
  schedule_set: (a) => { schedule = a.schedule; return schedule; }, system_df: () => df(),
  container_start: (a) => { const c = find(a.id); if (c) { c.state = 'running'; c.status = 'Up 1 second'; ev('container', 'start', c); } },
  container_stop: (a) => { const c = find(a.id); if (c) { c.state = 'exited'; ev('container', 'stop', c); } },
  container_restart: (a) => { const c = find(a.id); if (c) { c.state = 'running'; ev('container', 'restart', c); } },
  container_remove: (a) => { const i = cs.findIndex((c) => c.id === a.id); if (i >= 0) { const [c] = cs.splice(i, 1); ev('container', 'destroy', c); } },
  container_create: (a) => { const c = ctr(a.spec.name, a.spec.image, null, null, [], a.spec.start ? 'running' : 'created', ['bridge'], []); cs.push(c); ev('container', 'create', c); return { id: c.id }; },
  container_inspect: (a) => { const c = find(a.id); return { Id: c?.id, Created: new Date().toISOString(), Platform: 'linux', Config: { Image: c?.image, Labels: { 'com.docker.compose.project': c?.project } }, State: { Status: c?.state }, HostConfig: { RestartPolicy: { Name: 'unless-stopped' } }, NetworkSettings: { Ports: { '3000/tcp': [{ HostPort: '3000' }] }, Networks: { myshop_default: {} } }, Mounts: [] }; },
  logs_subscribe: (a) => {
    const base = LOGS.map(([stream, text], i) => ({ ts: new Date(Date.now() - (LOGS.length - i) * 4000).toISOString(), stream, text }));
    setTimeout(() => emit(`logs://${a.id}`, base), 30);
    const t = setInterval(() => emit(`logs://${a.id}`, [{ ts: new Date().toISOString(), stream: 'stdout', text: `GET /api/products 200 ${Math.floor(Math.random() * 40)}ms` }]), 2200);
    (w.__mockTimers ??= {})[`l${a.id}`] = t;
  },
  logs_unsubscribe: (a) => clearInterval((w.__mockTimers ?? {})[`l${a.id}`]),
  stats_subscribe: (a) => {
    let n = 0;
    const t = setInterval(() => { n++; emit(`stats://${a.id}`, { cpu: 2 + Math.random() * 20, memUsed: (180 + n) * 2 ** 20, memLimit: 2 ** 30, netRx: n * 52_000, netTx: n * 31_000, blkRead: n * 4096, blkWrite: n * 2048, ts: Date.now() }); }, 700);
    (w.__mockTimers ??= {})[`s${a.id}`] = t;
  },
  stats_unsubscribe: (a) => clearInterval((w.__mockTimers ?? {})[`s${a.id}`]),
  exec_open: (a) => { setTimeout(() => emit(`exec://${a.sid}`, { t: 'data', d: btoa('/app # ') }), 80); return { sid: a.sid, shell: '/bin/sh' }; },
  exec_write: () => undefined, exec_resize: () => undefined, exec_close: () => undefined,
  image_history: () => ({ os: 'linux', architecture: 'arm64', layers: [{ cmd: 'CMD ["node","dist/server.js"]', size: 0 }, { cmd: 'COPY . /app', size: 92e6 }, { cmd: 'RUN npm ci', size: 140e6 }, { cmd: 'ADD alpine-minirootfs-3.20.tar.gz /', size: 8e6 }] }),
  image_pull: async (a) => {
    const ids = [hex(12), hex(12), hex(12)];
    for (let p = 0; p <= 100; p += 20) { for (const id of ids) emit('pull://progress', { image: a.image, id, status: p >= 100 ? 'Pull complete' : 'Downloading', current: p, total: 100 }); await sleep(180); }
    const [repo, tag] = a.image.split(':'); I(repo, tag, 60, 1);
  },
  image_remove: (a) => { const i = imgs.findIndex((x) => x.id === a.id || `${x.repo}:${x.tag}` === a.id); if (i >= 0) imgs.splice(i, 1); },
  image_build: async (a) => { for (const l of ['$ docker build -t ' + a.tag, ' => [1/6] FROM docker.io/library/node:22-alpine', ' => CACHED [2/6] WORKDIR /app', ' => [6/6] RUN npm run build', ' => naming to ' + a.tag]) { emit('build://log', { key: 'build', line: l }); await sleep(250); } },
  network_inspect: (a) => { const n = nets.find((x) => x.id === a.id); return { ...n, containers: cs.filter((c) => c.networks.includes(n.name) && c.state === 'running').map((c) => ({ id: c.id, name: c.name, ip: '172.20.0.' + (2 + (c.name.length % 8)) + '/16' })) }; },
  network_create: (a) => { nets.push({ id: hex(12), name: a.spec.name, driver: a.spec.driver, scope: 'local', subnet: a.spec.subnet || '172.30.0.0/16', gateway: '—', system: false }); return 'x'; },
  network_remove: (a) => { const i = nets.findIndex((n) => n.id === a.id); if (i >= 0) nets.splice(i, 1); },
  volume_create: (a) => { vols.push({ name: a.name, driver: 'local', mountpoint: '/var/lib/docker/volumes/' + a.name, createdAt: '', mb: 0 }); },
  volume_remove: (a) => { const i = vols.findIndex((v) => v.name === a.name); if (i >= 0) vols.splice(i, 1); },
  volume_ls_files: (a) => (a.path ? [{ name: 'b.txt', isDir: false, size: 2048, mtime: now }] : [{ name: 'base', isDir: true, size: 4096, mtime: now }, { name: 'PG_VERSION', isDir: false, size: 3, mtime: now - 7200 }, { name: 'postgresql.conf', isDir: false, size: 29000, mtime: now - 7200 }]),
  volume_backup: () => '/Users/dev/docker-backups/x.tar.gz', backups_list: () => [{ name: 'myshop_pgdata-20261012.tar.gz', size: 120e6 }],
  prune_run: async () => { for (let i = imgs.length - 1; i >= 0; i--) if (imgs[i].dangling) imgs.splice(i, 1); await sleep(600); return { reclaimed: {}, total: 1.6e9, errors: [] }; },
  discover_projects: () => [{ path: '/Users/dev/code/inventory-service', name: 'inventory-service', tag: 'compose' }, { path: '/Users/dev/code/landing-page', name: 'landing-page', tag: 'Dockerfile' }, { path: '/Users/dev/code/myshop', name: 'myshop', tag: 'compose' }],
  project_scan: (a) => ({ path: a.path, suggestedName: a.path.split('/').pop(), composeFile: 'compose.yaml', hasDockerfile: true, composeProject: 'inventory-service', services: [svc('api', 'inventory-api:latest', ['4000→4000']), svc('worker', 'inventory-api:latest', []), svc('rabbitmq', 'rabbitmq:3-management', ['15672→15672'])], warning: null }),
  project_add: (a) => { const p = { ...projects[0], id: hex(6), name: a.spec.name, path: a.spec.path, composeProject: a.spec.name }; projects.push(p); return p; },
  project_rename: (a) => { const p = projects.find((x) => x.id === a.id); if (p) p.name = a.name; return p; },
  project_remove: (a) => { const i = projects.findIndex((p) => p.id === a.id); if (i >= 0) projects.splice(i, 1); },
  project_refresh: (a) => projects.find((p) => p.id === a.id),
  compose_run: async (a) => {
    const p = projects.find((x) => x.id === a.id);
    for (const l of ['Container myshop-db-1  Running', 'Container myshop-api-1  Started']) { emit('compose://progress', { key: a.id, line: l }); await sleep(350); }
    cs.filter((c) => c.project === p.composeProject).forEach((c) => { c.state = a.action === 'stop' ? 'exited' : 'running'; ev('container', a.action === 'stop' ? 'stop' : 'start', c); });
  },
  project_files: () => [{ name: 'docker-compose.yml', isDir: false }, { name: 'Dockerfile', isDir: false }, { name: '.env', isDir: false }, { name: '.dockerignore', isDir: false }, { name: 'README.md', isDir: false }, { name: 'src/', isDir: true }],
  project_read_file: (a) => (a.name === '.env' ? 'NODE_ENV=development\nDATABASE_URL=postgres://app:s3cret@db:5432/myshop\nJWT_SECRET=abc123\nREDIS_URL=redis://redis:6379' : a.name === 'Dockerfile' ? 'FROM node:22-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nCMD ["node", "dist/server.js"]' : 'services:\n  api:\n    image: myshop-api:latest\n    ports:\n      - "3000:3000"\n    restart: unless-stopped\n  db:\n    image: postgres:16-alpine\n'),
  project_write_file: () => undefined, open_editor: () => undefined, open_in_editor: () => undefined, open_terminal: () => undefined, open_folder: () => undefined, open_url: () => undefined,
  settings_get: () => ({ editorCommand: 'code' }), settings_set: () => undefined,
  home_dir: () => '/Users/dev',
};

w.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' }, windows: [], webviews: [] },
  transformCallback: (fn: (e: Any) => void) => { const id = cbSeq++; cbs.set(id, fn); return id; },
  unregisterCallback: (id: number) => cbs.delete(id),
  convertFileSrc: (p: string) => p,
  invoke: async (cmd: string, args: Any = {}) => {
    if (cmd === 'plugin:event|listen') { const l = listeners.get(args.event) ?? []; l.push(args.handler); listeners.set(args.event, l); return args.handler; }
    if (cmd.startsWith('plugin:event|')) return;
    if (cmd.startsWith('plugin:path|')) return '/Users/dev';
    if (cmd.startsWith('plugin:')) return null;
    const h = handlers[cmd];
    if (!h) { console.warn('[mock] command not implemented:', cmd); return undefined; }
    await sleep(15);
    return h(args);
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (event: string, id: number) => { listeners.set(event, (listeners.get(event) ?? []).filter((x) => x !== id)); } };
w.__mockEmit = emit;
console.info('[mock] fake backend enabled');
export {};
