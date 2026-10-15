import { describe, expect, it } from 'vitest';
import type { Container, Project } from '../api';
import { projectStatus } from './projects';

const proj = (services: string[]): Project => ({
  id: '1', name: 'shop', path: '/p', composeProject: 'shop', contextId: 'default', composeFile: 'compose.yaml', hasDockerfile: false,
  services: services.map((name) => ({ name, image: 'x', ports: [] })), lastOpenedAt: '', createdAt: '',
});
const c = (service: string, state: Container['state'], project = 'shop'): Container => ({
  id: service, name: `${project}-${service}-1`, image: 'x', imageId: '', state, status: '', health: null, created: 0,
  project, service, workingDir: null, ports: [], networks: [], mounts: [],
});

describe('projectStatus', () => {
  it('running when every service runs', () => {
    const s = projectStatus(proj(['api', 'db']), [c('api', 'running'), c('db', 'running')]);
    expect(s.label).toBe('Running');
    expect(s.pillCls).toBe('pill run');
  });
  it('partial when only some run', () => {
    const s = projectStatus(proj(['api', 'db', 'redis']), [c('api', 'running'), c('db', 'exited')]);
    expect(s.label).toBe('Partial 1/3');
    expect(s.svcs.map((x) => x.state)).toEqual(['running', 'exited', null]);
  });
  it('stopped when no service runs; containers of other projects are ignored', () => {
    const s = projectStatus(proj(['api']), [c('api', 'running', 'other')]);
    expect(s.label).toBe('Stopped');
    expect(s.up).toBe(0);
  });
  it('project with only a Dockerfile', () => {
    const s = projectStatus(proj([]), []);
    expect(s.hasCompose).toBe(false);
    expect(s.label).toBe('Dockerfile');
  });
});
