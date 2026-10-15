import { describe, expect, it } from 'vitest';
import { appendLogs, filterLogs, parseLevel, toLogLine, type LogLine } from './logs';

describe('parseLevel', () => {
  it('detects ERROR/ERR/FATAL', () => {
    expect(parseLevel('POST /api/checkout 500 ERROR payment timeout')).toBe('ERROR');
    expect(parseLevel('ERR connection refused')).toBe('ERROR');
    expect(parseLevel('fatal: cannot open')).toBe('ERROR');
  });
  it('detects WARN and DEBUG', () => {
    expect(parseLevel('[WARN] slow query')).toBe('WARN');
    expect(parseLevel('WARNING: memory overcommit')).toBe('WARN');
    expect(parseLevel('debug redis ready')).toBe('DEBUG');
  });
  it('defaults to INFO, stderr defaults to WARN', () => {
    expect(parseLevel('GET /health 200')).toBe('INFO');
    expect(parseLevel('listening on 0.0.0.0', 'stderr')).toBe('WARN');
  });
  it('an explicit level in the text wins over stderr', () => {
    expect(parseLevel('ERROR boom', 'stderr')).toBe('ERROR');
    expect(parseLevel('DEBUG noise', 'stderr')).toBe('DEBUG');
  });
  it('does not confuse words containing ERR', () => {
    expect(parseLevel('terrain loaded')).toBe('INFO');
    expect(parseLevel('interrupted by user')).toBe('INFO');
  });
});

describe('toLogLine / appendLogs / filterLogs', () => {
  it('reads an RFC3339 timestamp and assigns a level', () => {
    const l = toLogLine({ ts: '2026-10-14T07:30:05.123456789Z', stream: 'stderr', text: 'ERROR x' });
    expect(l.lvl).toBe('ERROR');
    expect(l.ms).toBe(Date.parse('2026-10-14T07:30:05.123Z'));
    expect(l.stream).toBe('stderr');
  });
  it('keeps the buffer within its limit', () => {
    const mk = (n: number): LogLine => ({ t: '', ms: n, stream: 'stdout', lvl: 'INFO', msg: String(n) });
    const out = appendLogs([mk(1), mk(2), mk(3)], [mk(4), mk(5)], 4);
    expect(out.map((l) => l.msg)).toEqual(['2', '3', '4', '5']);
  });
  it('filters by level, case-insensitive keyword and the clear-screen mark', () => {
    const lines: LogLine[] = [
      { t: '', ms: 1, stream: 'stdout', lvl: 'INFO', msg: 'GET /Cart' },
      { t: '', ms: 2, stream: 'stdout', lvl: 'ERROR', msg: 'POST /checkout' },
      { t: '', ms: 3, stream: 'stdout', lvl: 'ERROR', msg: 'GET /cart failed' },
    ];
    expect(filterLogs(lines, 'ERROR', '', 0)).toHaveLength(2);
    expect(filterLogs(lines, 'ALL', 'CART', 0)).toHaveLength(2);
    expect(filterLogs(lines, 'ALL', '', 2).map((l) => l.ms)).toEqual([3]);
  });
});
