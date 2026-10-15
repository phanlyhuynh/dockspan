import { useEffect, useMemo, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { api, inTauri, type SshTarget } from '../api';
import { useApp } from '../store';
import { useSsh, type SshSession } from '../sshStore';
import { sshEntries, type SshEntry, type SshSource } from '../lib/ssh';
import { Field, Icon, IconBtn, ICONS, ModalFrame, PageHead } from '../components/ui';
import { TerminalView, type ExecBackend } from './ContainerTabs';
import { t } from '../i18n';

const HOST_COLS = '1.3fr 1.8fr 0.9fr 1.3fr';

const sourceLabel = (s: SshSource) => ({ config: '~/.ssh/config', context: 'Docker context', app: 'Dockspan' })[s];

/** Terminal sessions run `ssh` in a pseudo-terminal on the backend; `exec://<sid>` carries the output like docker exec. */
export const sshBackend = (target: SshTarget): ExecBackend => ({
  open: async (sid, _shell, cols, rows) => { await api.sshOpen(sid, target, cols, rows); return { shell: '' }; },
  write: api.sshWrite, resize: api.sshResize, close: async (sid) => { await api.sshClose(sid); },
});

export function useSshEntries(): SshEntry[] {
  const config = useSsh((s) => s.config);
  const saved = useSsh((s) => s.saved);
  const contexts = useApp((s) => s.contexts);
  return useMemo(() => sshEntries(config, contexts, saved), [config, saved, contexts]);
}

/** Stays mounted after the first visit (App.tsx) so terminals survive changing page. */
export function Ssh({ visible }: { visible: boolean }) {
  const s = useApp();
  const ssh = useSsh();
  const entries = useSshEntries();
  useEffect(() => { if (visible) void useSsh.getState().load(); }, [visible]);

  const openCount = ssh.sessions.filter((x) => !x.closed).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHead title="SSH" sub={t("{hosts} hosts · {open} open terminals", { hosts: entries.length, open: openCount })}>
        <button className="btn" onClick={() => void ssh.load()}>{t("Reload ~/.ssh/config")}</button>
        <button className="btn pri" onClick={() => s.openModal({ kind: 'sshAdd' })}><Icon d={ICONS.plus} />{t("Add host")}</button>
      </PageHead>

      <div className="card" style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 720 }}>
          <div className="th" style={{ gridTemplateColumns: HOST_COLS }}><span>Host</span><span>{t("Address")}</span><span>{t("Source")}</span><span style={{ textAlign: 'right' }}>{t("Actions")}</span></div>
          {ssh.loaded && !entries.length && <div className="empty">{t("No SSH hosts yet. Add Host entries to ~/.ssh/config, or press “Add host”.")}</div>}
          {entries.map((e) => {
            const n = ssh.sessions.filter((x) => x.entry.id === e.id && !x.closed).length;
            return (
              <div key={e.id} className="tr" style={{ gridTemplateColumns: HOST_COLS }}>
                <button className="cellbtn" onClick={() => ssh.open(e)} title={t("Open terminal")}>
                  <span className="nm mono ell" style={{ fontSize: 13 }}>{e.name}</span>
                  {n > 0 && <span className="pill run" style={{ marginLeft: 8 }}>{t("{n} open", { n })}</span>}
                </button>
                <span className="mono muted ell" style={{ fontSize: 12.5 }} title={[e.address, e.key, e.jump && `ProxyJump ${e.jump}`].filter(Boolean).join(' · ')}>
                  {e.address}{e.jump ? t(" · via {jump}", { jump: e.jump }) : ''}
                </span>
                <span><span className="tag">{sourceLabel(e.source)}</span></span>
                <span style={{ display: 'flex', justifyContent: 'end', gap: 6 }}>
                  <button className="btn sm pri" onClick={() => ssh.open(e)}><Icon d={ICONS.terminal} size={14} />{t("Open terminal")}</button>
                  {e.source === 'app' && <IconBtn icon={ICONS.trash} label={t("Remove host")} onClick={() => ssh.removeSaved(e.name)} />}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {ssh.sessions.length > 0 && <Sessions visible={visible} />}
    </div>
  );
}

function Sessions({ visible }: { visible: boolean }) {
  const ssh = useSsh();
  const toast = useApp((s) => s.toast);
  const cur = ssh.sessions.find((x) => x.key === ssh.active) ?? ssh.sessions[0];
  const popOut = (x: SshSession) => {
    try {
      const q = encodeURIComponent(JSON.stringify(x.entry.target));
      new WebviewWindow(`term-ssh-${Date.now()}`, { url: `index.html?ssh=${q}&name=${encodeURIComponent(x.entry.name)}`, title: `${x.entry.name} · SSH`, width: 960, height: 600 });
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div role="tablist" aria-label={t("SSH terminals")} style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', padding: '8px 14px', borderBottom: '1px solid #242935' }}>
        {ssh.sessions.map((x) => {
          const on = x.key === cur?.key;
          const label = `${x.entry.name}${x.n > 1 ? ` · ${x.n}` : ''}`;
          return (
            <span key={x.key} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <button role="tab" aria-selected={on} className={`tab${on ? ' on' : ''}`} style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => ssh.setActive(x.key)}>
                <span className={x.closed ? 'dot' : 'dot run'} />{label}
              </button>
              <button className={`tab${on ? ' on' : ''}`} aria-label={t("Close terminal {v0}", { v0: label })} title={t("Close this session")} style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, padding: '0 8px' }} onClick={() => ssh.close(x.key)}>×</button>
            </span>
          );
        })}
        {cur && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="btn sm" onClick={() => ssh.open(cur.entry)}>{t("+ New terminal")}</button>
            <button className="btn sm" onClick={() => popOut(cur)}>{t("Open in separate window")}</button>
          </span>
        )}
      </div>
      {ssh.sessions.map((x) => (
        <div key={x.key} style={{ display: x.key === cur?.key && visible ? 'block' : 'none' }}>
          {x.closed && (
            <div className="box warn" style={{ margin: '10px 14px 0', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
              <span style={{ flex: 1 }}>{t("The session ended. If it failed, the terminal below shows the ssh error.")}</span>
              <button className="btn sm pri" onClick={() => ssh.reconnect(x.key)}>{t("Reconnect")}</button>
            </div>
          )}
          <div style={{ padding: '8px 10px 10px', background: '#0B0D11' }}>
            <TerminalView key={x.gen} containerId={`${x.key}-${x.gen}`} shell="auto" height={460} backend={sshBackend(x.entry.target)} onClosed={() => ssh.ended(x.key)} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Separate SSH terminal window (`?ssh=<target JSON>&name=`). */
export function SshTerminalWindow({ target, name }: { target: SshTarget; name: string }) {
  const [gen, setGen] = useState(1);
  const [closed, setClosed] = useState(false);
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0B0D11' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid #242935', fontSize: 13, color: '#8F98A8' }}>
        <span style={{ flex: 1 }}>{name} · ssh{closed ? t(" · session closed") : ''}</span>
        {closed && <button className="btn sm pri" onClick={() => { setClosed(false); setGen((g) => g + 1); }}>{t("Reconnect")}</button>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <TerminalView key={gen} containerId={`ssh-window-${gen}`} shell="auto" height="100%" backend={sshBackend(target)} onClosed={() => setClosed(true)} />
      </div>
    </div>
  );
}

/** "Add host" on the SSH page: kept by the app (the SSH config file is never written). */
export function SshAddModal() {
  const s = useApp();
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [port, setPort] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const fallback = host.trim().split('.')[0] ?? '';
  const save = async (connect: boolean) => {
    setBusy(true);
    const h = { name: name.trim() || fallback, host: host.trim(), user: user.trim() || null, port: Number(port) || null, key: key.trim() || null };
    if (!h.host) { s.toast(t("Enter the host"), 'err'); setBusy(false); return; }
    const ok = await useSsh.getState().addSaved(h);
    setBusy(false);
    if (!ok) return;
    s.closeModal();
    if (connect) useSsh.getState().open({ id: `app:${h.name}`, name: h.name, source: 'app', target: { host: h.host, user: h.user, port: h.port, key: h.key }, address: h.host, key: h.key, jump: null });
  };
  const browse = async () => {
    if (!inTauri) return;
    const p = await openDialog({ multiple: false, title: t("Choose SSH key") });
    if (typeof p === 'string') setKey(p);
  };
  const cmd = `ssh ${user.trim() ? `${user.trim()}@` : ''}${host.trim() || '<host>'}${Number(port) && Number(port) !== 22 ? ` -p ${port}` : ''}${key.trim() ? ` -i ${key.trim()}` : ''}`;
  return (
    <ModalFrame title={t("Add SSH host")} onClose={s.closeModal} maxWidth={560}
      footer={<>
        <button className="btn" onClick={s.closeModal}>{t("Cancel")}</button>
        <button className="btn" disabled={busy} onClick={() => void save(false)}>{t("Save")}</button>
        <button className="btn pri" disabled={busy} onClick={() => void save(true)}>{t("Save and connect")}</button>
      </>}>
      <div className="mb">
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{t("Hosts of ~/.ssh/config are listed automatically. A host added here is kept by the app; password logins are typed in the terminal.")}</p>
        <Field label={t("Display name")}><input className="inp mono" placeholder={fallback || 'web-01'} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 0.7fr', gap: 10 }}>
          <Field label={t("Host / IP")}><input className="inp mono" placeholder="203.0.113.10" value={host} onChange={(e) => setHost(e.target.value)} /></Field>
          <Field label="User"><input className="inp mono" placeholder="root" value={user} onChange={(e) => setUser(e.target.value)} /></Field>
          <Field label="Port"><input className="inp mono" inputMode="numeric" placeholder="22" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} /></Field>
        </div>
        <Field label={t("SSH key (optional)")}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="inp mono" placeholder="~/.ssh/id_ed25519" value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="btn" onClick={() => void browse()}>{t("Browse…")}</button>
          </div>
        </Field>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="muted" style={{ fontSize: 13 }}>{t("Equivalent command")}</span>
          <code className="mono" style={{ fontSize: 12.5, padding: '8px 10px', background: '#0B0D11', borderRadius: 7, overflowX: 'auto', whiteSpace: 'nowrap' }}>{cmd}</code>
        </div>
      </div>
    </ModalFrame>
  );
}
