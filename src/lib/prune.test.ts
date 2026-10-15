import { describe, expect, it } from 'vitest';
import type { Container, DfInfo, ImageRow, NetworkRow, VolumeRow } from '../api';
import { computePruneDefs, DEFAULT_PRUNE_SEL, selectedTotal, sumBytes } from './prune';

const ctr = (o: Partial<Container>): Container => ({
  id: 'c', name: 'c', image: 'x', imageId: '', state: 'running', status: '', health: null, created: 0,
  project: null, service: null, workingDir: null, ports: [], networks: [], mounts: [], ...o,
});
const net = (name: string, system = false): NetworkRow => ({ id: name, name, driver: 'bridge', scope: 'local', subnet: '', gateway: '', system });
const vol = (name: string): VolumeRow => ({ name, driver: 'local', mountpoint: '', createdAt: '' });
const img = (id: string, dangling: boolean, size: number): ImageRow => ({ id, repo: dangling ? '<none>' : 'a', tag: dangling ? '<none>' : 'b', size, created: 0, dangling });

const df: DfInfo = {
  imagesSize: 0, volumesSize: 0, cacheSize: 0, containersSize: 0,
  volumes: [{ name: 'orphan', size: 340, refCount: 0 }, { name: 'used', size: 820, refCount: 1 }],
  cache: [{ id: 'k1', description: 'layer', size: 600, inUse: false, type: 'regular' }, { id: 'k2', description: 'busy', size: 900, inUse: true, type: 'regular' }],
  containerSizes: { stopped1: 30, stopped2: 12 },
};

describe('computePruneDefs', () => {
  const defs = computePruneDefs({
    containers: [
      ctr({ id: 'stopped1', name: 'old-1', state: 'exited', networks: ['proj_default'] }),
      ctr({ id: 'stopped2', name: 'old-2', state: 'exited' }),
      ctr({ id: 'run', name: 'web', state: 'running', networks: ['web_default'], mounts: [{ type: 'volume', name: 'used', source: '', destination: '/d' }] }),
    ],
    images: [img('sha256:aaaaaaaaaaaaaaaa', true, 890), img('sha256:b', false, 100)],
    networks: [net('bridge', true), net('proj_default'), net('web_default'), net('lonely')],
    volumes: [vol('orphan'), vol('used')],
    df,
  });
  const by = (id: string) => defs.find((d) => d.id === id)!;

  it('only selects Exited containers and takes sizes from system df', () => {
    expect(by('containers').items.map((i) => i.name)).toEqual(['old-1', 'old-2']);
    expect(sumBytes(by('containers'))).toBe(42);
  });

  it('only selects dangling images', () => {
    expect(by('images').items).toEqual([{ name: 'aaaaaaaaaaaa  <none>', bytes: 890 }]);
  });

  it('a network counts as in use even for stopped containers, and system networks are skipped', () => {
    expect(by('networks').items.map((i) => i.name)).toEqual(['lonely']);
  });

  it('a volume is unused only when no container mounts it', () => {
    expect(by('volumes').items).toEqual([{ name: 'orphan', bytes: 340 }]);
  });

  it('build cache skips entries in use', () => {
    expect(sumBytes(by('cache'))).toBe(600);
  });

  it('the default selection total excludes volumes', () => {
    expect(selectedTotal(defs, DEFAULT_PRUNE_SEL)).toBe(42 + 890 + 600);
    expect(selectedTotal(defs, { ...DEFAULT_PRUNE_SEL, volumes: true })).toBe(42 + 890 + 600 + 340);
  });

  it('empty items are not counted', () => {
    const none = computePruneDefs({ containers: [], images: [], networks: [], volumes: [], df: null });
    expect(selectedTotal(none, { containers: true, images: true, networks: true, cache: true, volumes: true })).toBe(0);
  });
});
