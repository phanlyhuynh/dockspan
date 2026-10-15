import { useEffect, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, inTauri, type CtxKind, type EngineInfo, type NewCtx, type SshHost, type WslDistro } from '../api';
import { useApp } from '../store';
import { equivalentCommand, formEndpoint, suggestName } from '../lib/connections';
import { Box, Check, Field, Indeterminate, ModalFrame } from '../components/ui';
import { t } from '../i18n';

type Chip = CtxKind | 'k8s';

const chips = (): [Chip, string, string][] => [
  ['local', t("Local socket"), t("A Docker socket on this machine: Docker Desktop, Colima, OrbStack, Rancher Desktop or Podman.")],
  ['wsl', 'WSL2', t("Docker Engine inside a WSL2 distro on this Windows machine.")],
  ['ssh', 'SSH', t("A Docker host reached over SSH (ssh-agent and known_hosts are used; the host must have the docker CLI).")],
  ['tcp', 'TCP + TLS', t("The Docker API over TCP, normally port 2376 with TLS client certificates.")],
  ['k8s', 'Kubernetes', t("A Kubernetes cluster from a kubeconfig file.")],
];

type Probe = { state: 'run' } | { state: 'ok'; info: EngineInfo } | { state: 'bad'; error: string } | null;

/** Modal 9.4 "Add connection". Saving works even when the check failed (the card then shows Offline). */
export function CtxAddModal({ type, distro }: { type?: CtxKind; distro?: string }) {
  const s = useApp();
  const [kind, setKind] = useState<CtxKind>(type ?? 'ssh');
  const [name, setName] = useState('');
  const [socket, setSocket] = useState('');
  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [port, setPort] = useState('22');
  const [key, setKey] = useState('');
  const [tls, setTls] = useState(true);
  const [certDir, setCertDir] = useState('');
  const [wsl, setWsl] = useState<{ available: boolean; distros: WslDistro[] } | null>(null);
  const [pick, setPick] = useState(distro ?? '');
  const [sshHosts, setSshHosts] = useState<SshHost[] | null>(null);
  const [probe, setProbe] = useState<Probe>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (kind !== 'wsl' || wsl) return;
    api.wslList().then((r) => {
      setWsl(r);
      if (!pick) setPick(r.distros.find((d) => !d.added && d.docker)?.name ?? r.distros.find((d) => !d.added)?.name ?? '');
    }).catch((e) => s.toast((e as Error).message, 'err'));
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (kind !== 'ssh' || sshHosts) return;
    api.sshHosts().then(setSshHosts).catch(() => setSshHosts([]));
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // Picking an alias keeps it as the host so ssh applies every option of that block (ProxyJump, IdentityFile…);
  // user/port/key stay empty unless the user overrides them.
  const alias = sshHosts?.find((h) => h.alias === host.trim());
  const useAlias = (a: string) => {
    setHost(a); setUser(''); setPort(''); setKey(''); setProbe(null);
  };

  const form: NewCtx = {
    name: '', kind, socket, host: host.trim(), user: user.trim(), port: Number(port) || 22, key: key.trim(), tls, certDir: certDir.trim(), distro: pick,
  };
  const suggested = suggestName(form);
  const finalName = name.trim() || suggested;
  const spec: NewCtx = { ...form, name: finalName };

  const choose = (c: Chip) => {
    if (c === 'k8s') { s.openModal({ kind: 'k8sAdd' }); return; }
    setKind(c);
    setProbe(null);
  };
  const browse = async (dir: boolean, set: (v: string) => void, title: string) => {
    if (!inTauri) return;
    const p = await openDialog({ directory: dir, multiple: false, title });
    if (typeof p === 'string') set(p);
  };
  const test = async () => {
    setProbe({ state: 'run' });
    try {
      setProbe({ state: 'ok', info: await api.ctxProbe(spec) });
    } catch (e) {
      setProbe({ state: 'bad', error: (e as Error).message });
    }
  };
  const save = async () => {
    if (!finalName) { s.toast(t("Enter a display name"), 'err'); return; }
    setBusy(true);
    try {
      const c = await api.ctxAdd(spec);
      s.closeModal();
      await s.loadContexts();
      s.toast(t("Saved connection {name}", { name: c.name }));
      s.ev('engine', t("Added connection {name}", { name: c.name }));
    } catch (e) {
      s.toast((e as Error).message, 'err');
      setBusy(false);
    }
  };

  const desc = chips().find((c) => c[0] === kind)?.[2];
  const target = kind === 'ssh' ? `${user ? `${user}@` : ''}${host}` : formEndpoint(form);
  return (
    <ModalFrame title={t("Add connection")} onClose={s.closeModal} maxWidth={640}
      footer={<><button className="btn" onClick={s.closeModal}>{t("Cancel")}</button><button className="btn pri" disabled={busy} onClick={() => void save()}>{t("Save connection")}</button></>}>
      <div className="mb">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {chips().map(([id, label]) => <button key={id} className={`seg${kind === id ? ' on' : ''}`} onClick={() => choose(id)}>{label}</button>)}
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{desc}</p>
        <Field label={t("Display name")}>
          <input className="inp mono" placeholder={suggested || 'prod-server'} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        {kind === 'local' && (
          <Field label={t("Socket path")}>
            <input className="inp mono" placeholder="/var/run/docker.sock" value={socket} onChange={(e) => setSocket(e.target.value)} />
            <span className="muted" style={{ fontSize: 12 }}>Colima: ~/.colima/default/docker.sock · OrbStack: ~/.orbstack/run/docker.sock · Rancher: ~/.rd/docker.sock</span>
          </Field>
        )}

        {kind === 'wsl' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="muted" style={{ fontSize: 13 }}>{t("Distro")}</span>
            {!wsl && <Indeterminate />}
            {wsl && !wsl.available && <Box kind="warn">{t("WSL2 is only available on Windows.")}</Box>}
            {wsl?.available && !wsl.distros.length && <span className="muted" style={{ fontSize: 13 }}>{t("No WSL distro found. Install one with wsl --install.")}</span>}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {wsl?.distros.map((d) => (
                <button key={d.name} className={`seg${pick === d.name ? ' on' : ''}`} disabled={d.added} onClick={() => { setPick(d.name); setProbe(null); }}>
                  {d.name}{d.added ? t(" · added") : d.checked && !d.docker ? t(" · no Docker") : ''}
                </button>
              ))}
            </div>
          </div>
        )}

        {kind === 'ssh' && (
          <>
            {!!sshHosts?.length && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="muted" style={{ fontSize: 13 }}>{t("From ~/.ssh/config")}</span>
                {sshHosts.length > 8 ? (
                  <select className="inp mono" aria-label={t("From ~/.ssh/config")} value={alias?.alias ?? ''} onChange={(e) => e.target.value && useAlias(e.target.value)}>
                    <option value="">{t("Choose a host…")}</option>
                    {sshHosts.map((h) => <option key={h.alias} value={h.alias}>{h.alias} ({h.hostname})</option>)}
                  </select>
                ) : (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {sshHosts.map((h) => (
                      <button key={h.alias} className={`seg mono${alias?.alias === h.alias ? ' on' : ''}`} title={h.hostname} onClick={() => useAlias(h.alias)}>{h.alias}</button>
                    ))}
                  </div>
                )}
                {alias && (
                  <span className="mono muted" style={{ fontSize: 12 }}>
                    → {alias.user ? `${user || alias.user}@` : ''}{alias.hostname}:{port || alias.port}
                    {alias.identityFile && !key ? ` · ${alias.identityFile}` : ''}{alias.proxyJump ? t(" · via {jump}", { jump: alias.proxyJump }) : ''}
                  </span>
                )}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 0.7fr', gap: 10 }}>
              <Field label={t("Host / IP")}><input className="inp mono" placeholder="203.0.113.10" value={host} onChange={(e) => setHost(e.target.value)} /></Field>
              <Field label="User"><input className="inp mono" placeholder={alias?.user ?? 'deploy'} value={user} onChange={(e) => setUser(e.target.value)} /></Field>
              <Field label="Port"><input className="inp mono" inputMode="numeric" placeholder={alias ? String(alias.port) : '22'} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} /></Field>
            </div>
            <Field label={t("SSH key (optional)")}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="inp mono" placeholder={alias?.identityFile ?? '~/.ssh/id_ed25519'} value={key} onChange={(e) => setKey(e.target.value)} />
                <button className="btn" onClick={() => void browse(false, setKey, t("Choose SSH key"))}>{t("Browse…")}</button>
              </div>
            </Field>
          </>
        )}

        {kind === 'tcp' && (
          <>
            <Field label="Host:port"><input className="inp mono" placeholder={tls ? '10.0.0.25:2376' : '10.0.0.25:2375'} value={host} onChange={(e) => setHost(e.target.value)} /></Field>
            <Check checked={tls} onChange={(v) => { setTls(v); setProbe(null); }}>{t("TLS authentication (recommended)")}</Check>
            {tls ? (
              <Field label={t("Certificate folder (ca.pem, cert.pem, key.pem)")}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="inp mono" placeholder="~/.docker/certs/prod" value={certDir} onChange={(e) => setCertDir(e.target.value)} />
                  <button className="btn" onClick={() => void browse(true, setCertDir, t("Choose certificate folder"))}>{t("Browse…")}</button>
                </div>
              </Field>
            ) : (
              <Box kind="warn">{t("Not encrypted. Do not expose the Docker port to the Internet.")}</Box>
            )}
          </>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="muted" style={{ fontSize: 13 }}>{t("Equivalent command")}</span>
          <code className="mono" style={{ fontSize: 12.5, padding: '8px 10px', background: '#0B0D11', borderRadius: 7, overflowX: 'auto', whiteSpace: 'nowrap' }}>{equivalentCommand(form, finalName)}</code>
        </div>
        <div><button className="btn" disabled={probe?.state === 'run'} onClick={() => void test()}>{t("Test connection")}</button></div>
        {probe?.state === 'run' && <Indeterminate />}
        {probe?.state === 'ok' && <Box kind="ok">{t("Connection OK · {target} · Docker {version} · {os}", { target, version: probe.info.version, os: probe.info.os })}</Box>}
        {probe?.state === 'bad' && <Box kind="err" style={{ wordBreak: 'break-word' }}>{probe.error}</Box>}
      </div>
    </ModalFrame>
  );
}
