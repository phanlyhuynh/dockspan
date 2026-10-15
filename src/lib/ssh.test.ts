import { describe, expect, it } from 'vitest';
import type { CtxInfo } from '../api';
import { parseSshEndpoint, sshEntries } from './ssh';

const ctx = (id: string, endpoint: string, sshKey: string | null = null): CtxInfo => ({
  id, name: id, kind: 'ssh', endpoint, supported: true, active: false, reason: null, description: '', source: 'docker',
  tls: false, tlsDir: null, skipTlsVerify: false, sshKey, wslDistro: null,
});

describe('ssh hosts', () => {
  it('parses ssh endpoints', () => {
    expect(parseSshEndpoint('ssh://deploy@203.0.113.10')).toEqual({ host: '203.0.113.10', user: 'deploy', port: null });
    expect(parseSshEndpoint('ssh://deploy@203.0.113.10:2222')).toEqual({ host: '203.0.113.10', user: 'deploy', port: 2222 });
    expect(parseSshEndpoint('ssh://prod-db')).toEqual({ host: 'prod-db', user: null, port: null });
    expect(parseSshEndpoint('ssh://me@[::1]:22')).toEqual({ host: '[::1]', user: 'me', port: 22 });
  });

  it('merges config, contexts and saved hosts without duplicates', () => {
    const list = sshEntries(
      [{ alias: 'prod-db', hostname: '10.20.0.5', user: 'ops', port: 2222, identityFile: '~/.ssh/id_prod', proxyJump: 'bastion' }],
      [ctx('prod-db-ctx', 'ssh://prod-db'), ctx('build', 'ssh://deploy@203.0.113.20', '~/.ssh/id_build'), { ...ctx('local', 'unix:///x'), kind: 'local' }],
      [{ name: 'lab', host: '192.168.1.9', user: 'pi', port: 2200, key: null }],
    );
    expect(list.map((e) => [e.id, e.address])).toEqual([
      ['config:prod-db', 'ops@10.20.0.5:2222'],
      ['context:build', 'deploy@203.0.113.20'],
      ['app:lab', 'pi@192.168.1.9:2200'],
    ]);
    expect(list[0].target).toEqual({ host: 'prod-db' });
    expect(list[1].target).toEqual({ host: '203.0.113.20', user: 'deploy', port: null, key: '~/.ssh/id_build' });
    expect(list[0].jump).toBe('bastion');
  });
});
