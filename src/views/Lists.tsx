import { useEffect } from 'react';
import { useApp } from '../store';
import { fmtBytes, relTime, shortId } from '../lib/format';
import { imgRef } from '../lib/ui';
import { IconBtn, ICONS, PageHead } from '../components/ui';
import { t } from '../i18n';

// ---------------------------------------------------------------- Images

const IMG_COLS = '2fr 1fr 1.1fr 0.8fr 1fr 1.5fr 0.8fr';

export function Images() {
  const s = useApp();
  const dangling = s.images.filter((i) => i.dangling).length;
  const unique = new Set(s.images.map((i) => i.id)).size;
  const total = s.df?.imagesSize;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHead title="Images" sub={`${unique} images${total != null ? ` · ${fmtBytes(total)}` : ''} · ${dangling} dangling`}>
        <button className="btn" onClick={() => s.openModal({ kind: 'build' })}>{t("Build from Dockerfile")}</button>
        <button className="btn pri" onClick={() => s.openModal({ kind: 'pull' })}>Pull image</button>
      </PageHead>
      <div className="card" style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 860 }}>
          <div className="th" style={{ gridTemplateColumns: IMG_COLS }}>
            <span>Repository</span><span>Tag</span><span>Image ID</span><span>Size</span><span>{t("Created at")}</span><span>{t("Usage")}</span><span style={{ textAlign: 'right' }}>{t("Actions")}</span>
          </div>
          {s.images.length === 0 && <div className="empty">{t("No images yet. Pull an image or build from a Dockerfile.")}</div>}
          {s.images.map((im) => {
            // Compare Image/ImageID of every container (even stopped ones) to know whether the image is in use.
            const users = s.containers.filter((c) => c.imageId === im.id && (im.dangling || c.image === `${im.repo}:${im.tag}` || c.image === im.repo || c.image === im.id || c.image.startsWith('sha256:')));
            const names = users.map((u) => u.name);
            return (
              <div key={`${im.id}-${im.repo}-${im.tag}`} className="tr" style={{ gridTemplateColumns: IMG_COLS }}>
                <button className="cellbtn" onClick={() => s.openModal({ kind: 'image', ref: imgRef(im) === '<none>:<none>' ? im.id : imgRef(im) })}><span className="nm ell">{im.repo}</span></button>
                <span className="mono ell" style={{ fontSize: 12.5, color: '#C9D0DC' }}>{im.tag}</span>
                <span className="mono muted" style={{ fontSize: 12.5 }}>{shortId(im.id)}</span>
                <span className="mono" style={{ fontSize: 12.5 }}>{fmtBytes(im.size)}</span>
                <span className="muted" style={{ fontSize: 13 }}>{relTime(im.created)}</span>
                <span className={names.length ? '' : im.dangling ? 'warn' : 'muted'} style={{ fontSize: 13 }}>{names.length ? names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '') : im.dangling ? 'Dangling' : t("Unused")}</span>
                <span style={{ display: 'flex', justifyContent: 'end', gap: 6 }}>
                  <button className="ib" aria-label={t("Run container from image")} title={t("Run container from image")} disabled={im.dangling} onClick={() => s.openModal({ kind: 'run', image: `${im.repo}:${im.tag}` })}>
                    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z" /></svg>
                  </button>
                  <IconBtn icon={ICONS.trash} label={t("Delete image")} disabled={names.length > 0} onClick={() => s.removeImage(im)} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Networks

const NET_COLS = '1.6fr 0.8fr 1.2fr 0.7fr 2.2fr 0.5fr';

export function Networks() {
  const s = useApp();
  const used = (name: string) => s.containers.filter((c) => c.networks.includes(name));
  const unused = s.networks.filter((n) => !n.system && used(n.name).length === 0).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHead title="Networks" sub={t("{length} networks · {unused} unused", { length: s.networks.length, unused })}>
        <button className="btn" onClick={() => s.setView('cleanup')}>Prune networks</button>
        <button className="btn pri" onClick={() => s.openModal({ kind: 'netCreate' })}>{t("Create network")}</button>
      </PageHead>
      <div className="card" style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 800 }}>
          <div className="th" style={{ gridTemplateColumns: NET_COLS }}>
            <span>{t("Name")}</span><span>Driver</span><span>Subnet</span><span>Scope</span><span>{t("Connected containers")}</span><span />
          </div>
          {s.networks.map((n) => {
            const us = used(n.name);
            const label = n.system ? t("System network") : us.length ? us.map((c) => c.service ?? c.name).join(', ') : t("No containers");
            return (
              <div key={n.id} className="tr" style={{ gridTemplateColumns: NET_COLS }}>
                <button className="cellbtn" onClick={() => s.openModal({ kind: 'net', id: n.id })}><span className="nm ell">{n.name}</span></button>
                <span className="mono" style={{ fontSize: 12.5, color: '#C9D0DC' }}>{n.driver}</span>
                <span className="mono muted" style={{ fontSize: 12.5 }}>{n.subnet}</span>
                <span className="muted" style={{ fontSize: 13 }}>{n.scope}</span>
                <span className={!n.system && us.length === 0 ? 'warn' : n.system ? 'muted' : ''} style={{ fontSize: 13 }}>{label}</span>
                <span style={{ display: 'flex', justifyContent: 'end' }}>
                  <IconBtn icon={ICONS.trash} label={t("Delete network")} disabled={n.system || us.length > 0} onClick={() => s.removeNetwork(n)} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Volumes

const VOL_COLS = '2fr 0.8fr 1.6fr 2fr';

export function Volumes() {
  const s = useApp();
  useEffect(() => { if (s.engine.state === 'on') void s.refresh('df'); }, [s.engine.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const sizes = new Map((s.df?.volumes ?? []).map((v) => [v.name, v.size]));
  const owners = (name: string) => s.containers.filter((c) => c.mounts.some((m) => m.type === 'volume' && m.name === name));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHead title="Volumes" sub={`${s.volumes.length} volumes${s.df ? ` · ${fmtBytes(s.df.volumesSize)}` : ''}`}>
        <button className="btn pri" onClick={() => s.openModal({ kind: 'volCreate' })}>{t("Create volume")}</button>
      </PageHead>
      <div className="card" style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 800 }}>
          <div className="th" style={{ gridTemplateColumns: VOL_COLS }}>
            <span>{t("Name")}</span><span>Size</span><span>{t("Used by")}</span><span style={{ textAlign: 'right' }}>{t("Actions")}</span>
          </div>
          {s.volumes.length === 0 && <div className="empty">{t("No volumes yet.")}</div>}
          {s.volumes.map((v) => {
            const os = owners(v.name);
            const sz = sizes.get(v.name);
            return (
              <div key={v.name} className="tr" style={{ gridTemplateColumns: VOL_COLS }}>
                <button className="cellbtn" onClick={() => s.openModal({ kind: 'vol', name: v.name })}><span className="nm mono ell" style={{ fontSize: 13 }}>{v.name}</span></button>
                <span className="mono" style={{ fontSize: 12.5 }}>{sz != null && sz >= 0 ? fmtBytes(sz) : '—'}</span>
                <span className={os.length ? '' : 'warn'} style={{ fontSize: 13 }}>{os.length ? os.map((c) => c.name).join(', ') : t("Unused")}</span>
                <span style={{ display: 'flex', justifyContent: 'end', gap: 6 }}>
                  <button className="btn sm" onClick={() => s.openModal({ kind: 'vol', name: v.name })}>{t("Browse files")}</button>
                  <button className="btn sm" disabled={!!s.backingUp[v.name]} onClick={() => void s.backupVolume(v.name)}>{s.backingUp[v.name] ? t("Backing up…") : 'Backup'}</button>
                  <IconBtn icon={ICONS.trash} label={t("Delete volume")} disabled={os.length > 0} onClick={() => s.removeVolume(v.name, sz)} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
