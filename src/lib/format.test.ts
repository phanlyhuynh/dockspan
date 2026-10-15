import { describe, expect, it } from 'vitest';
import { fmtBytes, fmtMem, relTime, shortId } from './format';

describe('format', () => {
  it('fmtBytes uses decimal units like docker', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(312_000_000)).toBe('312 MB');
    expect(fmtBytes(3_800_000_000)).toBe('3.8 GB');
    expect(fmtBytes(41_000)).toBe('41 kB');
  });
  it('fmtMem uses binary units', () => {
    expect(fmtMem(190_840_832)).toBe('182 MB');
    expect(fmtMem(1_073_741_824)).toBe('1.0 GB');
  });
  it('relTime in English', () => {
    const now = 1_000_000_000_000;
    const at = (s: number) => now / 1000 - s;
    expect(relTime(at(10), now)).toBe('just now');
    expect(relTime(at(2 * 3600), now)).toBe('2 hours ago');
    expect(relTime(at(3 * 86400), now)).toBe('3 days ago');
    expect(relTime(at(21 * 86400), now)).toBe('3 weeks ago');
    expect(relTime(at(70 * 86400), now)).toBe('2 months ago');
  });
  it('shortId drops the sha256 prefix', () => {
    expect(shortId('sha256:0123456789abcdef0123')).toBe('0123456789ab');
  });
});
