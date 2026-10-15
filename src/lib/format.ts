import { t } from '../i18n';
/** Disk size in decimal units, like `docker images` / `docker system df`. */
export function fmtBytes(b: number): string {
  if (!b || b <= 0) return '0 B';
  if (b < 1000) return `${Math.round(b)} B`;
  if (b < 1e6) return `${Math.round(b / 1e3)} kB`;
  if (b < 1e9) return `${Math.round(b / 1e6)} MB`;
  return `${(b / 1e9).toFixed(1)} GB`;
}

/** Memory in binary units (docker stats): MB, GB. */
export function fmtMem(b: number): string {
  if (!b || b <= 0) return '0 MB';
  const mb = b / 1048576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(mb))} MB`;
}

export function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

/** Relative time (localized) from an epoch timestamp in seconds. */
export function relTime(epochSec: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000 - epochSec));
  if (diff < 60) return t("just now");
  const m = Math.floor(diff / 60);
  if (m < 60) return t("{m} minutes ago", { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("{h} hours ago", { h });
  const d = Math.floor(h / 24);
  if (d < 7) return t("{d} days ago", { d });
  if (d < 30) return t("{v0} weeks ago", { v0: Math.floor(d / 7) });
  if (d < 365) return t("{v0} months ago", { v0: Math.floor(d / 30) });
  return t("{v0} years ago", { v0: Math.floor(d / 365) });
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function hhmm(d: Date = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function hhmmss(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}
