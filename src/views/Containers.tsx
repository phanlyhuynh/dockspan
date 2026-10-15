import { useEffect, useMemo } from 'react';
import { api, type Container } from '../api';
import { useApp, type Tab } from '../store';
import { fmtMem, fmtPct } from '../lib/format';
import { stateLabel, dotClass, isBusyState, portText, portUrl, type DisplayState } from '../lib/ui';
import { IconBtn, ICONS, PageHead } from '../components/ui';
import { LogsTab, TerminalTab, TerminalStopped, StatsTab, InspectTab } from './ContainerTabs';
import { t } from '../i18n';

const COLS = '2fr 1.7fr 1.2fr 0.7fr 0.8fr 1.6fr';

export function useDisplayState(c: Container): DisplayState {
  const b = useApp((s) => s.busy[c.id]);
  return (b as DisplayState | undefined) ?? c.state;
}

function Row({ c }: { c: Container }) {
  const s = useApp();
  const ds = useDisplayState(c);
  const url = portUrl(c);
  const ports = portText(c);
  const st = s.stats[c.id];
  const running = c.state === 'running';
  const stopping = running || c.state === 'restarting' || c.state === 'paused';
  const busy = isBusyState(ds) && !!s.busy[c.id];
  return (
    <div className={`tr${s.selected === c.id ? ' sel' : ''}`} style={{ gridTemplateColumns: COLS }}>
      <button className="cellbtn" onClick={() => s.setSelected(c.id)}>
        <span className={dotClass(ds)} />
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span className="nm ell">{c.name}</span>
          <span className="muted" style={{ fontSize: 12 }}>{c.project ?? 'standalone'} · {stateLabel(ds)}{c.health && ds === 'running' ? ` · ${c.health}` : ''}</span>
        </span>
      </button>
      <span className="mono ell" style={{ fontSize: 12.5, color: '#C9D0DC' }} title={c.image}>{c.image}</span>
      <span className="mono" style={{ fontSize: 12.5 }}>
        {url ? <a href={url} onClick={(e) => { e.preventDefault(); api.openUrl(url).catch((er) => s.toast(er.message, 'err')); }}>{ports}</a> : <span className="muted">{ports}</span>}
      </span>
      <span className="mono" style={{ fontSize: 12.5 }}>{running && st ? fmtPct(st.cpu) : '—'}</span>
      <span className="mono" style={{ fontSize: 12.5 }}>{running && st ? fmtMem(st.memUsed) : '—'}</span>
      <span style={{ display: 'flex', justifyContent: 'end', gap: 6 }}>
        <button className={stopping ? 'btn sm' : 'btn sm pri'} disabled={busy} style={{ minWidth: 64 }} onClick={() => void (stopping ? s.stopC(c.id) : s.startC(c.id))}>
          {busy ? '…' : stopping ? t("Stop") : t("Run")}
        </button>
        <IconBtn icon={ICONS.restart} label="Restart" disabled={busy} onClick={() => void s.restartC(c.id)} />
        <IconBtn icon={ICONS.terminal} label={t("Open terminal")} onClick={() => s.setSelected(c.id, 'terminal')} />
        <IconBtn icon={ICONS.trash} label={t("Delete container")} disabled={busy} onClick={() => s.removeC(c.id)} />
      </span>
    </div>
  );
}

export function Containers() {
  const s = useApp();
  const q = s.cq.trim().toLowerCase();
  const list = useMemo(
    () => s.containers.filter((c) => (!s.onlyRunning || c.state === 'running') && (!q || `${c.name} ${c.image} ${c.project ?? ''}`.toLowerCase().includes(q))),
    [s.containers, s.onlyRunning, q],
  );
  const running = s.containers.filter((c) => c.state === 'running');
  const sel = s.containers.find((c) => c.id === s.selected) ?? null;

  // Table CPU/RAM: sampled periodically while the page is visible and the engine is running.
  const runningKey = running.map((c) => c.id).join(',');
  useEffect(() => {
    if (s.view !== 'containers' || s.engine.state !== 'on' || !running.length) return;
    let stop = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const st = await api.containersStats(running.map((c) => c.id));
        if (!stop) useApp.setState((x) => ({ stats: { ...x.stats, ...st } }));
      } catch { /* the engine may have just stopped */ }
    };
    void tick();
    const t = setInterval(() => void tick(), 5000);
    return () => { stop = true; clearInterval(t); };
  }, [runningKey, s.engine.state, s.view]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remove terminals of containers that stopped/restarted (stream closed) or were deleted.
  useEffect(() => {
    for (const id of Object.keys(s.terms)) {
      const c = s.containers.find((x) => x.id === id);
      if (!c || c.state !== 'running') s.closeTerm(id);
    }
  }, [s.containers, s.terms]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHead title="Containers" sub={t("{length} running · {length1} total · context {v2}", { length: running.length, length1: s.containers.length, v2: s.engine.ctx?.name ?? '' })}>
        <label className="sr-only" htmlFor="cq">{t("Filter containers")}</label>
        <input id="cq" className="inp" style={{ width: 220 }} placeholder={t("Filter by name, image, project")} value={s.cq} onChange={(e) => s.setCq(e.target.value)} />
        <button className={s.onlyRunning ? 'btn on' : 'btn'} onClick={() => s.setOnlyRunning(!s.onlyRunning)}>{t("Running only")}</button>
        <button className="btn pri" onClick={() => s.openModal({ kind: 'run' })}>{t("Run new container")}</button>
      </PageHead>

      <div className="card" style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 900 }}>
          <div className="th" style={{ gridTemplateColumns: COLS }}>
            <span>{t("Name")}</span><span>Image</span><span>Ports</span><span>CPU</span><span>RAM</span><span style={{ textAlign: 'right' }}>{t("Actions")}</span>
          </div>
          {list.length === 0 && (
            <div className="empty">
              {s.containers.length === 0 && s.loaded ? t("No containers yet. Run a new container or Start a project.") : t("No containers match the filter.")}
            </div>
          )}
          {list.map((c) => <Row key={c.id} c={c} />)}
        </div>
      </div>

      {sel && <Detail c={sel} />}
    </div>
  );
}

const TABS: [Tab, string][] = [['logs', 'Logs'], ['terminal', 'Terminal'], ['stats', 'Stats'], ['inspect', 'Inspect']];

function Detail({ c }: { c: Container }) {
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const terms = useApp((s) => s.terms);
  const containers = useApp((s) => s.containers);
  const openTerm = useApp((s) => s.openTerm);
  const closeTerm = useApp((s) => s.closeTerm);
  const ds = useDisplayState(c);
  useEffect(() => { if (tab === 'terminal' && c.state === 'running') openTerm(c.id); }, [tab, c.id, c.state, openTerm]);
  const hosted = Object.keys(terms).map((id) => containers.find((x) => x.id === id)).filter((x): x is Container => !!x);
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 18px', borderBottom: '1px solid #242935' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span className={dotClass(ds)} />
          <span style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</span>
          <span className="mono muted" style={{ fontSize: 12 }}>{c.id.slice(0, 12)}</span>
          <span className="muted" style={{ fontSize: 12.5 }}>{stateLabel(ds)}</span>
        </div>
        <div role="tablist" aria-label={t("Container details")} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
      </div>
      {tab === 'logs' && <LogsTab key={c.id} c={c} />}
      {tab === 'stats' && <StatsTab key={c.id} c={c} />}
      {tab === 'inspect' && <InspectTab key={c.id} c={c} />}
      {tab === 'terminal' && c.state !== 'running' && <TerminalStopped c={c} />}
      {hosted.map((h) => {
        const show = tab === 'terminal' && h.id === c.id;
        return (
          <div key={h.id} style={{ display: show ? 'block' : 'none' }}>
            <TerminalTab c={h} visible={show} onEmpty={() => { closeTerm(h.id); if (show) setTab('logs'); }} />
          </div>
        );
      })}
    </div>
  );
}
