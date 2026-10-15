import { useEffect, type ReactNode } from 'react';
import { api, type K8sService } from '../api';
import { useApp } from '../store';
import { useK8s, type KTab } from '../k8sStore';
import { authDetail, fmtAge, podTone, runningSummary, svcPorts } from '../lib/k8s';
import { Box, Icon, IconBtn, ICONS, Indeterminate, PageHead } from '../components/ui';
import { t } from '../i18n';

const DEP_COLS = '1.6fr 1fr 0.7fr 2.2fr 1.9fr';
const POD_COLS = '2.4fr 1fr 1.4fr 0.7fr 0.6fr 1.3fr 1.4fr';
const SVC_COLS = '1.4fr 1fr 1fr 1.1fr 1.6fr 1.5fr';
const PF_COLS = '1.4fr 2fr 1.4fr 0.9fr';
/** Above this many namespaces / clusters the picker becomes a dropdown instead of buttons. */
const NS_BUTTONS = 6;
const CLUSTER_BUTTONS = 6;

export const clusterDot = (state?: string) => (state === 'ok' ? 'dot run' : state === 'auth' || state === 'offline' ? 'dot bad' : state === 'checking' ? 'dot busy' : 'dot');

const Stat = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
    <span className="muted" style={{ fontSize: 12.5 }}>{label}</span>
    {children}
  </div>
);

export function Kubernetes() {
  const k = useK8s();
  const s = useApp();
  const cluster = k.clusters.find((c) => c.id === k.activeId);
  const st = cluster ? k.status[cluster.id] : undefined;

  useEffect(() => {
    const { activeId, status, connect, watch, unwatch } = useK8s.getState();
    // Reconnect on every visit so lists are fresh, unless a check is already running.
    if (activeId && status[activeId]?.state !== 'checking') void connect(activeId);
    watch();
    return unwatch;
  }, [k.activeId]);

  const openAdd = () => s.openModal({ kind: 'k8sAdd' });
  const head = (
    <PageHead title="Kubernetes" monoSub sub={cluster ? `${cluster.name} · ${st?.check?.server ?? cluster.server}` : t("Clusters, workloads, pods, services and port-forward")}>
      {k.clusters.length > CLUSTER_BUTTONS ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className={clusterDot(st?.state)} />
          <select className="inp" aria-label="Cluster" style={{ height: 34, width: 'auto', maxWidth: 260, fontSize: 13 }} value={k.activeId ?? ''} onChange={(e) => void k.select(e.target.value)}>
            {k.clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </span>
      ) : k.clusters.map((c) => (
        <button key={c.id} className={`seg${c.id === k.activeId ? ' on' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34 }} title={c.server} onClick={() => void k.select(c.id)}>
          <span className={clusterDot(k.status[c.id]?.state)} />{c.name}
        </button>
      ))}
      <button className="btn sm" onClick={openAdd}>{t("+ Add cluster")}</button>
    </PageHead>
  );

  if (k.loaded && !k.clusters.length) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {head}
        <div className="card empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <Icon d={ICONS.kubernetes} size={32} stroke="#8F98A8" sw={1.5} />
          <span>{t("No clusters yet. Add one from a kubeconfig file to start.")}</span>
          <button className="btn pri" onClick={openAdd}>{t("Add cluster")}</button>
        </div>
      </div>
    );
  }
  if (!cluster) return <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>{head}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {head}
      {(!st || st.state === 'checking') && (
        <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span className="mono" style={{ fontSize: 13, color: '#F0C47A' }}>{t("Connecting to {server}…", { server: cluster.server })}</span>
          <Indeterminate />
        </div>
      )}
      {(st?.state === 'auth' || st?.state === 'offline') && (
        <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Box kind="err">
            {st.state === 'auth' ? t("Could not authenticate with {name}: {error}", { name: cluster.name, error: authDetail(st.error ?? '') }) : st.error}
            {st.state === 'auth' && <div style={{ marginTop: 8, color: '#C9D0DC' }}>{t("If the kubeconfig uses an exec plugin (gcloud, aws, kubelogin…), log in with the provider's CLI first, e.g. gcloud auth login, then retry.")}</div>}
          </Box>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn pri" onClick={() => void k.connect(cluster.id, true)}>{st.state === 'auth' ? t("Log in again and retry") : t("Retry")}</button>
            <button className="btn" onClick={() => s.setView('settings')}>{t("Manage connections")}</button>
          </div>
        </div>
      )}
      {st?.state === 'ok' && <ClusterBody />}
    </div>
  );
}

function ClusterBody() {
  const k = useK8s();
  const check = k.activeId ? k.status[k.activeId]?.check : undefined;
  const tabs: [KTab, string][] = [
    ['deployments', 'Workloads'], ['pods', 'Pods'], ['services', 'Services'], ['pf', t("Port-forward ({n})", { n: k.pfs.length })],
  ];
  const nsOptions = k.namespaces.length > 1 || k.ns === null;
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
        <Stat label="API server"><span className="mono ell" style={{ fontSize: 12.5 }} title={check?.server}>{check?.server}</span></Stat>
        <Stat label={t("Version")}><span className="mono" style={{ fontSize: 15 }}>{check?.version ?? '—'}</span></Stat>
        <Stat label="Nodes"><span style={{ fontSize: 15 }} title={check?.nodes == null ? t("No permission to list nodes") : undefined}>{check?.nodes ?? '—'}</span></Stat>
        <Stat label="Pods"><span style={{ fontSize: 15 }}>{k.listsLoaded ? runningSummary(k.pods) : '…'}</span></Stat>
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 18px', borderBottom: '1px solid #242935' }}>
          <div role="tablist" aria-label={t("Kubernetes resources")} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {tabs.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={k.tab === id} className={`tab${k.tab === id ? ' on' : ''}`} onClick={() => k.setTab(id)}>{label}</button>
            ))}
          </div>
          {k.tab !== 'pf' && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: 12.5 }}>Namespace</span>
              {k.namespaces.length > NS_BUTTONS ? (
                <select className="inp" aria-label="Namespace" style={{ height: 30, width: 'auto', fontSize: 13 }} value={k.ns ?? ''} onChange={(e) => void k.setNs(e.target.value || null)}>
                  <option value="">{t("All")}</option>
                  {k.namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              ) : (
                <>
                  {nsOptions && <button className={`seg${k.ns === null ? ' on' : ''}`} onClick={() => void k.setNs(null)}>{t("All")}</button>}
                  {k.namespaces.map((n) => <button key={n} className={`seg${k.ns === n ? ' on' : ''}`} onClick={() => void k.setNs(n)}>{n}</button>)}
                </>
              )}
            </div>
          )}
        </div>
        {k.tab === 'deployments' && <Workloads />}
        {k.tab === 'pods' && <Pods />}
        {k.tab === 'services' && <Services />}
        {k.tab === 'pf' && <Forwards />}
      </div>
    </>
  );
}

function Workloads() {
  const k = useK8s();
  return (
    <div style={{ overflowX: 'auto' }}><div style={{ minWidth: 860 }}>
      <div className="th" style={{ gridTemplateColumns: DEP_COLS }}><span>Deployment</span><span>Namespace</span><span>Ready</span><span>Image</span><span style={{ textAlign: 'right' }}>{t("Scale · Actions")}</span></div>
      {k.listsLoaded && !k.deployments.length && <div className="empty">{t("No deployments in this namespace.")}</div>}
      {k.deployments.map((d) => {
        const busy = !!k.busy[`d:${d.namespace}/${d.name}`];
        return (
          <div key={`${d.namespace}/${d.name}`} className="tr" style={{ gridTemplateColumns: DEP_COLS }}>
            <span className="nm ell" title={d.name}>{d.name}</span>
            <span className="muted ell" style={{ fontSize: 13 }}>{d.namespace}</span>
            <span className={d.ready < d.replicas ? 'warn' : ''} style={{ fontSize: 13 }}>{d.ready}/{d.replicas}</span>
            <span className="mono ell" style={{ fontSize: 12.5, color: '#C9D0DC' }} title={d.image}>{d.image}</span>
            <span style={{ display: 'flex', justifyContent: 'end', alignItems: 'center', gap: 6 }}>
              <IconBtn icon={ICONS.minus} label={t("Decrease replicas")} size={14} disabled={busy || d.replicas <= 0} onClick={() => void k.scale(d, -1)} />
              <span className="cnt">{d.replicas}</span>
              <IconBtn icon={ICONS.plus} label={t("Increase replicas")} size={14} disabled={busy} onClick={() => void k.scale(d, 1)} />
              <button className="btn sm" style={{ marginLeft: 6 }} disabled={busy} onClick={() => k.restart(d)}>Rollout restart</button>
            </span>
          </div>
        );
      })}
    </div></div>
  );
}

function Pods() {
  const k = useK8s();
  const openModal = useApp((s) => s.openModal);
  const id = k.activeId!;
  return (
    <div style={{ overflowX: 'auto' }}><div style={{ minWidth: 960 }}>
      <div className="th" style={{ gridTemplateColumns: POD_COLS }}><span>Pod</span><span>Namespace</span><span>{t("Status")}</span><span>Restarts</span><span>Age</span><span>Node</span><span style={{ textAlign: 'right' }}>{t("Actions")}</span></div>
      {k.listsLoaded && !k.pods.length && <div className="empty">{t("No pods in this namespace.")}</div>}
      {k.pods.map((p) => {
        const tone = podTone(p.status);
        const off = p.deleting || !!k.busy[`p:${p.namespace}/${p.name}`];
        return (
          <div key={`${p.namespace}/${p.name}`} className="tr" style={{ gridTemplateColumns: POD_COLS }}>
            <span className="mono ell" style={{ fontSize: 12.5 }} title={p.name}>{p.name}</span>
            <span className="muted ell" style={{ fontSize: 13 }}>{p.namespace}</span>
            <span><span className={`pill${tone ? ` ${tone}` : ''}`} title={p.waitingMessage ?? undefined}>{p.status}</span></span>
            <span className={p.restarts > 3 ? 'warn' : ''} style={{ fontSize: 12.5 }}>{p.restarts}</span>
            <span className="mono muted" style={{ fontSize: 12.5 }}>{fmtAge(p.created)}</span>
            <span className="mono muted ell" style={{ fontSize: 12 }} title={p.node}>{p.node || '—'}</span>
            <span style={{ display: 'flex', justifyContent: 'end', gap: 6 }}>
              <button className="btn sm" onClick={() => openModal({ kind: 'podLogs', clusterId: id, pod: p })}>Logs</button>
              <IconBtn icon={ICONS.terminal} label={t("Exec into pod")} disabled={off || p.status !== 'Running'} onClick={() => openModal({ kind: 'podExec', clusterId: id, pod: p })} />
              <IconBtn icon={ICONS.trash} label={t("Delete pod")} disabled={off} onClick={() => k.deletePod(p)} />
            </span>
          </div>
        );
      })}
    </div></div>
  );
}

function Services() {
  const k = useK8s();
  const fwdOf = (sv: K8sService, port: number) => k.pfs.find((f) => f.clusterId === k.activeId && f.namespace === sv.namespace && f.service === sv.name && f.remotePort === port);
  return (
    <div style={{ overflowX: 'auto' }}><div style={{ minWidth: 860 }}>
      <div className="th" style={{ gridTemplateColumns: SVC_COLS }}><span>Service</span><span>Namespace</span><span>Type</span><span>Cluster IP</span><span>Ports</span><span style={{ textAlign: 'right' }}>{t("Access")}</span></div>
      {k.listsLoaded && !k.services.length && <div className="empty">{t("No services in this namespace.")}</div>}
      {k.services.map((sv) => {
        const ports = sv.ports.filter((p) => p.protocol === 'TCP');
        const noSel = !Object.keys(sv.selector).length;
        return (
          <div key={`${sv.namespace}/${sv.name}`} className="tr" style={{ gridTemplateColumns: SVC_COLS }}>
            <span className="nm ell" title={sv.name}>{sv.name}</span>
            <span className="muted ell" style={{ fontSize: 13 }}>{sv.namespace}</span>
            <span className="mono" style={{ fontSize: 12.5, color: '#C9D0DC' }}>{sv.type}</span>
            <span className="mono muted" style={{ fontSize: 12.5 }}>{sv.clusterIp}</span>
            <span className="mono ell" style={{ fontSize: 12.5 }} title={svcPorts(sv)}>{svcPorts(sv)}</span>
            <span style={{ display: 'flex', justifyContent: 'end', gap: 6, flexWrap: 'wrap' }}>
              {ports.map((p) => {
                const f = fwdOf(sv, p.port);
                const label = ports.length > 1 ? `:${p.port}` : '';
                if (f) return <button key={p.port} className="btn sm" onClick={() => void k.stopPf(f.id)}>{t("Stop · localhost:{port}", { port: f.localPort })}</button>;
                return (
                  <button key={p.port} className="btn sm pri" disabled={noSel || !!k.busy[`s:${sv.namespace}/${sv.name}:${p.port}`]} title={noSel ? t("This service has no selector, so there is no pod to forward to") : undefined} onClick={() => void k.startPf(sv, p.port)}>
                    Port-forward{label}
                  </button>
                );
              })}
            </span>
          </div>
        );
      })}
    </div></div>
  );
}

function Forwards() {
  const k = useK8s();
  const toast = useApp((s) => s.toast);
  if (!k.pfs.length) return <div className="empty">{t("No port-forwards yet. Open the Services tab and press “Port-forward”.")}</div>;
  return (
    <div style={{ overflowX: 'auto' }}><div style={{ minWidth: 640 }}>
      {k.pfs.map((f) => (
        <div key={f.id} className="tr" style={{ gridTemplateColumns: PF_COLS }}>
          <span className="nm ell">svc/{f.service}</span>
          <span className="muted ell" style={{ fontSize: 13 }}>{f.clusterName} · {f.namespace} · {f.remotePort}</span>
          <button className="linkbtn mono" style={{ fontSize: 13, justifySelf: 'start' }} onClick={() => void api.openUrl(`http://localhost:${f.localPort}`).catch((e) => toast((e as Error).message, 'err'))}>localhost:{f.localPort}</button>
          <span style={{ display: 'flex', justifyContent: 'end' }}><button className="btn sm" onClick={() => void k.stopPf(f.id)}>{t("Stop")}</button></span>
        </div>
      ))}
    </div></div>
  );
}
