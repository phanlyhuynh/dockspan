import type { Container, DfInfo, ImageRow, NetworkRow, VolumeRow } from '../api';
import { t } from '../i18n';

export type PruneId = 'containers' | 'images' | 'networks' | 'cache' | 'volumes';

export interface PruneItem { name: string; bytes: number }
export interface PruneDef {
  id: PruneId;
  title: string;
  desc: string;
  cmd: string;
  items: PruneItem[];
}

export interface PruneInput {
  containers: Container[];
  images: ImageRow[];
  networks: NetworkRow[];
  volumes: VolumeRow[];
  df: DfInfo | null;
}

/**
 * Compute the list of items to be cleaned from existing data (the Engine has no dry-run mode).
 * The "in use" rule matches the Engine: a network/volume counts as used if
 * ANY container (even a stopped one) references it.
 */
export function computePruneDefs(inp: PruneInput): PruneDef[] {
  const { containers, images, networks, volumes, df } = inp;
  const exited = containers.filter((c) => c.state === 'exited');
  const dangling = images.filter((im) => im.dangling);
  const usedNets = new Set(containers.flatMap((c) => c.networks));
  const unusedNets = networks.filter((n) => !n.system && !usedNets.has(n.name));
  const usedVols = new Set(containers.flatMap((c) => c.mounts.filter((m) => m.type === 'volume' && m.name).map((m) => m.name as string)));
  const volSize = new Map((df?.volumes ?? []).map((v) => [v.name, Math.max(0, v.size)]));
  const unusedVols = volumes.filter((v) => !usedVols.has(v.name));
  const cache = (df?.cache ?? []).filter((c) => !c.inUse && c.size > 0);

  return [
    {
      id: 'containers', title: t("Stopped containers"), desc: t("Remove containers in the Exited state"), cmd: 'docker container prune',
      items: exited.map((c) => ({ name: c.name, bytes: df?.containerSizes?.[c.id] ?? 0 })),
    },
    {
      id: 'images', title: 'Images dangling', desc: t("<none> images with no tag, usually left over after rebuilding"), cmd: 'docker image prune',
      items: dangling.map((im) => ({ name: `${im.id.replace(/^sha256:/, '').slice(0, 12)}  <none>`, bytes: im.size })),
    },
    {
      id: 'networks', title: t("Unused networks"), desc: t("Networks with no container attached"), cmd: 'docker network prune',
      items: unusedNets.map((n) => ({ name: n.name, bytes: 0 })),
    },
    {
      id: 'cache', title: 'Build cache', desc: t("Layer cache from image builds"), cmd: 'docker builder prune -a',
      items: cache.map((c) => ({ name: c.description ? c.description.slice(0, 64) : c.id.slice(0, 12), bytes: c.size })),
    },
    {
      id: 'volumes', title: t("Unused volumes"), desc: t("Volumes not attached to any container. May hold real data!"), cmd: 'docker volume prune -a',
      items: unusedVols.map((v) => ({ name: v.name, bytes: volSize.get(v.name) ?? 0 })),
    },
  ];
}

export const sumBytes = (d: PruneDef): number => d.items.reduce((a, i) => a + i.bytes, 0);

/** Total space freed for the selected items (empty items are not counted). */
export function selectedTotal(defs: PruneDef[], sel: Record<PruneId, boolean>): number {
  return defs.filter((d) => sel[d.id] && d.items.length).reduce((a, d) => a + sumBytes(d), 0);
}

export const DEFAULT_PRUNE_SEL: Record<PruneId, boolean> = { containers: true, images: true, networks: true, cache: true, volumes: false };
