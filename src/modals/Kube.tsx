import { useEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog, save } from '@tauri-apps/plugin-dialog';
import { api, inTauri, on, type ClusterCheck, type K8sPod, type KubeCtxOption, type RawLog } from '../api';
import { useApp } from '../store';
import { useK8s } from '../k8sStore';
import { appendLogs, toLogLine, type LogLine } from '../lib/logs';
import { explainPod, podTone } from '../lib/k8s';
import { Box, Check, DrawerFrame, Field, Indeterminate, ModalFrame } from '../components/ui';
import { TerminalView, type ExecBackend } from '../views/ContainerTabs';
import { t } from '../i18n';

const newKey = () => crypto.randomUUID().replace(/-/g, '');

// ---------------------------------------------------------------- Add cluster

export function K8sAddModal() {
  const s = useApp();
  const [path, setPath] = useState('');
  const [ctxs, setCtxs] = useState<KubeCtxOption[] | null>(null);
  const [readErr, setReadErr] = useState('');
  const [pick, setPick] = useState('');
  const [probe, setProbe] = useState<{ state: 'run' } | { state: 'ok'; r: ClusterCheck } | { state: 'bad'; error: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const read = async (p: string) => {
    setCtxs(null); setReadErr(''); setPick(''); setProbe(null);
    try {
      const list = await api.k8sKubeconfigContexts(p);
      setCtxs(list);
      setPick(list.find((c) => !c.added)?.name ?? list[0]?.name ?? '');
    } catch (e) {
      setReadErr((e as Error).message);
    }
  };
  useEffect(() => { void read(''); }, []);

  const browse = async () => {
    if (!inTauri) return;
    const p = await openDialog({ multiple: false, title: t("Choose kubeconfig file") });
    if (typeof p === 'string') { setPath(p); void read(p); }
  };

  const test = async () => {
    if (!pick) return;
    setProbe({ state: 'run' });
    try {
      setProbe({ state: 'ok', r: await api.k8sProbe(path, pick) });
    } catch (e) {
      setProbe({ state: 'bad', error: (e as Error).message });
    }
  };

  const saveIt = async () => {
    if (!pick) { s.toast(t("Choose a context first"), 'err'); return; }
    setBusy(true);
    try {
      const c = await api.k8sAdd(path, pick);
      s.closeModal();
      const k = useK8s.getState();
      await k.loadClusters();
      s.setView('kubernetes');
      void k.select(c.id);
      s.toast(t("Added cluster {name}", { name: c.name }));
    } catch (e) {
      s.toast((e as Error).message, 'err');
      setBusy(false);
    }
  };

  const cur = ctxs?.find((c) => c.name === pick);
  const cmd = `kubectl --kubeconfig ${path || '~/.kube/config'} --context ${pick || '<context>'} get nodes`;
  return (
    <ModalFrame title={t("Add Kubernetes cluster")} onClose={s.closeModal} maxWidth={620}
      footer={<><button className="btn" onClick={s.closeModal}>{t("Cancel")}</button><button className="btn pri" disabled={!pick || busy} onClick={() => void saveIt()}>{t("Save cluster")}</button></>}>
      <div className="mb">
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{t("Pick a context from a kubeconfig file. The app only reads the file; the cluster itself is not changed.")}</p>
        <Field label={t("Kubeconfig file")}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="inp mono" placeholder="~/.kube/config" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void read(path); }} onBlur={() => void read(path)} />
            <button className="btn" onClick={() => void browse()}>{t("Browse…")}</button>
          </div>
        </Field>
        {readErr && <Box kind="err">{readErr}</Box>}
        {ctxs && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="muted" style={{ fontSize: 13 }}>{t("Contexts in this file")}</span>
            {ctxs.length === 0 && <span className="muted" style={{ fontSize: 13 }}>{t("This kubeconfig has no contexts.")}</span>}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {ctxs.map((c) => (
                <button key={c.name} className={`seg${pick === c.name ? ' on' : ''}`} title={c.server} onClick={() => { setPick(c.name); setProbe(null); }}>
                  {c.name}{c.added ? t(" · added") : ''}
                </button>
              ))}
            </div>
            {cur && <span className="mono muted ell" style={{ fontSize: 12 }}>{cur.server}{cur.namespace ? ` · ns ${cur.namespace}` : ''}</span>}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="muted" style={{ fontSize: 13 }}>{t("Equivalent command")}</span>
          <code className="mono" style={{ fontSize: 12.5, padding: '8px 10px', background: '#0B0D11', borderRadius: 7, overflowX: 'auto', whiteSpace: 'nowrap' }}>{cmd}</code>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" disabled={!pick || probe?.state === 'run'} onClick={() => void test()}>{t("Test connection")}</button>
        </div>
        {probe?.state === 'run' && <Indeterminate />}
        {probe?.state === 'ok' && (
          <Box kind="ok">{t("Connection OK · Kubernetes {version} · {nodes} · {ms} ms", { version: probe.r.version, nodes: probe.r.nodes == null ? t("nodes hidden (no permission)") : t("{n} nodes", { n: probe.r.nodes }), ms: probe.r.latencyMs })}</Box>
        )}
        {probe?.state === 'bad' && <Box kind="err">{probe.error}</Box>}
      </div>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- Pod logs

const RENDER_CAP = 1500;

export function PodLogsDrawer({ clusterId, pod }: { clusterId: string; pod: K8sPod }) {
  const s = useApp();
  // Keep the newest status of the pod (restarts, reasons) while the drawer is open.
  const live = useK8s((k) => k.pods.find((p) => p.namespace === pod.namespace && p.name === pod.name)) ?? pod;
  const [container, setContainer] = useState(pod.containers[0] ?? '');
  const [previous, setPrevious] = useState(false);
  const [follow, setFollow] = useState(true);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(false);
  const buf = useRef<LogLine[]>([]);

  useEffect(() => {
    const key = newKey();
    let un: (() => void) | undefined;
    let cancelled = false;
    buf.current = [];
    setLines([]); setError(''); setEnded(false);
    void (async () => {
      // Listen before starting the stream so the first batch is not lost.
      un = await on<RawLog[] | { end: true }>(`k8s://logs/${key}`, (p) => {
        if (!Array.isArray(p)) { setEnded(true); return; }
        buf.current = appendLogs(buf.current, p.map(toLogLine));
        setLines(buf.current);
      });
      if (cancelled) { un(); return; }
      try {
        await api.k8sLogs(key, clusterId, pod.namespace, pod.name, container || null, previous, follow && !previous);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      un?.();
      void api.k8sLogsStop(key).catch(() => {});
    };
  }, [clusterId, pod.namespace, pod.name, container, previous, follow]);

  const hint = useMemo(() => explainPod(live, lines.map((l) => l.msg)), [live, lines]);
  const shown = lines.length > RENDER_CAP ? lines.slice(-RENDER_CAP) : lines;
  const tone = podTone(live.status);

  const download = async () => {
    if (!inTauri) return;
    const path = await save({ defaultPath: `${pod.name}${previous ? '-previous' : ''}.log` });
    if (!path) return;
    try {
      await api.saveText(path, lines.map((l) => `${l.t} ${l.lvl} ${l.msg}`).join('\n') + '\n');
      s.toast(t("Saved {path}", { path }), 'info');
    } catch (e) {
      s.toast((e as Error).message, 'err');
    }
  };

  return (
    <DrawerFrame eyebrow={`Pod · ${pod.namespace}`} title={pod.name} onClose={s.closeModal} maxWidth={720}
      footer={
        <>
          <Check checked={previous} onChange={setPrevious}>{t("Previous log (--previous)")}</Check>
          <Check checked={follow} onChange={setFollow}>{t("Follow (-f)")}</Check>
          <button className="btn" style={{ marginLeft: 'auto' }} disabled={!lines.length} onClick={() => void download()}>{t("Download log")}</button>
        </>
      }>
      <div className="mb" style={{ flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`pill${tone ? ` ${tone}` : ''}`}>{live.status}</span>
          <span className="muted" style={{ fontSize: 13 }}>{t("{restarts} restarts · node {node}", { restarts: live.restarts, node: live.node || '—' })}</span>
          {pod.containers.length > 1 && (
            <span style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
              {pod.containers.map((c) => <button key={c} className={`seg${container === c ? ' on' : ''}`} onClick={() => setContainer(c)}>{c}</button>)}
            </span>
          )}
        </div>
        {hint && <Box kind="err"><b>{hint.title}</b> {hint.hint}</Box>}
        {error && <Box kind="warn">{error}</Box>}
        {/* column-reverse keeps the view pinned to the newest line */}
        <div className="term scrollbox" style={{ flex: 1, minHeight: 320, padding: '12px 16px' }}>
          <div>
            {!shown.length && !error && <div className="muted">{ended || previous ? t("No log lines.") : t("Reading log…")}</div>}
            {shown.map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 14 }}>
                <span style={{ color: '#6C7586', flex: 'none' }}>{l.t}</span>
                <span className={`lvl ${l.lvl}`}>{l.lvl}</span>
                <span style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{l.msg}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DrawerFrame>
  );
}

// ---------------------------------------------------------------- Pod exec

export function PodExecDrawer({ clusterId, pod }: { clusterId: string; pod: K8sPod }) {
  const s = useApp();
  const [container, setContainer] = useState(pod.containers[0] ?? '');
  const [shell, setShell] = useState<'auto' | 'sh' | 'bash'>('auto');
  const [closed, setClosed] = useState(false);
  const [session, setSession] = useState(1);
  const backend: ExecBackend = {
    open: (sid, sh, cols, rows) => api.k8sExec(sid, clusterId, pod.namespace, pod.name, container || null, sh, cols, rows),
    write: api.k8sExecWrite, resize: api.k8sExecResize, close: api.k8sExecClose,
  };
  const restart = () => { setClosed(false); setSession((n) => n + 1); };
  return (
    <DrawerFrame eyebrow={`Exec · ${pod.namespace}`} title={pod.name} onClose={s.closeModal} maxWidth={860}
      footer={
        <>
          <span className="muted" style={{ fontSize: 13 }}>Shell</span>
          {(['auto', 'sh', 'bash'] as const).map((sh) => <button key={sh} className={`seg${shell === sh ? ' on' : ''}`} onClick={() => { setShell(sh); restart(); }}>{sh}</button>)}
          {closed && <button className="btn pri" style={{ marginLeft: 'auto' }} onClick={restart}>{t("Open again")}</button>}
        </>
      }>
      <div className="mb" style={{ flex: 1, minHeight: 0 }}>
        {pod.containers.length > 1 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 13 }}>Container</span>
            {pod.containers.map((c) => <button key={c} className={`seg${container === c ? ' on' : ''}`} onClick={() => { setContainer(c); restart(); }}>{c}</button>)}
          </div>
        )}
        {closed && <div className="muted" style={{ fontSize: 13 }}>{t("The session has ended.")}</div>}
        <div style={{ background: '#0B0D11', borderRadius: 9, padding: 8 }}>
          <TerminalView key={`${container}-${shell}-${session}`} containerId={`${clusterId}/${pod.namespace}/${pod.name}/${container}`} shell={shell} height={460} backend={backend} onClosed={() => setClosed(true)} />
        </div>
      </div>
    </DrawerFrame>
  );
}
