import { type ReactNode } from 'react';
import { useApp, usePruneDefs, type EngineState, type View } from '../store';
import { useK8s } from '../k8sStore';
import { useSsh } from '../sshStore';
import { fmtBytes } from '../lib/format';
import { sumBytes } from '../lib/prune';
import { ctxTypeLabel } from '../lib/connections';
import { Icon, ICONS } from './ui';
import { t } from '../i18n';

const TYPE_LABEL: Record<string, string> = { local: 'Local', wsl: 'WSL2', ssh: 'SSH', tcp: 'TCP' };

export const engineLabel = (s: EngineState): string =>
  ({ on: t("Engine running"), stopping: t("Shutting down…"), off: t("Engine stopped"), starting: t("Starting…"), connecting: t("Connecting…") })[s];
export const engineDot = (s: EngineState) => (s === 'on' ? 'dot run' : s === 'off' ? 'dot' : 'dot busy');

export function Sidebar() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const containers = useApp((s) => s.containers);
  const images = useApp((s) => s.images);
  const networks = useApp((s) => s.networks);
  const volumes = useApp((s) => s.volumes);
  const projects = useApp((s) => s.projects);
  const contexts = useApp((s) => s.contexts);
  const clusters = useK8s((s) => s.clusters.length);
  const sshOpen = useSsh((s) => s.sessions.filter((x) => !x.closed).length);
  const engine = useApp((s) => s.engine);
  const ctxMenu = useApp((s) => s.ctxMenu);
  const defs = usePruneDefs();
  const reclaim = defs.reduce((a, d) => a + sumBytes(d), 0);
  const running = containers.filter((c) => c.state === 'running').length;

  const nav: [Exclude<View, 'preferences'>, string, string][] = [
    ['dashboard', t("Overview"), ''],
    ['projects', t("Projects"), String(projects.length)],
    ['containers', 'Containers', `${running}/${containers.length}`],
    ['images', 'Images', String(images.length)],
    ['networks', 'Networks', String(networks.length)],
    ['volumes', 'Volumes', String(volumes.length)],
    ['kubernetes', 'Kubernetes', clusters ? String(clusters) : ''],
    ['ssh', 'SSH', sshOpen ? String(sshOpen) : ''],
    ['cleanup', t("Cleanup"), reclaim > 0 ? fmtBytes(reclaim) : ''],
    ['settings', t("Connections"), String(contexts.length)],
  ];

  const ctx = engine.ctx;
  return (
    <nav className="side" aria-label={t("Main navigation")} style={{ flex: '1 1 236px', maxWidth: '100%', minWidth: 0, background: '#14171D', borderRight: '1px solid #242935', padding: '20px 14px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px' }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#2F6FEB', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon d={ICONS.logo} size={20} stroke="#FFFFFF" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.01em' }}>Dockspan</span>
          <span style={{ fontSize: 12, color: '#8F98A8' }}>Docker Manager</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {nav.map(([id, label, count]) => (
          <button key={id} className={`navi${view === id ? ' on' : ''}`} onClick={() => setView(id)}>
            <Icon d={ICONS[id]} size={18} sw={1.8} />
            <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
            <span className="mono" style={{ fontSize: 11.5, color: '#8F98A8' }}>{count}</span>
          </button>
        ))}
      </div>
      <div style={{ marginTop: 'auto', position: 'relative' }}>
        {ctxMenu && <ContextMenu />}
        <div className="ctxbtn" style={{ cursor: 'default' }}>
          <button aria-label={t("Change Docker context")} onClick={() => useApp.setState({ ctxMenu: !ctxMenu })} style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
            <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
              <span style={{ fontSize: 12, color: '#8F98A8' }}>Context · {TYPE_LABEL[ctx?.kind ?? 'local'] ?? ctx?.kind}</span>
              <Icon d={ICONS.updown} size={14} stroke="#8F98A8" />
            </span>
            <span className="mono" style={{ fontSize: 13 }}>{ctx?.name ?? '—'}</span>
            <span className="mono ell" style={{ fontSize: 11.5, color: '#8F98A8', maxWidth: '100%' }}>{ctx?.endpoint ?? ''}</span>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, minWidth: 0 }}>
              <span className={engineDot(engine.state)} />
              <span className="ell">{engineLabel(engine.state)}</span>
            </span>
          </div>
        </div>
      </div>
    </nav>
  );
}

function ContextMenu() {
  const contexts = useApp((s) => s.contexts);
  const switchCtx = useApp((s) => s.switchCtx);
  const setView = useApp((s) => s.setView);
  const openModal = useApp((s) => s.openModal);
  return (
    <div className="menu" style={{ top: 'auto', bottom: 'calc(100% + 6px)', left: 0, right: 0, minWidth: 0 }}>
      <span className="muted" style={{ fontSize: 11, padding: '6px 10px 4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Docker context</span>
      {contexts.map((c) => (
        <button key={c.id} className="mi" style={{ minHeight: 46, opacity: c.supported ? 1 : 0.55 }} title={c.reason ?? undefined} onClick={() => (c.supported ? void switchCtx(c.id) : useApp.getState().toast(c.reason ?? '', 'info'))}>
          <span className={c.active ? 'dot run' : 'dot'} />
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <span className="ell">{c.name}</span>
            <span className="muted ell" style={{ fontSize: 11.5 }}>{ctxTypeLabel(c)} · {c.endpoint}</span>
          </span>
          {c.active && <Icon d={ICONS.check} size={15} stroke="#7FB0FF" sw={2.4} />}
        </button>
      ))}
      <div style={{ height: 1, background: '#2F3644', margin: '4px 0' }} />
      <button className="mi" onClick={() => openModal({ kind: 'ctxAdd' })}>{t("Add connection…")}</button>
      <button className="mi" onClick={() => setView('settings')}>{t("Manage connections")}</button>
    </div>
  );
}

export function Header() {
  const engine = useApp((s) => s.engine);
  const toggleEngine = useApp((s) => s.toggleEngine);
  const openModal = useApp((s) => s.openModal);
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const busy = engine.state === 'starting' || engine.state === 'stopping' || engine.state === 'connecting';
  // Only engines on this machine (a local socket or a WSL2 distro) can be started/stopped from the app.
  const remote = engine.ctx?.kind === 'ssh' || engine.ctx?.kind === 'tcp';
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
  return (
    <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '14px 28px', borderBottom: '1px solid #242935', background: '#11141A' }}>
      <button onClick={() => openModal({ kind: 'palette' })} aria-label={t("Open search command palette")} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 260px', maxWidth: 440, height: 40, padding: '0 12px', background: '#1A1E26', border: '1px solid #2A303C', borderRadius: 9, color: '#8F98A8', fontSize: 14, textAlign: 'left' }}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <span style={{ flex: 1 }}>{t("Search containers, images, projects, commands…")}</span>
        <span className="kbd">{isMac ? '⌘K' : 'Ctrl K'}</span>
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginLeft: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 12px', borderRadius: 9, background: '#1A1E26', border: '1px solid #2A303C' }}>
          <span className={engineDot(engine.state)} />
          <span style={{ fontSize: 13 }}>{engineLabel(engine.state)}</span>
          <span className="mono" style={{ fontSize: 12, color: '#8F98A8' }}>{engine.ctx?.name ?? ''}{engine.info?.version ? ` · v${engine.info.version}` : ''}</span>
        </div>
        <button className="ib" aria-label={t("Settings")} title={t("Settings")} onClick={() => setView('preferences')} style={{ width: 40, height: 40, borderRadius: 9, color: view === 'preferences' ? '#CFE0FF' : undefined, background: view === 'preferences' ? '#1F2A3F' : undefined, borderColor: view === 'preferences' ? '#2F6FEB' : undefined }}>
          <Icon d={ICONS.cog} size={18} sw={1.8} />
        </button>
        <button className={engine.state === 'on' || engine.state === 'stopping' ? 'btn red' : 'btn pri'} disabled={busy || remote} title={remote ? t("A remote engine is started and stopped on its own machine") : undefined} onClick={() => void toggleEngine()}>
          <Icon d={ICONS.power} />
          <span>{engine.state === 'on' || engine.state === 'stopping' ? t("Stop Docker") : t("Start")}</span>
        </button>
      </div>
    </header>
  );
}

export function EngineBanner({ children }: { children?: ReactNode }) {
  const state = useApp((s) => s.engine.state);
  const lost = useApp((s) => s.engine.lost);
  const ctx = useApp((s) => s.engine.ctx);
  const remote = ctx?.kind === 'ssh' || ctx?.kind === 'tcp';
  if (state === 'on') return <>{children}</>;
  const text =
    state === 'connecting' ? t("Connecting to the new context…")
    : state === 'off' && lost ? t("Lost connection to Docker, retrying (1 s, 2 s, 5 s, 10 s)… The data below is from the last update.")
    : state === 'off' && remote ? t("Cannot reach the engine at {endpoint}; retrying (1 s, 2 s, 5 s, 10 s)… Check the machine and the network, or switch context.", { endpoint: ctx?.endpoint ?? '' })
    : state === 'off' ? t("Docker Engine is stopped. Press “Start” to use it again; write actions are blocked.")
    : state === 'starting' ? t("Docker Engine is starting…")
    : t("Docker Engine is stopping…");
  return (
    <>
      <div className="box warn" style={{ margin: '20px 28px 0', display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
        <Icon d={ICONS.warn} size={18} />
        <span>{text}</span>
      </div>
      {children}
    </>
  );
}
