import { useEffect } from 'react';
import { useApp, usePruneDefs } from '../store';
import { fmtBytes } from '../lib/format';
import { sumBytes } from '../lib/prune';
import { projectStatus } from '../lib/projects';
import { shortPath } from '../lib/ui';
import { PageHead } from '../components/ui';
import { t } from '../i18n';

const Stat = ({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) => (
  <button onClick={onClick} className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 6, textAlign: 'left', color: '#E6E8EE' }}>
    <span style={{ color: '#8F98A8', fontSize: 13 }}>{label}</span>
    {children}
  </button>
);
const Big = ({ children, color }: { children: React.ReactNode; color?: string }) => <span style={{ fontSize: 28, fontWeight: 600, color }}>{children}</span>;
const Dim = ({ children }: { children: React.ReactNode }) => <span style={{ fontSize: 16, color: '#8F98A8' }}>{children}</span>;

export function Dashboard() {
  const s = useApp();
  const defs = usePruneDefs();
  useEffect(() => { if (s.engine.state === 'on') void s.refresh('df'); }, [s.engine.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = s.containers.filter((c) => c.state === 'running').length;
  const df = s.df;
  const imgBytes = df?.imagesSize ?? 0;
  const volBytes = df?.volumesSize ?? 0;
  const cacheBytes = df?.cacheSize ?? 0;
  const ctrBytes = df?.containersSize ?? 0;
  const total = imgBytes + volBytes + cacheBytes + ctrBytes;
  const reclaim = defs.reduce((a, d) => a + sumBytes(d), 0);
  // Each segment is at least 1.5% so it stays visible.
  const w = (x: number) => ({ width: `${total && x > 0 ? Math.max((x / total) * 100, 1.5).toFixed(1) : 0}%` });
  const dfLabel = (n: number) => (df ? fmtBytes(n) : '…');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHead title={t("Overview")} sub={t("Docker status on this machine")}>
        <button className="btn" onClick={() => s.openModal({ kind: 'pull' })}>Pull image</button>
        <button className="btn" onClick={() => s.openModal({ kind: 'run' })}>{t("Run container")}</button>
        <button className="btn pri" onClick={() => s.openModal({ kind: 'add' })}>{t("Add folder")}</button>
      </PageHead>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
        <Stat label={t("Running containers")} onClick={() => s.setView('containers')}><Big>{running}<Dim> / {s.containers.length}</Dim></Big></Stat>
        <Stat label="Images" onClick={() => s.setView('images')}><Big>{s.images.length}<Dim> · {dfLabel(imgBytes)}</Dim></Big></Stat>
        <Stat label="Volumes" onClick={() => s.setView('volumes')}><Big>{s.volumes.length}<Dim> · {dfLabel(volBytes)}</Dim></Big></Stat>
        <Stat label={t("Can be freed")} onClick={() => s.setView('cleanup')}><Big color="#F0B35A">{df ? fmtBytes(reclaim) : '…'}</Big></Stat>
      </div>

      <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h2 className="h2">{t("Docker disk usage")}</h2>
          <span className="mono muted" style={{ fontSize: 13 }}>{dfLabel(total)} {t("total")}</span>
        </div>
        <div className="seg-bar">
          <div className="s-img" style={w(imgBytes)} />
          <div className="s-vol" style={w(volBytes)} />
          <div className="s-cache" style={w(cacheBytes)} />
          <div className="s-ctr" style={w(ctrBytes)} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, fontSize: 13, color: '#B8C0CE' }}>
          {([['s-img', 'Images', imgBytes], ['s-vol', 'Volumes', volBytes], ['s-cache', 'Build cache', cacheBytes], ['s-ctr', 'Containers', ctrBytes]] as const).map(([cls, label, n]) => (
            <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span className={`sw ${cls}`} />{label} {dfLabel(n)}</span>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        <div className="card" style={{ flex: '1 1 340px', padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className="h2">{t("Projects")}</h2>
            <button className="linkbtn" onClick={() => s.setView('projects')}>{t("View all")}</button>
          </div>
          {s.projects.length === 0 && <div className="empty" style={{ padding: '16px 0' }}>{t("No projects yet. Add a folder with a docker-compose.yml or Dockerfile.")}</div>}
          {s.projects.slice(0, 5).map((p) => {
            const st = projectStatus(p, s.containers);
            return (
              <button key={p.id} onClick={() => s.openModal({ kind: 'files', projectId: p.id })} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', border: 0, borderTop: '1px solid #222731', background: 'none', color: '#E6E8EE', textAlign: 'left', width: '100%' }}>
                <span className={st.up > 0 ? 'dot run' : 'dot'} />
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontWeight: 500 }}>{p.name}</span>
                  <span className="mono muted ell" style={{ fontSize: 12 }}>{shortPath(p.path)}</span>
                </span>
                <span className="muted" style={{ fontSize: 12 }}>{st.hasCompose ? t("{up}/{total} running", { up: st.up, total: st.total }) : 'Dockerfile'}</span>
              </button>
            );
          })}
        </div>
        <div className="card" style={{ flex: '1 1 340px', padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 className="h2">{t("Recent events")}</h2>
          {s.events.length === 0 && <div className="empty" style={{ padding: '16px 0' }}>{t("No events yet.")}</div>}
          {s.events.slice(0, 8).map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '8px 0', borderTop: '1px solid #222731', fontSize: 13 }}>
              <span className="mono muted" style={{ width: 46, flex: 'none' }}>{e.time}</span>
              <span className={`tag ${e.kind}`}>{e.kind}</span>
              <span style={{ color: '#C9D0DC', minWidth: 0 }}>{e.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
