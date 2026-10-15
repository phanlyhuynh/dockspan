import type { CtxInfo, SavedSsh, SshHost, SshTarget } from '../api';

export type SshSource = 'config' | 'context' | 'app';

/** One row of the SSH page. */
export interface SshEntry {
  id: string; name: string; source: SshSource; target: SshTarget;
  /** `user@host:port` as it will be reached. */
  address: string; key: string | null; jump: string | null;
}

/** `ssh://user@host:port` → target (IPv6 in brackets keeps its colons). */
export function parseSshEndpoint(endpoint: string): SshTarget {
  let rest = endpoint.replace(/^ssh:\/\//, '').replace(/\/+$/, '');
  let user: string | null = null;
  const at = rest.lastIndexOf('@');
  if (at >= 0) { user = rest.slice(0, at); rest = rest.slice(at + 1); }
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(rest);
  return m ? { host: m[1], user, port: Number(m[2]) } : { host: rest, user, port: null };
}

const address = (host: string, user?: string | null, port?: number | null) => `${user ? `${user}@` : ''}${host}${port && port !== 22 ? `:${port}` : ''}`;
const same = (a: SshTarget, b: SshTarget) => a.host === b.host && (a.user ?? null) === (b.user ?? null) && (a.port ?? 22) === (b.port ?? 22);

/**
 * All SSH hosts: `~/.ssh/config` aliases first, then SSH Docker contexts, then hosts added in the app.
 * A context that points at a config alias (or the same host as another entry) is not listed twice.
 */
export function sshEntries(config: SshHost[], contexts: CtxInfo[], saved: SavedSsh[]): SshEntry[] {
  const out: SshEntry[] = config.map((h) => ({
    id: `config:${h.alias}`, name: h.alias, source: 'config', target: { host: h.alias },
    address: address(h.hostname, h.user, h.port), key: h.identityFile, jump: h.proxyJump,
  }));
  for (const c of contexts.filter((x) => x.kind === 'ssh')) {
    const t = { ...parseSshEndpoint(c.endpoint), key: c.sshKey };
    if (out.some((e) => same(e.target, t))) continue;
    out.push({ id: `context:${c.id}`, name: c.name, source: 'context', target: t, address: address(t.host, t.user, t.port), key: c.sshKey, jump: null });
  }
  for (const s of saved) {
    out.push({ id: `app:${s.name}`, name: s.name, source: 'app', target: { host: s.host, user: s.user, port: s.port, key: s.key }, address: address(s.host, s.user, s.port), key: s.key, jump: null });
  }
  return out;
}
