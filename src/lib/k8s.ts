import type { K8sDeployment, K8sPod, K8sService } from '../api';
import { t } from '../i18n';

export type Tone = 'run' | 'part' | 'bad' | '';

const BAD = /^(CrashLoopBackOff|Error|ImagePullBackOff|ErrImagePull|InvalidImageName|OOMKilled|Evicted|CreateContainerConfigError|CreateContainerError|RunContainerError|ContainerCannotRun|DeadlineExceeded|Failed|Unknown)$|^Init:(Error|CrashLoopBackOff|ImagePullBackOff|ErrImagePull|OOMKilled)/;
const BUSY = /^(ContainerCreating|PodInitializing|Pending|Terminating)$|^Init:/;

/** Pill color for a pod status: Running green, starting/terminating yellow, failures red, Completed grey. */
export function podTone(status: string): Tone {
  if (status === 'Running') return 'run';
  if (BAD.test(status)) return 'bad';
  if (BUSY.test(status)) return 'part';
  return '';
}

/** The backend reports 401s and failed kubeconfig exec plugins as "Unauthorized: …" (translated as "Không xác thực được: …"). */
export function isAuthError(msg: string): boolean {
  return /^Unauthorized\b|^Không xác thực được/.test(msg);
}

/** The error without its "Unauthorized:" prefix, for text that already says authentication failed. */
export function authDetail(msg: string): string {
  return msg.replace(/^(Unauthorized|Không xác thực được):\s*/, '');
}

/** `80:30080/TCP, 443/TCP` like the PORT(S) column of `kubectl get svc`. */
export function svcPorts(s: K8sService): string {
  return s.ports.map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol}`).join(', ') || '—';
}

/** Short age like kubectl: 45s, 12m, 5h, 3d. */
export function fmtAge(createdSec: number, nowMs: number = Date.now()): string {
  if (!createdSec) return '—';
  const s = Math.max(0, Math.floor(nowMs / 1000 - createdSec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Pods matched by a deployment's selector (labels are a superset of `matchLabels`). */
export function podsOf(d: K8sDeployment, pods: K8sPod[]): K8sPod[] {
  const sel = Object.entries(d.selector);
  if (!sel.length) return [];
  return pods.filter((p) => p.namespace === d.namespace && sel.every(([k, v]) => p.labels[k] === v));
}

export function runningSummary(pods: K8sPod[]): string {
  return t("{running} / {total} Running", { running: pods.filter((p) => p.status === 'Running').length, total: pods.length });
}

export interface PodHint { title: string; hint: string }

/**
 * Explain why a pod is failing from its status (waiting / last terminated reason) and its recent log lines.
 * Returns null for healthy pods.
 */
export function explainPod(p: K8sPod, logs: string[] = []): PodHint | null {
  const tone = podTone(p.status);
  if (tone !== 'bad' && !(p.restarts > 3)) return null;
  const why = p.waitingReason ?? '';
  const msg = p.waitingMessage ? ` (${p.waitingMessage})` : '';
  if (p.status === 'OOMKilled' || p.lastTerminatedReason === 'OOMKilled') {
    return { title: t("The container was killed for using more memory than its limit (OOMKilled)."), hint: t("Raise resources.limits.memory or reduce the app's memory use.") };
  }
  if (/ImagePullBackOff|ErrImagePull|InvalidImageName/.test(why) || /ImagePullBackOff|ErrImagePull|InvalidImageName/.test(p.status)) {
    return { title: t("The image cannot be pulled{msg}.", { msg }), hint: t("Check the image name and tag, and imagePullSecrets for a private registry.") };
  }
  if (/CreateContainerConfigError/.test(why)) {
    return { title: t("The container configuration is invalid{msg}.", { msg }), hint: t("A ConfigMap, Secret or key referenced by the pod is probably missing.") };
  }
  const text = logs.slice(-200).join('\n');
  const host =
    /getaddrinfo (?:ENOTFOUND|EAI_AGAIN) ([\w.-]+)/.exec(text)?.[1] ??
    /lookup ([\w.-]+)(?: on [^\s]+)?: no such host/.exec(text)?.[1] ??
    /could not translate host name "([^"]+)"/.exec(text)?.[1] ??
    /UnknownHostException:? ([\w.-]+)/.exec(text)?.[1];
  if (host) {
    const svc = host.split('.')[0];
    return { title: t("The log shows host {host} could not be resolved.", { host }), hint: t("The Service {svc} may be missing in namespace {ns}.", { svc, ns: p.namespace }) };
  }
  const refused = /ECONNREFUSED ([\w.:-]+)/.exec(text)?.[1] ?? /dial tcp ([\w.:-]+): connect: connection refused/.exec(text)?.[1] ?? (/connection refused/i.test(text) ? '' : null);
  if (refused != null) {
    return {
      title: refused ? t("The log shows the connection to {target} was refused.", { target: refused }) : t("The log shows a connection was refused."),
      hint: t("The target service may not be ready yet, or the port is wrong."),
    };
  }
  if (p.status === 'CrashLoopBackOff' || p.restarts > 3) {
    const code = p.lastExitCode != null ? t(" (exit {code})", { code: p.lastExitCode }) : '';
    return { title: t("The container keeps exiting{code}.", { code }), hint: t("Look at the previous log (--previous) for the cause.") };
  }
  return null;
}
