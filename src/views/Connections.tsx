import { useEffect, useState } from 'react';
import { api, type CtxInfo } from '../api';
import { useApp } from '../store';
import { useK8s } from '../k8sStore';
import { clusterDot } from './Kubernetes';
import { fmtMem } from '../lib/format';
import { Icon, IconBtn, ICONS, PageHead } from '../components/ui';
import { t } from '../i18n';

const TYPE_LABEL: Record<string, string> = { local: 'Local', ssh: 'SSH', tcp: 'TCP' };

type Check = { state: 'checking' } | { state: 'ok'; text: string } | { state: 'bad'; text: string };

export function Connections() {
  const s = useApp();
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [editor, setEditor] = useState('');
  useEffect(() => { api.settingsGet().then((x) => setEditor(x.editorCommand)).catch(() => {}); }, []);
  const saveEditor = async () => {
    try { await api.settingsSet(editor.trim() || 'code'); s.toast(t("Editor command saved"), 'info'); }
    catch (e) { s.toast((e as Error).message, 'err'); }
  };

  const test = async (c: CtxInfo) => {
    setChecks((p) => ({ ...p, [c.id]: { state: 'checking' } }));
    try {
      const i = await api.ctxTest(c.id);
      setChecks((p) => ({ ...p, [c.id]: { state: 'ok', text: `Docker ${i.version} · ${i.os} · ${i.cpus} CPU · ${fmtMem(i.memTotal)}` } }));
      s.toast(t("{name}: connection OK · Docker {version} · {latencyMs} ms", { name: c.name, version: i.version, latencyMs: i.latencyMs ?? 0 }));
    } catch (e) {
      setChecks((p) => ({ ...p, [c.id]: { state: 'bad', text: (e as Error).message } }));
      s.toast((e as Error).message, 'err');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
      <PageHead title={t("Connections")} sub={t("Docker contexts (local, WSL2, SSH, TCP) and Kubernetes clusters")}>
        <button className="btn pri" onClick={() => s.openModal({ kind: 'info', title: t("Add connection"), body: t("Adding WSL2, SSH and TCP/TLS connections is planned for phase 4 of the roadmap.\\n\\nFor now the app uses the existing Docker contexts from `docker context ls`; create more with `docker context create` and reopen this list. Kubernetes clusters are added with “Add cluster” below.") })}>
          <Icon d={ICONS.plus} />{t("Add connection")}
        </button>
      </PageHead>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="secth"><h2 className="h2">Docker engines</h2><span className="muted" style={{ fontSize: 13 }}>{t("Only one context is used at a time")}</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {s.contexts.map((c) => {
            const ck = checks[c.id];
            const switching = s.engine.state === 'connecting';
            let pill = [t("Ready"), 'pill'];
            if (c.active) pill = [t("In use"), 'pill run'];
            else if (ck?.state === 'checking') pill = [t("Checking…"), 'pill part'];
            else if (ck?.state === 'bad') pill = ['Offline', 'pill bad'];
            else if (!c.supported) pill = [t("Not supported"), 'pill'];
            const info = c.active && s.engine.info ? `Docker ${s.engine.info.version} · ${s.engine.info.os} · ${s.engine.info.cpus} CPU · ${fmtMem(s.engine.info.memTotal)}` : ck?.state === 'ok' || ck?.state === 'bad' ? ck.text : '—';
            return (
              <div key={c.id} className={`card${c.active ? ' cur' : ''}`} style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'start', gap: 12 }}>
                  <span className="tag" style={{ alignSelf: 'center' }}>{TYPE_LABEL[c.kind] ?? c.kind}</span>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</span>
                    <span className="mono muted ell" style={{ fontSize: 12 }} title={c.endpoint}>{c.endpoint}</span>
                  </div>
                  <span className={pill[1]}>{pill[0]}</span>
                </div>
                <div style={{ fontSize: 12.5, color: ck?.state === 'bad' ? '#F2A8A8' : '#8F98A8' }} className="ell" title={info}>{info}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className={c.active ? 'btn sm' : 'btn sm pri'} disabled={c.active || switching || !c.supported} onClick={() => void s.switchCtx(c.id)}>{c.active ? t("In use") : t("Use this context")}</button>
                  <button className="btn sm" disabled={ck?.state === 'checking'} onClick={() => void test(c)}>{t("Check")}</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="secth"><h2 className="h2">{t("Editor")}</h2><span className="muted" style={{ fontSize: 13 }}>{t("Command used by the “VS Code” button on project cards")}</span></div>
        <div className="card" style={{ padding: 18, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="inp mono" style={{ maxWidth: 320 }} aria-label={t("Editor command")} placeholder="code" value={editor} onChange={(e) => setEditor(e.target.value)} />
          <button className="btn" onClick={() => void saveEditor()}>{t("Save")}</button>
          <span className="muted" style={{ fontSize: 12.5 }}>{t("Examples: code, cursor, subl, idea")}</span>
        </div>
      </section>

      <Clusters />
    </div>
  );
}

function Clusters() {
  const k = useK8s();
  const s = useApp();
  const open = (id: string) => { s.setView('kubernetes'); void k.select(id); };
  const test = async (id: string, name: string) => {
    const r = await k.check(id);
    if (r) s.toast(t("{name}: connection OK · Kubernetes {version} · {latencyMs} ms", { name, version: r.version, latencyMs: r.latencyMs }));
  };
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="secth">
        <h2 className="h2">Kubernetes clusters</h2>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 13 }}>{t("Read from kubeconfig; independent of the Docker context")}</span>
          <button className="btn sm" onClick={() => s.openModal({ kind: 'k8sAdd' })}>{t("+ Add cluster")}</button>
        </span>
      </div>
      {k.loaded && !k.clusters.length && <div className="card empty">{t("No clusters yet. Add one from a kubeconfig file to start.")}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
        {k.clusters.map((c) => {
          const st = k.status[c.id];
          const pill =
            st?.state === 'ok' ? [t("Ready"), 'pill run']
            : st?.state === 'auth' ? [t("Needs login"), 'pill bad']
            : st?.state === 'offline' ? ['Offline', 'pill bad']
            : st?.state === 'checking' ? [t("Connecting…"), 'pill part']
            : [t("Not checked"), 'pill'];
          const ck = st?.check;
          const meta = st?.error && st.state !== 'checking' ? st.error
            : ck ? `Kubernetes ${ck.version} · ${ck.nodes == null ? t("nodes hidden (no permission)") : t("{n} nodes", { n: ck.nodes })}`
            : `${c.kubeContext} · ${c.kubeconfigPath}`;
          return (
            <div key={c.id} className={`card${c.id === k.activeId ? ' cur' : ''}`} style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'start', gap: 12 }}>
                <span className="tag" style={{ alignSelf: 'center' }}>K8s</span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}><span className={clusterDot(st?.state)} />{c.name}</span>
                  <span className="mono muted ell" style={{ fontSize: 12 }} title={c.server}>{c.server}</span>
                </div>
                <span className={pill[1]}>{pill[0]}</span>
              </div>
              <span className="mono ell" style={{ fontSize: 12.5, color: st?.error ? '#F2A8A8' : '#8F98A8' }} title={meta}>{meta}</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn sm pri" onClick={() => open(c.id)}>{t("Open")}</button>
                <button className="btn sm" disabled={st?.state === 'checking'} onClick={() => void test(c.id, c.name)}>{t("Check")}</button>
                <IconBtn icon={ICONS.trash} label={t("Remove cluster")} style={{ marginLeft: 'auto' }} onClick={() => k.remove(c)} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
