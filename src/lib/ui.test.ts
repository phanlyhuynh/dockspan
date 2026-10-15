import { describe, expect, it } from 'vitest';
import { portText, portUrl, relDay, runCommand, withTag } from './ui';

describe('ui helpers', () => {
  const ports = [
    { ip: '0.0.0.0', privatePort: 3000, publicPort: 3000, type: 'tcp' },
    { ip: '::', privatePort: 3000, publicPort: 3000, type: 'tcp' },
    { privatePort: 5432, type: 'tcp' },
  ];
  it('merges duplicate IPv4/IPv6 ports', () => {
    expect(portText({ ports })).toBe('3000→3000, 5432');
  });
  it('link opens localhost for the host-mapped port', () => {
    expect(portUrl({ ports })).toBe('http://localhost:3000');
    expect(portUrl({ ports: [{ privatePort: 80, type: 'tcp' }] })).toBeNull();
  });
  it('withTag appends :latest when the tag is missing', () => {
    expect(withTag('nginx')).toBe('nginx:latest');
    expect(withTag('localhost:5000/app')).toBe('localhost:5000/app:latest');
    expect(withTag('mongo:7')).toBe('mongo:7');
  });
  it('relDay', () => {
    const now = new Date(2026, 9, 14, 12);
    expect(relDay(new Date(2026, 9, 14, 1).toISOString(), now)).toBe('today');
    expect(relDay(new Date(2026, 9, 13, 23).toISOString(), now)).toBe('yesterday');
    expect(relDay(new Date(2026, 9, 11, 9).toISOString(), now)).toBe('3 days ago');
  });
  it('equivalent docker run command', () => {
    expect(runCommand({ image: 'nginx:alpine', cname: 'web', port: '8080:80', vol: 'my-data:/data', env: 'NODE_ENV=production', restart: 'unless-stopped', startNow: true }))
      .toBe('docker run -d --name web -p 8080:80 -v my-data:/data -e NODE_ENV=production --restart unless-stopped nginx:alpine');
  });
});
