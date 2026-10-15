import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Schedule } from '../api';
import { useApp, usePruneDefs } from '../store';
import { useK8s } from '../k8sStore';
import { fmtBytes } from '../lib/format';
import { selectedTotal, sumBytes } from '../lib/prune';
import { imgRef, shortPath, stateLabel } from '../lib/ui';
import { Box, Check, Field, ModalFrame, Overlay } from '../components/ui';
import { t } from '../i18n';

export function ConfirmModal({ m }: { m: Extract<NonNullable<ReturnType<typeof useApp.getState>['modal']>, { kind: 'confirm' }> }) {
  const close = useApp((s) => s.closeModal);
  return (
    <ModalFrame
      title={m.title}
      onClose={close}
      maxWidth={460}
      footer={
        <>
          <button className="btn" onClick={close}>{t("Cancel")}</button>
          <button className={m.danger ? 'btn dan' : 'btn pri'} autoFocus onClick={() => { close(); void m.action(); }}>{m.yes}</button>
        </>
      }
    >
      <div className="mb"><p style={{ margin: 0, color: '#C9D0DC', lineHeight: 1.55, whiteSpace: 'pre-line' }}>{m.body}</p></div>
    </ModalFrame>
  );
}

export function InfoModal({ title, body }: { title: string; body: string }) {
  const close = useApp((s) => s.closeModal);
  return (
    <ModalFrame title={title} onClose={close} maxWidth={460} footer={<button className="btn pri" onClick={close}>{t("Got it")}</button>}>
      <div className="mb"><p style={{ margin: 0, color: '#C9D0DC', lineHeight: 1.55, whiteSpace: 'pre-line' }}>{body}</p></div>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- Command palette Ctrl K

interface PalItem { kind: string; label: string; sub: string; run: () => void }

/** Fuzzy match: the query characters must appear in order; scores higher when contiguous or at word starts. */
export function fuzzyScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct;
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (const ch of q) {
    const ix = t.indexOf(ch, ti);
    if (ix < 0) return 0;
    score += ix === prev + 1 ? 5 : 1;
    if (ix === 0 || /[\s\-_/.:]/.test(t[ix - 1])) score += 3;
    prev = ix;
    ti = ix + 1;
  }
  return score;
}

export function PaletteModal() {
  const s = useApp();
  const close = s.closeModal;
  const [q, setQ] = useState('');
  const [cur, setCur] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<PalItem[]>(() => {
    const act = (label: string, sub: string, fn: () => void): PalItem => ({ kind: t("Command"), label, sub, run: () => { close(); fn(); } });
    const actions = [
      act(t("Run new container"), 'docker run', () => s.openModal({ kind: 'run' })),
      act('Pull image', 'docker pull', () => s.openModal({ kind: 'pull' })),
      act('Build image', 'docker build', () => s.openModal({ kind: 'build' })),
      act(t("Add project folder"), t("Remember a folder with compose / Dockerfile"), () => s.openModal({ kind: 'add' })),
      act(t("Free up disk space"), 'prune containers, images, cache…', () => s.setView('cleanup')),
      act(s.engine.state === 'on' ? t("Stop Docker Engine") : t("Start Docker Engine"), 'Engine', () => void s.toggleEngine()),
      act(t("Open Kubernetes"), 'pods, deployments, services', () => s.setView('kubernetes')),
      act(t("Add connection"), 'SSH, TCP + TLS, WSL2, Kubernetes', () => s.openModal({ kind: 'ctxAdd' })),
      act(t("Manage connections"), 'Docker context & cluster', () => s.setView('settings')),
    ];
    const k8s = useK8s.getState();
    const cls: PalItem[] = k8s.clusters.map((c) => ({ kind: 'Cluster', label: t("Open cluster {name}", { name: c.name }), sub: c.server, run: () => { close(); s.setView('kubernetes'); void k8s.select(c.id); } }));
    const ctxs: PalItem[] = s.contexts.filter((c) => !c.active && c.supported).map((c) => ({ kind: 'Context', label: t("Switch to {name}", { name: c.name }), sub: c.endpoint, run: () => { close(); void s.switchCtx(c.id); } }));
    const cts: PalItem[] = s.containers.map((c) => ({ kind: 'Container', label: c.name, sub: `${c.image} · ${stateLabel(c.state)}`, run: () => { close(); useApp.setState({ view: 'containers', selected: c.id, cq: '', onlyRunning: false }); } }));
    const prs: PalItem[] = s.projects.map((p) => ({ kind: t("Projects"), label: p.name, sub: shortPath(p.path), run: () => { close(); s.openModal({ kind: 'files', projectId: p.id }); } }));
    const ims: PalItem[] = s.images.filter((im) => !im.dangling).map((im) => ({ kind: 'Image', label: imgRef(im), sub: fmtBytes(im.size), run: () => { close(); useApp.setState({ view: 'images' }); s.openModal({ kind: 'image', ref: imgRef(im) }); } }));
    const all = [...actions, ...ctxs, ...cls, ...cts, ...prs, ...ims];
    const query = q.trim();
    if (!query) return [...actions, ...cts.slice(0, 4)].slice(0, 10);
    return all
      .map((it) => ({ it, sc: Math.max(fuzzyScore(it.label, query), fuzzyScore(`${it.label} ${it.sub} ${it.kind}`, query) * 0.6) }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 10)
      .map((x) => x.it);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setCur(0), [q]);
  useEffect(() => { listRef.current?.querySelector('.palitem.sel')?.scrollIntoView({ block: 'nearest' }); }, [cur]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCur((c) => Math.min(items.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCur((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[cur]?.run(); }
  };

  return (
    <Overlay onClose={close}>
      <div className="modal pal" role="dialog" aria-modal="true" aria-label={t("Command palette")}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #242935' }}>
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8F98A8" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <label htmlFor="pq" className="sr-only">{t("Search")}</label>
          <input id="pq" className="tin" autoFocus autoComplete="off" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 16, height: 36 }} placeholder={t("Type a container, image, project or command name…")} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
          <span className="kbd">Esc</span>
        </div>
        <div ref={listRef} style={{ padding: 8, display: 'flex', flexDirection: 'column', maxHeight: 420, overflow: 'auto' }}>
          {items.length === 0 && <div className="empty">{t("No results found.")}</div>}
          {items.map((it, i) => (
            <button key={i} className={`palitem${i === cur ? ' sel' : ''}`} onMouseMove={() => setCur(i)} onClick={it.run}>
              <span className="tag" style={{ alignSelf: 'center', width: 70, textAlign: 'center' }}>{it.kind}</span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span className="ell" style={{ fontWeight: 500 }}>{it.label}</span>
                <span className="muted ell" style={{ fontSize: 12 }}>{it.sub}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------- Prune

export function PruneConfirmModal() {
  const s = useApp();
  const defs = usePruneDefs();
  const chosen = defs.filter((d) => s.prune[d.id] && d.items.length);
  const total = selectedTotal(defs, s.prune);
  return (
    <ModalFrame
      title={t("Confirm cleanup")} onClose={s.closeModal} maxWidth={480}
      footer={<><button className="btn" onClick={s.closeModal}>{t("Cancel")}</button><button className="btn dan" onClick={() => void s.doPrune()}>{t("Clean")} {fmtBytes(total)}</button></>}
    >
      <div className="mb">
        <div>
          {chosen.map((d) => (
            <div key={d.id} className="kv"><span>{d.title} ({d.items.length})</span><span>{fmtBytes(sumBytes(d))}</span></div>
          ))}
        </div>
        {s.prune.volumes && <Box kind="err">{t("Includes removing volumes. Data will be lost permanently.")}</Box>}
      </div>
    </ModalFrame>
  );
}

export function ScheduleModal() {
  const s = useApp();
  const cur = s.schedule;
  const [f, setF] = useState<Schedule | null>(cur ? { ...cur, enabled: true } : null);
  if (!f) return null;
  const set = (p: Partial<Schedule>) => setF({ ...f, ...p });
  const save = async () => {
    try {
      const saved = await api.scheduleSet(f);
      useApp.setState({ schedule: saved });
      s.closeModal();
      s.toast(f.enabled ? t("Automatic cleanup schedule saved") : t("Automatic cleanup turned off"), 'info');
    } catch (e) {
      s.toast((e as Error).message, 'err');
    }
  };
  return (
    <ModalFrame title={t("Schedule automatic cleanup")} onClose={s.closeModal} maxWidth={480} footer={<><button className="btn" onClick={s.closeModal}>{t("Cancel")}</button><button className="btn pri" onClick={() => void save()}>{t("Save schedule")}</button></>}>
      <div className="mb">
        <Check checked={f.enabled} onChange={(v) => set({ enabled: v })}>{t("Enable automatic cleanup")}</Check>
        <Field label={t("Frequency")}>
          <select className="inp" value={f.freq} onChange={(e) => set({ freq: e.target.value as Schedule['freq'] })}>
            <option value="daily">{t("Daily at 02:00")}</option>
            <option value="weekly">{t("Weekly, Sunday 02:00")}</option>
            <option value="monthly">{t("1st of each month")}</option>
          </select>
        </Field>
        <Field label={t("Keep build cache newer than")}>
          <select className="inp" value={String(f.keepCacheDays)} onChange={(e) => set({ keepCacheDays: Number(e.target.value) as Schedule['keepCacheDays'] })}>
            <option value="1">{t("1 day")}</option><option value="7">{t("7 days")}</option><option value="30">{t("30 days")}</option>
          </select>
        </Field>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span className="muted" style={{ fontSize: 13 }}>{t("Apply to")}</span>
          <Check checked={f.containers} onChange={(v) => set({ containers: v })}>{t("Stopped containers")}</Check>
          <Check checked={f.danglingImages} onChange={(v) => set({ danglingImages: v })}>Images dangling</Check>
          <Check checked={f.buildCache} onChange={(v) => set({ buildCache: v })}>Build cache</Check>
        </div>
        <Box kind="info">{t("Volumes are never cleaned automatically, to avoid data loss.")}</Box>
        <span className="muted" style={{ fontSize: 12.5 }}>{t("The schedule runs while the app is open (or minimized); if the machine is off at the scheduled time, it catches up the next time the app opens.")}</span>
      </div>
    </ModalFrame>
  );
}
