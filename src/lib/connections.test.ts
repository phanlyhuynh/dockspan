import { describe, expect, it } from 'vitest';
import { ctxTypeLabel, equivalentCommand, formEndpoint, suggestName } from './connections';

describe('connection form helpers', () => {
  it('suggests a name from the form', () => {
    expect(suggestName({ name: '', kind: 'wsl', distro: 'Ubuntu-24.04' })).toBe('wsl-ubuntu-24-04');
    expect(suggestName({ name: '', kind: 'ssh', host: 'prod.example.com' })).toBe('prod');
    expect(suggestName({ name: '', kind: 'tcp', host: '10.0.0.25:2376' })).toBe('10-0-0-25');
    expect(suggestName({ name: '', kind: 'local', socket: '~/.colima/default/docker.sock' })).toBe('colima');
    expect(suggestName({ name: '', kind: 'ssh' })).toBe('');
  });

  it('builds endpoints like the backend', () => {
    expect(formEndpoint({ name: '', kind: 'ssh', host: '203.0.113.10', user: 'deploy', port: 22 })).toBe('ssh://deploy@203.0.113.10');
    expect(formEndpoint({ name: '', kind: 'ssh', host: 'h', port: 2222 })).toBe('ssh://h:2222');
    expect(formEndpoint({ name: '', kind: 'tcp', host: '10.0.0.25', tls: true })).toBe('tcp://10.0.0.25:2376');
    expect(formEndpoint({ name: '', kind: 'tcp', host: 'tcp://10.0.0.25:2375' })).toBe('tcp://10.0.0.25:2375');
    expect(formEndpoint({ name: '', kind: 'local', socket: '/var/run/docker.sock' })).toBe('unix:///var/run/docker.sock');
  });

  it('shows the equivalent command', () => {
    expect(equivalentCommand({ name: '', kind: 'ssh', host: '203.0.113.10', user: 'deploy' }, 'prod')).toBe('docker context create prod --docker host=ssh://deploy@203.0.113.10');
    expect(equivalentCommand({ name: '', kind: 'tcp', host: 'h:2376', tls: true, certDir: '/c/' }, 'x')).toBe('docker context create x --docker "host=tcp://h:2376,ca=/c/ca.pem,cert=/c/cert.pem,key=/c/key.pem"');
    expect(equivalentCommand({ name: '', kind: 'wsl', distro: 'Debian' }, 'w')).toBe('wsl -d Debian -u root -- docker system dial-stdio');
  });

  it('labels connection types', () => {
    expect(ctxTypeLabel({ kind: 'tcp', tls: true })).toBe('TLS');
    expect(ctxTypeLabel({ kind: 'wsl', tls: false })).toBe('WSL2');
  });
});
