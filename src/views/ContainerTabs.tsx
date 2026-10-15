import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { save } from '@tauri-apps/plugin-dialog';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { api, inTauri, on, type Container, type RawLog, type StatSample } from '../api';
import { useApp } from '../store';
import { appendLogs, filterLogs, toLogLine, type LogLevel, type LogLine } from '../lib/logs';
import { fmtBytes, fmtMem } from '../lib/format';
import { dateLocale, t } from '../i18n';

// ---------------------------------------------------------------- Logs

const levels = (): ['ALL' | LogLevel, string][] => [['ALL', t("All")], ['INFO', 'Info'], ['WARN', 'Warn'], ['ERROR', 'Error']];
const RENDER_CAP = 1500;

export function LogsTab({ c }: { c: Container }) {
  const toast = useApp((s) => s.toast);
  const [lines, setLines] = useState<LogLine[]>([]);
  const ref = useRef<LogLine[]>([]);
  const [level, setLevel] = useState<'ALL' | LogLevel>('ALL');
  const [q, setQ] = useState('');
  const [follow, setFollow] = useState(true);
  const [clearedAt, setClearedAt] = useState(0);

  // Log stream; resume with `since` when the container changes state (restart) to avoid duplicate lines.
  useEffect(() => {
    if (!follow) return;
    let un: (() => void) | undefined;
    let cancelled = false;
    const lastMs = ref.current.length ? ref.current[ref.current.length - 1].ms : 0;
    void (async () => {
      un = await on<RawLog[]>(`logs://${c.id}`, (raws) => {
        let mapped = raws.map(toLogLine);
        if (lastMs) mapped = mapped.filter((l) => l.ms > lastMs);
        if (!mapped.length) return;
        ref.current = appendLogs(ref.current, mapped);
        setLines(ref.current);
      });
      if (cancelled) { un(); return; }
      try {
        await api.logsSubscribe(c.id, 500, lastMs ? Math.floor(lastMs / 1000) : undefined);
      } catch (e) {
        toast((e as Error).message, 'err');
      }
    })();
    return () => {
      cancelled = true;
      un?.();
      void api.logsUnsubscribe(c.id).catch(() => {});
    };
  }, [c.id, c.state, follow, toast]);

  const filtered = useMemo(() => filterLogs(lines, level, q, clearedAt), [lines, level, q, clearedAt]);
  const shown = filtered.length > RENDER_CAP ? filtered.slice(-RENDER_CAP) : filtered;

  const download = async () => {
    if (!inTauri) return;
    const path = await save({ defaultPath: `${c.name}.log` });
    if (!path) return;
    try {
      await api.saveText(path, filtered.map((l) => `${l.t} ${l.lvl} ${l.msg}`).join('\n') + '\n');
      toast(t("Saved {path}", { path }), 'info');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '10px 18px', borderBottom: '1px solid #242935' }}>
        {levels().map(([id, label]) => (
          <button key={id} className={`seg${level === id ? ' on' : ''}`} onClick={() => setLevel(id)}>{label}</button>
        ))}
        <label className="sr-only" htmlFor="logq">{t("Filter logs")}</label>
        <input id="logq" className="inp" style={{ width: 200, height: 30, fontSize: 13 }} placeholder={t("Filter by keyword…")} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="chk" style={{ marginLeft: 'auto', fontSize: 13 }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />{t("Follow in real time")}
        </label>
        <button className="btn sm" onClick={() => setClearedAt(Date.now() + 1)}>{t("Clear screen")}</button>
        <button className="btn sm" onClick={() => void download()}>{t("Download log")}</button>
      </div>
      <div className="term scrollbox" style={{ height: 280, padding: '12px 18px' }}>
        <div>
          {shown.length === 0 && <div className="muted">{lines.length === 0 ? t("No log lines yet.") : t("No log lines match the filter.")}</div>}
          {shown.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 14 }}>
              <span style={{ color: '#6C7586', flex: 'none' }}>{l.t}</span>
              <span className={`lvl ${l.lvl}`}>{l.lvl}</span>
              <span style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{l.msg}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="muted" style={{ padding: '8px 18px', fontSize: 12.5, borderTop: '1px solid #242935' }}>
        {filtered.length} {t("lines ·")} {follow ? t("following in real time") : t("following paused")}
        {filtered.length > RENDER_CAP ? t(" · showing the last {RENDER_CAP} lines", { RENDER_CAP }) : ''}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Terminal

const b64 = (d: string) => Uint8Array.from(atob(d), (ch) => ch.charCodeAt(0));

/** xterm.js terminal attached to a container's `docker exec`. Used by the tab and the separate window. */
export function TerminalView({ containerId, shell, height, onClosed, onShell }: { containerId: string; shell: 'auto' | 'sh' | 'bash'; height?: number | string; onClosed: () => void; onShell?: (s: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;
  const shellRef = useRef(onShell);
  shellRef.current = onShell;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace", fontSize: 13, cursorBlink: true, scrollback: 5000,
      theme: { background: '#0B0D11', foreground: '#D5DAE3', cursor: '#FFFFFF', selectionBackground: '#2F4E86' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try { fit.fit(); } catch { /* no size yet */ }

    const sid = crypto.randomUUID().replace(/-/g, '');
    let disposed = false;
    let opened = false;
    let un: (() => void) | undefined;
    let resizeT: ReturnType<typeof setTimeout> | undefined;

    const dataSub = term.onData((d) => { if (opened) void api.execWrite(sid, d).catch(() => {}); });
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { return; }
      clearTimeout(resizeT);
      resizeT = setTimeout(() => { if (opened) void api.execResize(sid, term.cols, term.rows).catch(() => {}); }, 120);
    });
    ro.observe(el);

    void (async () => {
      // Listen before opening the session so the first prompt line is not lost.
      un = await on<{ t: 'data' | 'close'; d?: string }>(`exec://${sid}`, (p) => {
        if (p.t === 'data' && p.d) term.write(b64(p.d));
        else if (p.t === 'close' && !disposed) closedRef.current();
      });
      if (disposed) { un(); return; }
      try {
        const r = await api.execOpen(sid, containerId, shell, term.cols, term.rows);
        opened = true;
        shellRef.current?.(r.shell.split('/').pop() ?? '');
        if (disposed) void api.execClose(sid).catch(() => {});
        else term.focus();
      } catch (e) {
        term.write(`\x1b[31m${(e as Error).message}\x1b[0m\r\n`);
      }
    })();

    return () => {
      disposed = true;
      clearTimeout(resizeT);
      ro.disconnect();
      dataSub.dispose();
      un?.();
      if (opened) void api.execClose(sid).catch(() => {});
      // xterm schedules a redraw for the next frame; disposing right after open causes a `dimensions` error.
      setTimeout(() => term.dispose(), 80);
    };
  }, [containerId, shell]);

  return <div ref={host} className="xterm-host" style={{ height: height ?? 280 }} />;
}

interface TermSession { key: number; shell: 'auto' | 'sh' | 'bash'; used: string }

export function TerminalStopped({ c }: { c: Container }) {
  const startC = useApp((s) => s.startC);
  return (
    <div className="empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <span>{t("The container is not running, so a terminal cannot be opened.")}</span>
      <button className="btn pri" onClick={() => void startC(c.id)}>{t("Run container")}</button>
    </div>
  );
}

/**
 * Multiple terminal sessions on one container at the same time; each session is its own `docker exec`.
 * The component stays mounted (hidden) when another container is selected so sessions are not lost; it is removed only when the
 * container stops/restarts/is deleted or the app exits. `onEmpty` reports when the last session has closed.
 */
export function TerminalTab({ c, visible = true, onEmpty }: { c: Container; visible?: boolean; onEmpty: () => void }) {
  const toast = useApp((s) => s.toast);
  const seq = useRef(1);
  const [sessions, setSessions] = useState<TermSession[]>([{ key: 1, shell: 'auto', used: '' }]);
  const [active, setActive] = useState(1);
  const [newShell, setNewShell] = useState<'auto' | 'sh' | 'bash'>('auto');

  const add = () => {
    seq.current += 1;
    const key = seq.current;
    setSessions((p) => [...p, { key, shell: newShell, used: '' }]);
    setActive(key);
  };
  const close = (key: number, exited: boolean) => {
    const left = sessions.filter((x) => x.key !== key);
    if (!left.length) {
      if (visible) toast(t("Closed terminal session {name}", { name: c.name }), 'info');
      onEmpty();
      return;
    }
    setSessions(left);
    if (active === key) setActive(left[left.length - 1].key);
    if (exited) toast(t("Closed a terminal session"), 'info');
  };
  const popOut = () => {
    try {
      new WebviewWindow(`term-${c.id.slice(0, 8)}-${Date.now()}`, {
        url: `index.html?term=${c.id}&name=${encodeURIComponent(c.name)}`, title: `${c.name} · Terminal`, width: 900, height: 560,
      });
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  return (
    <>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', padding: '8px 18px', borderBottom: '1px solid #242935' }}>
        {sessions.map((x, i) => (
          <span key={x.key} style={{ display: 'inline-flex', alignItems: 'center' }}>
            <button className={`tab${active === x.key ? ' on' : ''}`} style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }} onClick={() => setActive(x.key)}>
              Terminal {i + 1}{x.used ? ` · ${x.used}` : ''}
            </button>
            <button className={`tab${active === x.key ? ' on' : ''}`} aria-label={t("Close terminal {v0}", { v0: i + 1 })} title={t("Close this session")} style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, padding: '0 8px' }} onClick={() => close(x.key, false)}>×</button>
          </span>
        ))}
        <button className="btn sm" onClick={add}>{t("+ New terminal")}</button>
      </div>
      {sessions.map((x) => (
        <div key={x.key} style={{ display: x.key === active && visible ? 'block' : 'none' }}>
          <TerminalView
            containerId={c.id}
            shell={x.shell}
            onShell={(u) => setSessions((p) => p.map((y) => (y.key === x.key ? { ...y, used: u } : y)))}
            onClosed={() => close(x.key, true)}
          />
        </div>
      ))}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 18px', borderTop: '1px solid #242935', fontSize: 13, alignItems: 'center' }}>
        <span className="muted">{t("Shell for new terminals")}</span>
        {(['auto', 'sh', 'bash'] as const).map((sh) => (
          <button key={sh} className={`seg${newShell === sh ? ' on' : ''}`} onClick={() => setNewShell(sh)}>{sh}</button>
        ))}
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={popOut}>{t("Open in separate window")}</button>
      </div>
    </>
  );
}

/** Separate terminal window (?term=<id>). */
export function TerminalWindow({ id, name }: { id: string; name: string }) {
  const [closed, setClosed] = useState(false);
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0B0D11' }}>
      <div style={{ padding: '8px 14px', borderBottom: '1px solid #242935', fontSize: 13, color: '#8F98A8' }}>{name} · docker exec{closed ? t(" · session closed") : ''}</div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {!closed && <TerminalView containerId={id} shell="auto" height="100%" onClosed={() => setClosed(true)} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Stats

const N = 24;

function Spark({ values, cls }: { values: number[]; cls: string }) {
  const max = Math.max(1, ...values);
  const padded = [...Array(Math.max(0, N - values.length)).fill(0), ...values.slice(-N)];
  return (
    <div style={{ display: 'flex', alignItems: 'end', gap: 3, height: 56 }}>
      {padded.map((v, i) => <div key={i} className={`sbar ${cls}`} style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />)}
    </div>
  );
}

export function StatsTab({ c }: { c: Container }) {
  const [samples, setSamples] = useState<StatSample[]>([]);
  const running = c.state === 'running';

  // Only open the stream while the Stats tab is visible.
  useEffect(() => {
    if (!running) return;
    let un: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      un = await on<StatSample>(`stats://${c.id}`, (s) => setSamples((p) => [...p, s].slice(-(N + 1))));
      if (cancelled) { un(); return; }
      await api.statsSubscribe(c.id).catch(() => {});
    })();
    return () => { cancelled = true; un?.(); void api.statsUnsubscribe(c.id).catch(() => {}); };
  }, [c.id, running]);

  if (!running) return <div className="empty">{t("The container is stopped, so there are no realtime stats.")}</div>;

  const last = samples[samples.length - 1];
  const rate = (f: (s: StatSample) => number) => samples.slice(1).map((s, i) => Math.max(0, (f(s) - f(samples[i])) / Math.max(0.5, (s.ts - samples[i].ts) / 1000)));
  const cards = [
    { label: 'CPU', value: last ? `${last.cpu.toFixed(1)}%` : '—', vals: samples.map((s) => s.cpu), cls: 'cpu' },
    { label: 'RAM', value: last ? `${fmtMem(last.memUsed)} / ${last.memLimit ? fmtMem(last.memLimit) : '∞'}` : '—', vals: samples.map((s) => (s.memLimit ? (s.memUsed / s.memLimit) * 100 : 0)), cls: 'ram' },
    { label: 'Network I/O', value: last ? `${fmtBytes(last.netRx)} / ${fmtBytes(last.netTx)}` : '—', vals: rate((s) => s.netRx + s.netTx), cls: 'net' },
    { label: 'Disk I/O', value: last ? `${fmtBytes(last.blkRead)} / ${fmtBytes(last.blkWrite)}` : '—', vals: rate((s) => s.blkRead + s.blkWrite), cls: 'disk' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, padding: 18 }}>
      {cards.map((k) => (
        <div key={k.label} style={{ background: '#1A1E26', border: '1px solid #242935', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="muted" style={{ fontSize: 13 }}>{k.label}</span>
            <span className="mono" style={{ fontSize: 13 }}>{k.value}</span>
          </div>
          <Spark values={k.vals} cls={k.cls} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Inspect

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function InspectTab({ c }: { c: Container }) {
  const toast = useApp((s) => s.toast);
  const [data, setData] = useState<J | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let off = false;
    api.inspect(c.id).then((d) => { if (!off) setData(d); }).catch((e) => { if (!off) setErr(e.message); });
    return () => { off = true; };
  }, [c.id, c.state]);

  if (err) return <div className="empty">{err}</div>;
  if (!data) return <div className="empty">{t("Reading details…")}</div>;

  const ports = Object.entries((data.NetworkSettings?.Ports ?? {}) as J)
    .map(([k, v]) => (Array.isArray(v) && v.length ? v.map((b: J) => `${b.HostPort}→${k}`).join(', ') : k))
    .join(', ');
  const mounts = ((data.Mounts ?? []) as J[]).map((m) => `${m.Name ?? m.Source}:${m.Destination}`).join(', ');
  const rows: [string, string][] = [
    ['Image', data.Config?.Image ?? '—'],
    ['Container ID', String(data.Id ?? '').slice(0, 12)],
    [t("Status"), `${data.State?.Status ?? '—'}${data.State?.Health?.Status ? ` (${data.State.Health.Status})` : ''}`],
    ['Compose project', data.Config?.Labels?.['com.docker.compose.project'] ?? '—'],
    ['Ports', ports || '—'],
    ['Network', Object.keys(data.NetworkSettings?.Networks ?? {}).join(', ') || '—'],
    ['Restart policy', data.HostConfig?.RestartPolicy?.Name || 'no'],
    ['Mounts', mounts || '—'],
    [t("Created at"), data.Created ? new Date(data.Created).toLocaleString(dateLocale()) : '—'],
    ['Platform', data.Platform ?? '—'],
  ];
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', columnGap: 28, padding: '6px 18px 4px' }}>
        {rows.map(([k, v]) => <div key={k} className="kv"><span className="muted">{k}</span><span>{v}</span></div>)}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '12px 18px' }}>
        <button className="btn sm" onClick={() => navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => toast(t("Copied inspect JSON"), 'info')).catch(() => toast(t("Could not copy"), 'err'))}>{t("Copy inspect JSON")}</button>
      </div>
    </>
  );
}
