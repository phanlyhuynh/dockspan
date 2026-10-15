export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface LogLine {
  /** Display time HH:mm:ss (local time). */
  t: string;
  /** Epoch time in ms, used to resume logs (`since`). */
  ms: number;
  stream: 'stdout' | 'stderr';
  lvl: LogLevel;
  msg: string;
}

const RE_ERROR = /\b(ERROR|ERR|FATAL|PANIC|CRITICAL)\b/i;
const RE_WARN = /\b(WARN|WARNING)\b/i;
const RE_DEBUG = /\b(DEBUG|TRACE)\b/i;

/**
 * Infer the log level from the content with regexes; stderr defaults to WARN or higher
 * when the content says nothing else.
 */
export function parseLevel(text: string, stream: 'stdout' | 'stderr' = 'stdout'): LogLevel {
  if (RE_ERROR.test(text)) return 'ERROR';
  if (RE_WARN.test(text)) return 'WARN';
  if (RE_DEBUG.test(text)) return 'DEBUG';
  return stream === 'stderr' ? 'WARN' : 'INFO';
}

/** Convert a raw line from the backend ({ts, stream, text}) into a LogLine. */
export function toLogLine(raw: { ts: string; stream: string; text: string }): LogLine {
  const ms = raw.ts ? Date.parse(raw.ts) : Date.now();
  const d = new Date(Number.isNaN(ms) ? Date.now() : ms);
  const stream = raw.stream === 'stderr' ? 'stderr' : 'stdout';
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    t: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    ms: d.getTime(),
    stream,
    lvl: parseLevel(raw.text, stream),
    msg: raw.text,
  };
}

export const LOG_BUFFER = 5000;

/** Append new lines, keeping at most the last LOG_BUFFER lines. */
export function appendLogs(buf: LogLine[], more: LogLine[], cap: number = LOG_BUFFER): LogLine[] {
  const next = buf.length + more.length > cap ? buf.concat(more).slice(-cap) : buf.concat(more);
  return next;
}

export function filterLogs(lines: LogLine[], level: 'ALL' | LogLevel, q: string, clearedAtMs = 0): LogLine[] {
  const needle = q.trim().toLowerCase();
  return lines.filter(
    (l) => l.ms > clearedAtMs && (level === 'ALL' || l.lvl === level) && (!needle || l.msg.toLowerCase().includes(needle)),
  );
}
