import { describe, expect, it } from 'vitest';
import { maskEnv, MASK } from './env';

describe('maskEnv', () => {
  it('hides sensitive keys', () => {
    const out = maskEnv('API_TOKEN=abc123\nDB_PASSWORD=hunter2\nJWT_SECRET=s\nNODE_ENV=development');
    expect(out).toBe(`API_TOKEN=${MASK}\nDB_PASSWORD=${MASK}\nJWT_SECRET=${MASK}\nNODE_ENV=development`);
  });
  it('hides the password in a URL and keeps the rest', () => {
    expect(maskEnv('DATABASE_URL=postgres://app:topsecret@db:5432/shop')).toBe(`DATABASE_URL=postgres://app:${MASK}@db:5432/shop`);
  });
  it('leaves comments, blank lines and empty values alone', () => {
    expect(maskEnv('# PASSWORD=abc\n\nSMTP_PASSWORD=')).toBe('# PASSWORD=abc\n\nSMTP_PASSWORD=');
  });
  it('keeps the export prefix', () => {
    expect(maskEnv('export API_KEY=zzz')).toBe(`export API_KEY=${MASK}`);
  });
});
