import { useEffect } from 'react';
import { useApp, usePruneDefs } from '../store';
import { fmtBytes } from '../lib/format';
import { selectedTotal, sumBytes } from '../lib/prune';
import { Box, Indeterminate, PageHead } from '../components/ui';
import { t } from '../i18n';

const freqLabel = (f: string): string => ({ daily: t("daily"), weekly: t("weekly"), monthly: t("monthly") })[f] ?? f;

export function Cleanup() {
  const s = useApp();
  const defs = usePruneDefs();
  useEffect(() => { if (s.engine.state === 'on') void s.refresh('df'); }, [s.engine.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = defs.filter((d) => s.prune[d.id] && d.items.length);
  const total = selectedTotal(defs, s.prune);
  const running = s.pruneState === 'running';
  const label = s.schedule?.enabled ? t("Automatic: {v0}", { v0: freqLabel(s.schedule.freq) }) : t("No automatic schedule");

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHead title={t("Cleanup")} sub={t("Choose what to prune, preview the list, then confirm")}>
        <span className="pill">{label}</span>
        <button className="btn" onClick={() => s.openModal({ kind: 'schedule' })}>{t("Schedule…")}</button>
      </PageHead>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'start' }}>
        <div style={{ flex: '2 1 440px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          {defs.map((d) => {
            const on = !!s.prune[d.id];
            const empty = d.items.length === 0;
            const open = !!s.pruneOpen[d.id] && !empty;
            return (
              <div key={d.id} className={`card prune${on ? (d.id === 'volumes' ? ' danger' : ' on') : ''}`}>
                <label style={{ display: 'flex', alignItems: 'start', gap: 14, cursor: 'pointer' }}>
                  <input type="checkbox" checked={on} onChange={() => s.togglePrune(d.id)} style={{ width: 18, height: 18, accentColor: '#2F6FEB', margin: '2px 0 0', flex: 'none' }} />
                  <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>{d.title}</span>
                    <span className="muted" style={{ fontSize: 13 }}>{d.desc}</span>
                    <span className="mono" style={{ fontSize: 12, color: '#6C7586' }}>{d.cmd}</span>
                  </span>
                  <span className="mono warn" style={{ fontSize: 14, flex: 'none' }}>{s.df || d.id === 'networks' ? fmtBytes(sumBytes(d)) : '…'}</span>
                </label>
                <button className="linkbtn" disabled={empty} onClick={() => s.togglePruneOpen(d.id)} style={{ marginLeft: 32 }}>
                  {empty ? t("Nothing to clean") : open ? t("Hide list") : t("Preview {length} items", { length: d.items.length })}
                </button>
                {open && (
                  <div style={{ marginLeft: 32, background: '#0F1217', border: '1px solid #222731', borderRadius: 8, padding: '6px 12px', maxHeight: 220, overflow: 'auto' }}>
                    {d.items.map((it, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', fontSize: 12.5, borderBottom: '1px solid #1B2029' }}>
                        <span className="mono ell">{it.name}</span>
                        <span className="mono muted" style={{ flex: 'none' }}>{it.bytes > 0 ? fmtBytes(it.bytes) : '—'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="card" style={{ flex: '1 1 280px', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h2 className="h2">{t("Summary")}</h2>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">{t("Selected items")}</span><span>{chosen.length}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span className="muted">{t("Will free up")}</span><span className="mono warn" style={{ fontSize: 20 }}>{fmtBytes(total)}</span></div>
          {s.prune.volumes && <Box kind="err">{t("Pruning volumes deletes data (databases, uploads) not attached to any container. This cannot be undone.")}</Box>}
          {running && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="mono" style={{ fontSize: 12.5, color: '#F0C47A' }}>{t("Running docker system prune…")}</span>
              <Indeterminate />
            </div>
          )}
          {s.pruneState === 'done' && <Box kind="ok">{t("Cleanup done, freed")} {fmtBytes(s.prunedBytes)}.</Box>}
          <button className="btn dan" style={{ height: 44 }} disabled={running || !Object.values(s.prune).some(Boolean)} onClick={s.askPrune}>{t("Clean up now")}</button>
          <button className="btn" onClick={() => s.openModal({ kind: 'schedule' })}>{t("Schedule automatically…")}</button>
        </div>
      </div>
    </div>
  );
}
