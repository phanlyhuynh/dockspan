import type { CtxInfo, NewCtx } from '../api';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Short label of a connection type, e.g. on cards and in the context menu. */
export function ctxTypeLabel(c: Pick<CtxInfo, 'kind' | 'tls'>): string {
  if (c.kind === 'tcp') return c.tls ? 'TLS' : 'TCP';
  return ({ local: 'Local', ssh: 'SSH', wsl: 'WSL2' } as Record<string, string>)[c.kind] ?? c.kind;
}

/** Display name suggested from the form: `wsl-ubuntu-24-04`, the first part of the host, the runtime of a socket… */
export function suggestName(f: NewCtx): string {
  if (f.kind === 'wsl') return f.distro ? `wsl-${slug(f.distro)}` : '';
  if (f.kind === 'local') {
    const sock = f.socket ?? '';
    const m = /\.(colima|orbstack|rd)\b/.exec(sock) ?? /\/(podman|docker)[^/]*$/.exec(sock);
    return m ? slug(m[1]) : '';
  }
  const host = (f.host ?? '').replace(/^tcp:\/\//, '').replace(/:\d+$/, '');
  if (!host) return '';
  // An IP keeps all its parts (10-0-0-25), a host name only its first label (prod.example.com → prod).
  return /^[\d.]+$/.test(host) ? slug(host) : slug(host.split('.')[0]);
}

/** Endpoint the form produces, as the backend builds it (`from_form` in ctx.rs). */
export function formEndpoint(f: NewCtx): string {
  switch (f.kind) {
    case 'local': {
      const s = (f.socket ?? '').trim();
      return s.includes('://') ? s : `unix://${s}`;
    }
    case 'ssh': {
      const port = f.port && f.port !== 22 ? `:${f.port}` : '';
      return `ssh://${f.user ? `${f.user}@` : ''}${f.host ?? ''}${port}`;
    }
    case 'tcp': {
      const h = (f.host ?? '').replace(/^tcp:\/\//, '');
      return `tcp://${/:\d+$/.test(h) ? h : `${h}:${f.tls ? 2376 : 2375}`}`;
    }
    case 'wsl':
      return `wsl://${f.distro ?? ''}`;
  }
}

/** The equivalent CLI command shown under the form. */
export function equivalentCommand(f: NewCtx, name: string): string {
  const n = name || '<name>';
  if (f.kind === 'wsl') return `wsl -d ${f.distro || '<distro>'} -u root -- docker system dial-stdio`;
  if (f.kind === 'tcp' && f.tls) {
    const d = (f.certDir || '<certs>').replace(/[\\/]+$/, '');
    return `docker context create ${n} --docker "host=${formEndpoint(f)},ca=${d}/ca.pem,cert=${d}/cert.pem,key=${d}/key.pem"`;
  }
  const cmd = `docker context create ${n} --docker host=${formEndpoint(f)}`;
  return f.kind === 'ssh' && f.key ? `${cmd}   # key: ${f.key}` : cmd;
}
