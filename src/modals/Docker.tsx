import { useEffect, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { api, inTauri, type ImageDetail, type NetDetail, type VolFile } from '../api';
import { useApp } from '../store';
import { fmtBytes, relTime, shortId } from '../lib/format';
import { imgRef, runCommand, splitList } from '../lib/ui';
import { Box, Check, DrawerFrame, Field, FileIcon, FolderIcon, KV, ModalFrame } from '../components/ui';
import { t } from '../i18n';

// ---------------------------------------------------------------- Run new container

export function RunModal({ image }: { image?: string }) {
  const s = useApp();
  const tagged = s.images.filter((i) => !i.dangling).map((i) => `${i.repo}:${i.tag}`);
  const uniq = [...new Set(tagged)];
  const [f, setF] = useState({ image: image ?? uniq[0] ?? '', cname: '', port: '', vol: '', env: '', restart: 'unless-stopped', startNow: true });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });

  const submit = async () => {
    if (!s.engineOk()) return;
    if (!f.image) { s.toast(t("Please choose an image"), 'err'); return; }
    const base = f.image.split(':')[0].split('/').pop() ?? 'container';
    const name = f.cname.trim() || `${base}-${Math.random().toString(36).slice(2, 6)}`;
    if (s.containers.some((c) => c.name === name)) { s.toast(t("Container name \"{name}\" already exists", { name }), 'err'); return; }
    setBusy(true);
    try {
      const r = await api.create({
        image: f.image, name, ports: splitList(f.port), binds: splitList(f.vol),
        env: f.env.split('\n').map((x) => x.trim()).filter(Boolean), restart: f.restart, start: f.startNow,
      });
      s.closeModal();
      useApp.setState({ view: 'containers', selected: r.id, tab: 'logs', cq: '', onlyRunning: false });
      s.toast(f.startNow ? t("{name} created and started", { name }) : t("Created {name}", { name }), f.startNow ? 'ok' : 'info');
      await Promise.all([s.refresh('containers'), s.refresh('volumes')]);
    } catch (e) {
      s.toast((e as Error).message, 'err');
      setBusy(false);
    }
  };

  return (
    <ModalFrame title={t("Run new container")} onClose={s.closeModal} maxWidth={640} footer={<><button className="btn" onClick={s.closeModal}>{t("Cancel")}</button><button className="btn pri" disabled={busy} onClick={() => void submit()}>{t("Create container")}</button></>}>
      <div className="mb">
        <div className="lbl">Image
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 110, overflow: 'auto' }}>
            {uniq.map((o) => <button key={o} className={`optc${f.image === o ? ' on' : ''}`} onClick={() => set({ image: o })}>{o}</button>)}
            {f.image && !uniq.includes(f.image) && <button className="optc on">{f.image}</button>}
          </div>
          {uniq.length === 0 && <span className="box warn">{t("No images yet. Pull an image first.")}</span>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <Field label={t("Container name")}><input className="inp" placeholder={t("leave empty = auto-generated")} value={f.cname} onChange={(e) => set({ cname: e.target.value })} /></Field>
          <Field label="Port (host:container)"><input className="inp mono" placeholder="8080:80" value={f.port} onChange={(e) => set({ port: e.target.value })} /></Field>
          <Field label="Volume mount"><input className="inp mono" placeholder="my-data:/data" value={f.vol} onChange={(e) => set({ vol: e.target.value })} /></Field>
          <Field label="Restart policy">
            <select className="inp" value={f.restart} onChange={(e) => set({ restart: e.target.value })}>
              {['no', 'always', 'unless-stopped', 'on-failure'].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
        </div>
        <Field label={t("Environment variables (one KEY=value per line)")}><textarea className="inp" placeholder="NODE_ENV=production" value={f.env} onChange={(e) => set({ env: e.target.value })} /></Field>
        <Check checked={f.startNow} onChange={(v) => set({ startNow: v })}>{t("Start right after creating")}</Check>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>{t("Equivalent command")}</span>
          <div className="term" style={{ padding: '10px 12px', borderRadius: 8, wordBreak: 'break-all' }}>{runCommand(f)}</div>
        </div>
      </div>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- Pull

const SUGGEST = ['nginx:alpine', 'node:22-alpine', 'mongo:7', 'mariadb:11', 'traefik:v3.1', 'minio/minio:latest'];

export function PullModal() {
  const s = useApp();
  const [img, setImg] = useState('');
  const p = s.pull;
  const active = !!p;
  const busy = !!p && !p.done && !p.error;
  const start = () => {
    if (!img.trim()) { s.toast(t("Enter an image name, e.g. nginx:alpine"), 'err'); return; }
    void s.startPull(img.trim());
  };
  const layers = p?.layers ?? [];
  return (
    <ModalFrame
      title="Pull image" onClose={s.closeModal}
      footer={
        !active ? (
          <><button className="btn" onClick={s.closeModal}>{t("Cancel")}</button><button className="btn pri" onClick={start}>Pull</button></>
        ) : (
          <><button className="btn" disabled={busy} onClick={s.resetPull}>{t("Pull another image")}</button><button className="btn pri" onClick={s.closeModal}>{busy ? t("Run in background") : t("Close")}</button></>
        )
      }
    >
      <div className="mb">
        {!active ? (
          <>
            <Field label={t("Image name (registry/repo:tag)")}><input className="inp mono" autoFocus placeholder="nginx:alpine" value={img} onChange={(e) => setImg(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') start(); }} /></Field>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>{t("Popular suggestions")}</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {SUGGEST.map((x) => <button key={x} className={`optc${img === x ? ' on' : ''}`} onClick={() => setImg(x)}>{x}</button>)}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="mono" style={{ fontSize: 14 }}>{p.image}</div>
            {layers.length === 0 && !p.error && <span className="muted" style={{ fontSize: 13 }}>{p.note || t("Connecting to registry…")}</span>}
            {layers.map((l) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12.5 }}>
                <span className="mono muted" style={{ width: 100, flex: 'none' }}>{shortId(l.id)}</span>
                <span style={{ width: 100, flex: 'none', color: '#C9D0DC' }}>{l.status}</span>
                <div className="bar"><span style={{ width: `${l.pct}%` }} /></div>
                <span className="mono" style={{ width: 40, textAlign: 'right', flex: 'none' }}>{Math.round(l.pct)}%</span>
              </div>
            ))}
            {p.done && <Box kind="ok">{t("Done. The image is now in the Images list.")}</Box>}
            {p.error && <Box kind="err">{p.error}</Box>}
          </>
        )}
      </div>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- Image drawer

export function ImageDrawer({ imageRef }: { imageRef: string }) {
  const s = useApp();
  const im = s.images.find((i) => imgRef(i) === imageRef || i.id === imageRef);
  const [d, setD] = useState<ImageDetail | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!im) return;
    api.imageDetail(im.id).then(setD).catch((e) => setErr(e.message));
  }, [im?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!im) return null;
  const users = s.containers.filter((c) => c.imageId === im.id);
  return (
    <DrawerFrame
      eyebrow="Image" title={imgRef(im)} onClose={s.closeModal}
      footer={
        <>
          <button className="btn" onClick={() => navigator.clipboard.writeText(im.id).then(() => s.toast(t("Image ID copied"), 'info'))}>{t("Copy ID")}</button>
          <button className="btn" disabled={im.dangling} onClick={() => s.openModal({ kind: 'run', image: `${im.repo}:${im.tag}` })}>{t("Run container")}</button>
          <button className="btn dan" disabled={users.length > 0} onClick={() => { s.removeImage(im); }}>{t("Delete image")}</button>
        </>
      }
    >
      <div className="mb">
        <div>
          <KV k="Image ID" v={shortId(im.id)} />
          <KV k="Size" v={fmtBytes(im.size)} />
          <KV k={t("Created at")} v={relTime(im.created)} />
          <KV k={t("Used by")} v={users.length ? users.map((u) => u.name).join(', ') : t("None")} />
          <KV k={t("Architecture")} v={d ? `${d.os}/${d.architecture}` : '…'} />
        </div>
        <h3 className="h2" style={{ fontSize: 14 }}>{t("Layer history")}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid #242935', borderRadius: 10, overflow: 'hidden' }}>
          {err && <div className="empty">{err}</div>}
          {!d && !err && <div className="empty">{t("Loading…")}</div>}
          {d?.layers.map((ly, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '9px 12px', borderBottom: '1px solid #1F242D', fontSize: 12.5 }}>
              <span className="mono ell" style={{ flex: 1, color: '#C9D0DC' }} title={ly.cmd}>{ly.cmd || t("(no command)")}</span>
              <span className="mono muted" style={{ flex: 'none' }}>{fmtBytes(ly.size)}</span>
            </div>
          ))}
        </div>
        {users.length > 0 && <Box kind="info">{t("This image is in use by a container and cannot be deleted. Remove the container first.")}</Box>}
      </div>
    </DrawerFrame>
  );
}

// ---------------------------------------------------------------- Networks

export function NetCreateModal() {
  const s = useApp();
  const [f, setF] = useState({ name: '', driver: 'bridge', subnet: '' });
  const submit = async () => {
    if (!s.engineOk()) return;
    const n = f.name.trim();
    if (!n) { s.toast(t("Enter a network name"), 'err'); return; }
    if (s.networks.some((x) => x.name === n)) { s.toast(t("Network already exists"), 'err'); return; }
    try {
      await api.networkCreate(n, f.driver, f.subnet.trim() || undefined);
      s.closeModal();
      s.toast(t("Created network {n}", { n }));
      await s.refresh('networks');
    } catch (e) {
      s.toast((e as Error).message, 'err');
    }
  };
  return (
    <ModalFrame title={t("Create network")} onClose={s.closeModal} maxWidth={480} footer={<><button className="btn" onClick={s.closeModal}>{t("Cancel")}</button><button className="btn pri" onClick={() => void submit()}>{t("Create")}</button></>}>
      <div className="mb">
        <Field label={t("Network name")}><input className="inp mono" autoFocus placeholder="my-network" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Driver">
          <select className="inp" value={f.driver} onChange={(e) => setF({ ...f, driver: e.target.value })}>
            {['bridge', 'overlay', 'macvlan', 'ipvlan'].map((d) => <option key={d}>{d}</option>)}
          </select>
        </Field>
        <Field label={t("Subnet (optional)")}><input className="inp mono" placeholder="172.30.0.0/16" value={f.subnet} onChange={(e) => setF({ ...f, subnet: e.target.value })} /></Field>
      </div>
    </ModalFrame>
  );
}

export function NetDrawer({ id }: { id: string }) {
  const s = useApp();
  const row = s.networks.find((n) => n.id === id);
  const [d, setD] = useState<NetDetail | null>(null);
  const [err, setErr] = useState('');
  const [connecting, setConnecting] = useState(false);
  const load = () => api.networkInspect(id).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!row) return null;
  const attachedNames = new Set(s.containers.filter((c) => c.networks.includes(row.name)).map((c) => c.name));
  const items = d?.containers ?? [];
  const connectable = s.containers.filter((c) => !attachedNames.has(c.name));
  const used = attachedNames.size > 0;
  return (
    <DrawerFrame
      eyebrow="Network" title={row.name} onClose={s.closeModal}
      footer={
        <>
          <button className="btn" disabled={row.system || connectable.length === 0} onClick={() => setConnecting(!connecting)}>{t("Connect container…")}</button>
          <button className="btn dan" disabled={row.system || used} onClick={() => { s.removeNetwork(row); }}>{t("Delete network")}</button>
        </>
      }
    >
      <div className="mb">
        <div>
          <KV k="Driver" v={row.driver} />
          <KV k="Subnet" v={d?.subnet ?? row.subnet} />
          <KV k="Gateway" v={d?.gateway ?? row.gateway} />
          <KV k="Scope" v={row.scope} />
        </div>
        <h3 className="h2" style={{ fontSize: 14 }}>{t("Connected containers")}</h3>
        {err && <Box kind="err">{err}</Box>}
        {d && items.length === 0 && !used && !row.system && <Box kind="warn">{t("No containers connected. This network can be pruned.")}</Box>}
        {items.map((it) => (
          <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid #222731' }}>
            <span className="dot run" />
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span className="ell">{it.name}</span>
              <span className="mono muted" style={{ fontSize: 12 }}>{it.ip}</span>
            </span>
            <button className="btn sm" onClick={async () => {
              try { await api.networkDisconnect(row.name, it.id); s.toast(t("Disconnected {name} from {name1}", { name: it.name, name1: row.name })); await Promise.all([load(), s.refresh('containers')]); }
              catch (e) { s.toast((e as Error).message, 'err'); }
            }}>{t("Disconnect")}</button>
          </div>
        ))}
        {connecting && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="muted" style={{ fontSize: 13 }}>{t("Choose a container to connect")}</span>
            {connectable.map((c) => (
              <button key={c.id} className="pick" onClick={async () => {
                try { await api.networkConnect(row.name, c.id); s.toast(t("Connected {name} to {name1}", { name: c.name, name1: row.name })); setConnecting(false); await Promise.all([load(), s.refresh('containers')]); }
                catch (e) { s.toast((e as Error).message, 'err'); }
              }}>{c.name}</button>
            ))}
          </div>
        )}
      </div>
    </DrawerFrame>
  );
}

// ---------------------------------------------------------------- Volumes

export function VolCreateModal() {
  const s = useApp();
  const [name, setName] = useState('');
  const [restore, setRestore] = useState('');
  const [backups, setBackups] = useState<{ name: string; size: number }[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.backups().then(setBackups).catch(() => {}); }, []);
  const submit = async () => {
    if (!s.engineOk()) return;
    const n = name.trim();
    if (!n) { s.toast(t("Enter a volume name"), 'err'); return; }
    if (s.volumes.some((v) => v.name === n)) { s.toast(t("Volume already exists"), 'err'); return; }
    setBusy(true);
    try {
      await api.volumeCreate(n);
      if (restore) await api.volumeRestore(n, restore);
      s.closeModal();
      s.toast(restore ? t("Created {n} and restored data from backup", { n }) : t("Created volume {n}", { n }));
      await Promise.all([s.refresh('volumes'), s.refresh('df')]);
    } catch (e) {
      s.toast((e as Error).message, 'err');
      setBusy(false);
    }
  };
  return (
    <ModalFrame title={t("Create volume")} onClose={s.closeModal} maxWidth={440} footer={<><button className="btn" onClick={s.closeModal}>{t("Cancel")}</button><button className="btn pri" disabled={busy} onClick={() => void submit()}>{busy ? t("Creating…") : t("Create")}</button></>}>
      <div className="mb">
        <Field label={t("Volume name")}><input className="inp mono" autoFocus placeholder="app-data" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t("Restore from backup (optional)")}>
          <select className="inp" value={restore} onChange={(e) => setRestore(e.target.value)}>
            <option value="">{t("No, create an empty volume")}</option>
            {backups.map((b) => <option key={b.name} value={b.name}>{b.name} ({fmtBytes(b.size)})</option>)}
          </select>
        </Field>
      </div>
    </ModalFrame>
  );
}

export function VolDrawer({ name }: { name: string }) {
  const s = useApp();
  const v = s.volumes.find((x) => x.name === name);
  const [path, setPath] = useState('');
  const [files, setFiles] = useState<VolFile[] | null>(null);
  const [err, setErr] = useState('');
  const [fileSel, setFileSel] = useState<VolFile | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [backups, setBackups] = useState<{ name: string; size: number }[]>([]);
  const [pickBackup, setPickBackup] = useState('');

  useEffect(() => {
    setFiles(null); setErr(''); setFileSel(null);
    api.volumeFiles(name, path || undefined).then(setFiles).catch((e) => setErr(e.message));
  }, [name, path]);

  if (!v) return null;
  const owners = s.containers.filter((c) => c.mounts.some((m) => m.type === 'volume' && m.name === name));
  const size = s.df?.volumes.find((x) => x.name === name)?.size;
  const sorted = [...(files ?? [])].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  const crumbs = path ? path.split('/') : [];
  const full = (f: VolFile) => (path ? `${path}/${f.name}` : f.name);

  const download = async () => {
    if (!fileSel || !inTauri) return;
    const dest = await save({ defaultPath: fileSel.name });
    if (!dest) return;
    try { await api.volumeDownload(name, full(fileSel), dest); s.toast(t("Downloaded {name}", { name: fileSel.name }), 'info'); }
    catch (e) { s.toast((e as Error).message, 'err'); }
  };
  const openRestore = async () => {
    setRestoring(!restoring);
    if (!restoring) { const b = await api.backups().catch(() => []); setBackups(b); setPickBackup(b[0]?.name ?? ''); }
  };
  const doRestore = async () => {
    try {
      await api.volumeRestore(name, pickBackup);
      s.toast(t("Restored {name} from {pickBackup}", { name, pickBackup }));
      setRestoring(false); setPath('');
      await s.refresh('df');
    } catch (e) { s.toast((e as Error).message, 'err'); }
  };

  return (
    <DrawerFrame
      eyebrow="Volume" title={name} onClose={s.closeModal}
      footer={
        <>
          <button className="btn" onClick={() => void openRestore()}>{t("Restore…")}</button>
          <button className="btn" disabled={!!s.backingUp[name]} onClick={() => void s.backupVolume(name)}>{s.backingUp[name] ? t("Backing up…") : 'Backup ra .tar.gz'}</button>
          <button className="btn dan" disabled={owners.length > 0} onClick={() => s.removeVolume(name, size)}>{t("Delete volume")}</button>
        </>
      }
    >
      <div className="mb">
        <div>
          <KV k="Size" v={size != null && size >= 0 ? fmtBytes(size) : '—'} />
          <KV k={t("Used by")} v={owners.length ? owners.map((o) => o.name).join(', ') : t("Unused")} />
          <KV k="Mountpoint" v={v.mountpoint} />
        </div>
        {restoring && (
          <div className="box info" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {backups.length === 0 ? t("No backup files in ~/docker-backups yet.") : (
              <>
                <span>{t("Extract the backup into the volume (overwrites files with the same name):")}</span>
                <select className="inp" value={pickBackup} onChange={(e) => setPickBackup(e.target.value)}>{backups.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</select>
                <button className="btn sm" style={{ alignSelf: 'start' }} onClick={() => void doRestore()}>{t("Restore")}</button>
              </>
            )}
          </div>
        )}
        <h3 className="h2" style={{ fontSize: 14 }}>{t("Contents")}</h3>
        <div className="mono muted" style={{ fontSize: 12, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button className="linkbtn" style={{ padding: 0 }} onClick={() => setPath('')}>/</button>
          {crumbs.map((c, i) => <span key={i}><button className="linkbtn" style={{ padding: 0 }} onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button>/</span>)}
        </div>
        <div style={{ border: '1px solid #242935', borderRadius: 10, padding: 6 }}>
          {!files && !err && <div className="empty">{t("Reading volume… (the first time may need to download the alpine image)")}</div>}
          {err && <div className="empty">{err}</div>}
          {files && files.length === 0 && <div className="empty">{path ? t("Folder is empty.") : t("Volume is empty.")}</div>}
          {sorted.map((f) => (
            <button key={f.name} className={`frow${fileSel?.name === f.name ? ' on' : ''}`} onClick={() => (f.isDir ? setPath(full(f)) : setFileSel(f))}>
              {f.isDir ? <FolderIcon /> : <FileIcon />}
              <span className="ell" style={{ flex: 1 }}>{f.name}{f.isDir ? '/' : ''}</span>
              <span className="muted">{f.isDir ? '' : fmtBytes(f.size)}</span>
            </button>
          ))}
        </div>
        {fileSel && (
          <div className="box info" style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
            <span className="mono">{fileSel.name} · {fmtBytes(fileSel.size)} {t("· modified")} {relTime(fileSel.mtime)}</span>
            <button className="btn sm" onClick={() => void download()}>{t("Download")}</button>
          </div>
        )}
        {owners.some((o) => o.state === 'running') && <Box kind="warn">{t("The volume is being written by a container. Stop the container before backing up for consistent data.")}</Box>}
      </div>
    </DrawerFrame>
  );
}
