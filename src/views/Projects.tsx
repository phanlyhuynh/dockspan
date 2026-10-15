import { useEffect, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { api, inTauri, type Project } from '../api';
import { useApp } from '../store';
import { projectStatus } from '../lib/projects';
import { dotClass, relDay, shortPath } from '../lib/ui';
import { Icon, ICONS, Indeterminate, PageHead } from '../components/ui';
import { t } from '../i18n';

function ProjectCard({ p }: { p: Project }) {
  const s = useApp();
  const [menu, setMenu] = useState(false);
  const st = projectStatus(p, s.containers);
  const busy = s.busy[`p:${p.id}`];
  const line = s.projectLine[p.id];
  const fail = (e: unknown) => s.toast((e as Error).message, 'err');

  const primary = () => {
    if (!st.hasCompose) return s.openModal({ kind: 'build', projectId: p.id });
    void s.composeRun(p.id, st.up > 0 ? 'stop' : 'up');
  };
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'start', gap: 12 }}>
        <button className="cellbtn" title={t("View project containers")} aria-label={t("View containers of {name}", { name: p.name })} onClick={() => s.showProjectContainers(p.composeProject)} style={{ flex: 1, alignItems: 'start', gap: 12, minHeight: 0 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: '#1F2531', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
            <Icon d={ICONS.projects} size={20} stroke="#7FB0FF" sw={1.8} />
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="nm" style={{ fontWeight: 600, fontSize: 15 }}>{p.name}</span>
            <span className="mono muted ell" style={{ fontSize: 12, fontWeight: 400 }} title={p.path}>{shortPath(p.path)}</span>
          </div>
        </button>
        <span className={st.pillCls}>{st.label}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minHeight: 26 }}>
        {st.svcs.map((sv) => (
          <span key={sv.name} className="chip"><span className={sv.state ? dotClass(sv.state) : 'dot ghost'} />{sv.name}</span>
        ))}
        {!st.hasCompose && <span className="muted" style={{ fontSize: 13 }}>{t("No compose file — build an image from the Dockerfile only")}</span>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, color: '#8F98A8' }}>
        <span className="ell">{st.hasCompose ? `${p.composeFile} · ${st.total} services` : 'Dockerfile'}</span>
        <span style={{ flex: 'none' }}>{t("Last opened:")} {relDay(p.lastOpenedAt)}</span>
      </div>
      {busy && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="mono ell" style={{ fontSize: 12, color: '#F0C47A' }}>{line ? line : busy}</span>
          <Indeterminate />
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button className={st.hasCompose && st.up > 0 ? 'btn sm' : 'btn sm pri'} disabled={!!busy} onClick={primary}>
          {!st.hasCompose ? 'Build image' : st.up > 0 ? 'Stop' : 'Start'}
        </button>
        {st.hasCompose && <button className="btn sm" disabled={!!busy} onClick={() => void s.composeRun(p.id, 'restart')}>Restart</button>}
        <button className="btn sm" onClick={() => s.openModal({ kind: 'files', projectId: p.id })}>{t("Open folder")}</button>
        <button className="btn sm" onClick={() => api.openEditor(p.path).catch(fail)}>VS Code</button>
        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <button className="ib" aria-label={t("More options")} onClick={() => setMenu(!menu)}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
          </button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <button className="mi" onClick={() => { setMenu(false); s.openModal({ kind: 'rename', projectId: p.id }); }}>{t("Rename project…")}</button>
              <button className="mi" onClick={() => { setMenu(false); api.openTerminal(p.path).catch(fail); }}>{t("Open terminal in folder")}</button>
              <button className="mi" onClick={() => { setMenu(false); s.showProjectContainers(p.composeProject); }}>{t("View project containers")}</button>
              <button className="mi" onClick={() => { setMenu(false); s.openModal({ kind: 'build', projectId: p.id }); }}>Build image…</button>
              {st.hasCompose && <button className="mi dan" onClick={() => { setMenu(false); s.composeDown(p.id); }}>{t("Compose down (remove containers)")}</button>}
              <button className="mi dan" onClick={() => { setMenu(false); s.forgetProject(p.id); }}>{t("Forget this folder")}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Projects() {
  const projects = useApp((s) => s.projects);
  const openModal = useApp((s) => s.openModal);
  const [drag, setDrag] = useState(false);

  // Dropping a folder onto the window = open the Add modal with that folder.
  useEffect(() => {
    if (!inTauri) return;
    let un: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((e) => {
      const t = e.payload.type;
      if (t === 'enter' || t === 'over') setDrag(true);
      else if (t === 'leave') setDrag(false);
      else if (t === 'drop') {
        setDrag(false);
        const path = e.payload.paths[0];
        if (path) openModal({ kind: 'add', path });
      }
    }).then((f) => { un = f; });
    return () => un?.();
  }, [openModal]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHead title={t("Projects")} sub={t("Remembered folders, with docker-compose.yml and Dockerfile detected automatically")}>
        <button className="btn pri" onClick={() => openModal({ kind: 'add' })}><Icon d={ICONS.plus} />{t("Add folder")}</button>
      </PageHead>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 14 }}>
        {projects.map((p) => <ProjectCard key={p.id} p={p} />)}
        <button onClick={() => openModal({ kind: 'add' })} className={drag ? 'filedrop' : ''} style={{ minHeight: 230, borderRadius: 12, border: '1.5px dashed #2F3644', background: 'transparent', color: '#8F98A8', fontSize: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <Icon d={ICONS.plus} size={24} sw={1.8} />
          {t("Drag a folder here or click to choose")}
        </button>
      </div>
    </div>
  );
}
