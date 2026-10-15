import { useEffect, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, inTauri, type ScanResult } from '../api';
import { useApp } from '../store';
import { maskEnv } from '../lib/env';
import { shortPath, withTag } from '../lib/ui';
import { Box, Check, Field, FileIcon, FolderIcon, Indeterminate, ModalFrame } from '../components/ui';
import { t } from '../i18n';

// ---------------------------------------------------------------- Add folder

export function AddModal({ path: initial }: { path?: string }) {
  const s = useApp();
  const [cands, setCands] = useState<{ path: string; name: string; tag: string }[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanErr, setScanErr] = useState('');
  const [scanning, setScanning] = useState(false);
  const [name, setName] = useState('');
  const [autoUp, setAutoUp] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.discover().then(setCands).catch(() => {}); }, []);

  const choose = async (path: string) => {
    setPick(path); setScan(null); setScanErr(''); setScanning(true);
    try {
      const r = await api.scan(path);
      setScan(r); setName(r.suggestedName);
    } catch (e) {
      setScanErr((e as Error).message);
    } finally {
      setScanning(false);
    }
  };
  const first = useRef(true);
  useEffect(() => { if (first.current && initial) { first.current = false; void choose(initial); } }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const browse = async () => {
    if (!inTauri) return;
    const p = await openDialog({ directory: true, multiple: false, title: t("Choose project folder") });
    if (typeof p === 'string') void choose(p);
  };

  const exists = scan ? s.projects.some((p) => p.path === scan.path) : false;
  const noDocker = scan ? !scan.composeFile && !scan.hasDockerfile : false;
  const warn = scanErr || (exists ? t("This folder is already in the list.") : noDocker ? t("No compose file or Dockerfile found in this folder.") : scan?.warning ?? '');
  const disabled = !scan || exists || noDocker || !name.trim() || busy;

  const confirm = async () => {
    if (!scan) return;
    setBusy(true);
    try {
      const p = await api.projectAdd(name.trim(), scan.path);
      s.closeModal();
      await s.refresh('projects');
      s.setView('projects');
      s.toast(t("Added project {name}", { name: p.name }));
      s.ev('create', t("Remembered folder {v0}", { v0: shortPath(p.path) }));
      if (autoUp && p.services.length) void s.composeRun(p.id, 'up');
    } catch (e) {
      s.toast((e as Error).message, 'err');
      setBusy(false);
    }
  };

  const list = [...(pick && !cands.some((c) => c.path === pick) ? [{ path: pick, name: pick.split(/[\\/]/).pop() ?? pick, tag: scan ? (scan.composeFile ? 'compose' : scan.hasDockerfile ? 'Dockerfile' : t("no Docker")) : '…' }] : []), ...cands];

  return (
    <ModalFrame title={t("Add project folder")} onClose={s.closeModal} large footer={<><button className="btn" onClick={s.closeModal}>{t("Cancel")}</button><button className="btn pri" disabled={disabled} onClick={() => void confirm()}>{t("Add project")}</button></>}>
      <div className="mb" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 18 }}>
        <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 13 }}>{t("Recent folders on this machine")}</span>
            <button className="btn sm" onClick={() => void browse()}>{t("Browse…")}</button>
          </div>
          {list.length === 0 && <div className="muted" style={{ fontSize: 13 }}>{t("No folders found in ~/code, ~/Sources, ~/dev… Press “Browse…” to choose one.")}</div>}
          {list.map((cd) => (
            <button key={cd.path} className={`pick${pick === cd.path ? ' on' : ''}`} onClick={() => void choose(cd.path)}>
              <FolderIcon size={18} />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 500 }}>{cd.name}</span>
                <span className="mono muted ell" style={{ fontSize: 12 }}>{shortPath(cd.path)}</span>
              </span>
              <span className="tag" style={{ alignSelf: 'center' }}>{s.projects.some((p) => p.path === cd.path) ? t("added") : cd.tag}</span>
            </button>
          ))}
        </div>
        <div style={{ flex: '1 1 300px', background: '#12151B', border: '1px solid #242935', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {!pick && <div className="empty" style={{ padding: '40px 10px' }}>{t("Pick a folder on the left to see what the app detects.")}</div>}
          {scanning && <><span className="muted" style={{ fontSize: 13 }}>{t("Reading compose…")}</span><Indeterminate /></>}
          {scan && (
            <>
              <Field label={t("Display name")}><input className="inp" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <div>
                <div className="kv"><span className="muted">Compose file</span><span>{scan.composeFile ?? t("none")}</span></div>
                <div className="kv"><span className="muted">Dockerfile</span><span>{scan.hasDockerfile ? t("yes") : t("none")}</span></div>
                <div className="kv"><span className="muted">Services</span><span>{scan.services.length ? scan.services.map((x) => x.name).join(', ') : '—'}</span></div>
              </div>
              {warn && <Box kind="warn">{warn}</Box>}
              <Check checked={autoUp} onChange={setAutoUp}>{t("Run compose up right after adding")}</Check>
            </>
          )}
          {!scan && warn && <Box kind="warn">{warn}</Box>}
        </div>
      </div>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- Browse / edit project files

export function FilesModal({ projectId }: { projectId: string }) {
  const s = useApp();
  const p = s.projects.find((x) => x.id === projectId);
  const [files, setFiles] = useState<{ name: string; isDir: boolean }[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [orig, setOrig] = useState('');
  const [text, setText] = useState('');
  const [reveal, setReveal] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.projectFiles(projectId).then((f) => { setFiles(f); setSel(f[0]?.name ?? null); }).catch((e) => setErr(e.message));
  }, [projectId]);
  useEffect(() => {
    if (!sel) return;
    setReveal(false); setErr('');
    api.projectRead(projectId, sel).then((t) => { setOrig(t); setText(t); }).catch((e) => { setOrig(''); setText(''); setErr(e.message); });
  }, [projectId, sel]);

  if (!p) return null;
  const file = files.find((f) => f.name === sel);
  const isEnv = sel === '.env';
  const masked = isEnv && !reveal;
  const editable = !!file && !file.isDir && !masked && !err;
  const dirty = editable && text !== orig;
  const fail = (e: unknown) => s.toast((e as Error).message, 'err');

  const save = async () => {
    if (!sel) return;
    try {
      await api.projectWrite(projectId, sel, text);
      setOrig(text);
      s.toast(t("Saved {sel}", { sel }));
      if (sel === p.composeFile || isEnv) {
        await api.projectRefresh(projectId);
        await s.refresh('projects');
        if (p.composeFile) {
          s.ask({ title: t("Compose up to apply?"), body: t("Saved {sel}. Run docker compose up -d so containers use the new configuration?", { sel }), yes: 'Compose up', action: () => s.composeRun(projectId, 'up') });
        }
      }
    } catch (e) {
      fail(e);
    }
  };

  return (
    <ModalFrame
      title={p.name}
      sub={<span className="mono muted ell" style={{ fontSize: 12 }}>{shortPath(p.path)}</span>}
      onClose={s.closeModal}
      large
      footer={
        <>
          <button className="btn" onClick={() => api.openTerminal(p.path).catch(fail)}>{t("Open terminal here")}</button>
          <button className="btn" onClick={() => api.openFolder(p.path).catch(fail)}>{t("Open in file manager")}</button>
          <button className="btn pri" onClick={() => api.openEditor(p.path).catch(fail)}>{t("Open with VS Code")}</button>
        </>
      }
    >
      <div className="mb" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
        <div style={{ flex: '1 1 200px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {files.map((f) => (
            <button key={f.name} className={`frow${sel === f.name ? ' on' : ''}`} onClick={() => setSel(f.name)}>
              {f.isDir ? <FolderIcon /> : <FileIcon />}
              <span className="ell">{f.name}</span>
            </button>
          ))}
        </div>
        <div style={{ flex: '3 1 380px', minWidth: 0, display: 'flex', flexDirection: 'column', border: '1px solid #242935', borderRadius: 10, overflow: 'hidden' }}>
          <div className="mono muted" style={{ padding: '8px 14px', fontSize: 12, borderBottom: '1px solid #242935', background: '#12151B', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 1 }}>{sel}{dirty ? ' •' : ''}</span>
            {isEnv && <button className="btn sm" style={{ height: 26 }} onClick={() => setReveal(!reveal)}>{reveal ? t("Hide sensitive values") : t("Show sensitive values")}</button>}
            {dirty && <button className="btn sm pri" style={{ height: 26 }} onClick={() => void save()}>{t("Save")}</button>}
          </div>
          {err ? (
            <div className="empty">{err}</div>
          ) : editable ? (
            <textarea className="editor" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
          ) : (
            <pre className="term" style={{ margin: 0, padding: 14, minHeight: 260, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre' }}>{masked ? maskEnv(text) : text}</pre>
          )}
        </div>
      </div>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- Build image

export function BuildModal({ projectId }: { projectId?: string }) {
  const s = useApp();
  const opts = s.projects.filter((p) => p.hasDockerfile);
  const [proj, setProj] = useState(projectId ?? opts[0]?.id ?? '');
  const cur = s.projects.find((p) => p.id === proj);
  const [tag, setTag] = useState(cur ? `${cur.composeProject}:latest` : '');
  const [nocache, setNocache] = useState(false);
  const b = s.build;
  const running = !!b && !b.done && !b.error;
  const logRef = useRef<HTMLDivElement>(null);
  void logRef;

  const pickProj = (id: string) => {
    setProj(id);
    const p = s.projects.find((x) => x.id === id);
    if (p) setTag(`${p.composeProject}:latest`);
  };

  return (
    <ModalFrame
      title={t("Build image from Dockerfile")} onClose={s.closeModal} maxWidth={680}
      footer={
        !b ? (
          <><button className="btn" onClick={s.closeModal}>{t("Cancel")}</button><button className="btn pri" disabled={!proj || !tag.trim()} onClick={() => void s.startBuild(proj, tag, nocache)}>Build</button></>
        ) : (
          <><button className="btn" disabled={running} onClick={s.resetBuild}>{t("Build again")}</button><button className="btn pri" onClick={s.closeModal}>{running ? t("Run in background") : t("Close")}</button></>
        )
      }
    >
      <div className="mb">
        {!b ? (
          <>
            <div className="lbl">{t("Project (build context)")}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {opts.map((p) => <button key={p.id} className={`optc${proj === p.id ? ' on' : ''}`} onClick={() => pickProj(p.id)}>{p.name}</button>)}
              </div>
              {opts.length === 0 && <span className="box warn">{t("No project has a Dockerfile yet. Add a folder first.")}</span>}
            </div>
            <Field label="Tag"><input className="inp mono" placeholder="myapp:latest" value={tag} onChange={(e) => setTag(e.target.value)} /></Field>
            <Check checked={nocache} onChange={setNocache}>{t("Don't use cache (--no-cache)")}</Check>
            {tag.trim() && <span className="muted mono" style={{ fontSize: 12 }}>docker build -t {withTag(tag)}{nocache ? ' --no-cache' : ''} {cur ? shortPath(cur.path) : ''}</span>}
          </>
        ) : (
          <>
            <div className="term scrollbox" style={{ height: 300, padding: '12px 14px', borderRadius: 8 }}>
              <div>{b.lines.map((l, i) => <div key={i} className="tl out">{l}</div>)}</div>
            </div>
            {running && <Indeterminate />}
            {b.done && <Box kind="ok">{t("Build succeeded:")} {b.tag}</Box>}
            {b.error && <Box kind="err">{t("Build failed:")} {b.error}</Box>}
          </>
        )}
      </div>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- Rename project

export function RenameModal({ projectId }: { projectId: string }) {
  const s = useApp();
  const p = s.projects.find((x) => x.id === projectId);
  const [name, setName] = useState(p?.name ?? '');
  if (!p) return null;
  const submit = async () => {
    const n = name.trim();
    if (!n) { s.toast(t("Please enter a project name"), 'err'); return; }
    if (n === p.name) { s.closeModal(); return; }
    try {
      await api.projectRename(p.id, n);
      s.closeModal();
      await s.refresh('projects');
      s.toast(t("Renamed to {n}", { n }));
    } catch (e) {
      s.toast((e as Error).message, 'err');
    }
  };
  return (
    <ModalFrame title={t("Rename project")} onClose={s.closeModal} maxWidth={440} footer={<><button className="btn" onClick={s.closeModal}>{t("Cancel")}</button><button className="btn pri" onClick={() => void submit()}>{t("Save")}</button></>}>
      <div className="mb">
        <Field label={t("Display name")}>
          <input className="inp" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        </Field>
        <span className="muted" style={{ fontSize: 12.5 }}>{t("Only renames inside the app. The folder and containers (Compose project “")}{p.composeProject}{t("”) stay unchanged.")}</span>
      </div>
    </ModalFrame>
  );
}
