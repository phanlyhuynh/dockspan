import type { CState, Container, PortMap } from '../api';
import { t } from '../i18n';

export type DisplayState = CState | 'starting' | 'stopping';

export const stateLabel = (s: DisplayState): string =>
  ({
    running: t("Running"), exited: t("Stopped"), created: t("Created"), paused: t("Paused"),
    restarting: t("Restarting…"), dead: t("Error (dead)"), removing: t("Removing…"),
    starting: t("Starting…"), stopping: t("Stopping…"),
  })[s];

export function dotClass(s: DisplayState): string {
  if (s === 'running') return 'dot run';
  if (s === 'starting' || s === 'stopping' || s === 'restarting' || s === 'removing' || s === 'paused') return 'dot busy';
  if (s === 'dead') return 'dot bad';
  return 'dot';
}

export function isBusyState(s: DisplayState): boolean {
  return s === 'starting' || s === 'stopping' || s === 'restarting' || s === 'removing';
}

/** Merge duplicate IPv4/IPv6 ports and leave ports not mapped to the host out of the link list. */
export function mappedPorts(ports: PortMap[]): PortMap[] {
  const seen = new Set<string>();
  const out: PortMap[] = [];
  for (const p of ports) {
    const key = `${p.publicPort ?? ''}:${p.privatePort}/${p.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function portText(c: Pick<Container, 'ports'>): string {
  const ps = mappedPorts(c.ports);
  if (!ps.length) return '';
  const txt = ps.map((p) => (p.publicPort ? `${p.publicPort}→${p.privatePort}` : `${p.privatePort}`));
  return txt.length > 3 ? `${txt.slice(0, 3).join(', ')} +${txt.length - 3}` : txt.join(', ');
}

export function portUrl(c: Pick<Container, 'ports'>): string | null {
  const p = mappedPorts(c.ports).find((x) => x.publicPort && x.type === 'tcp');
  return p ? `http://localhost:${p.publicPort}` : null;
}

/** "today", "yesterday", "N days ago" from an ISO string. */
export function relDay(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const d = Math.round((a - b) / 86400000);
  if (d <= 0) return t("today");
  if (d === 1) return t("yesterday");
  return t("{d} days ago", { d });
}

/** Tag name after normalization: append :latest when the tag is missing. */
export function withTag(img: string): string {
  const i = img.trim();
  return i.lastIndexOf(':') <= i.lastIndexOf('/') ? `${i}:latest` : i;
}

export const imgRef = (im: { repo: string; tag: string; dangling?: boolean }): string => (im.repo === '<none>' ? '<none>:<none>' : `${im.repo}:${im.tag}`);

/** Split a hand-typed list separated by commas or whitespace. */
export function splitList(v: string): string[] {
  return v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
}

/** Equivalent `docker run` command for the form (updates with every keystroke). */
export function runCommand(f: { image: string; cname: string; port: string; vol: string; env: string; restart: string; startNow: boolean }): string {
  const parts = ['docker', f.startNow ? 'run -d' : 'create'];
  if (f.cname.trim()) parts.push('--name', f.cname.trim());
  for (const p of splitList(f.port)) parts.push('-p', p);
  for (const v of splitList(f.vol)) parts.push('-v', v);
  for (const line of f.env.split('\n')) if (line.trim()) parts.push('-e', line.trim());
  if (f.restart && f.restart !== 'no') parts.push('--restart', f.restart);
  parts.push(f.image || '<image>');
  return parts.join(' ');
}

let homeDir = '';
export function setHome(h: string) {
  homeDir = h.replace(/[\\/]+$/, '');
}
/** Shorten the home directory to `~` for readability. */
export function shortPath(p: string): string {
  return homeDir && p.startsWith(homeDir) ? `~${p.slice(homeDir.length)}` : p;
}
