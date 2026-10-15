import { describe, expect, it } from 'vitest';
import type { K8sDeployment, K8sPod, K8sService } from '../api';
import { authDetail, explainPod, fmtAge, isAuthError, podTone, podsOf, runningSummary, svcPorts } from './k8s';

const pod = (over: Partial<K8sPod> = {}): K8sPod => ({
  namespace: 'shop', name: 'api-7f9c6b5d4-x2kqp', status: 'Running', phase: 'Running', ready: '1/1', restarts: 0, created: 0, node: 'n1',
  containers: ['api'], labels: { app: 'api' }, owner: null, waitingReason: null, waitingMessage: null, lastTerminatedReason: null, lastExitCode: null, deleting: false,
  ...over,
});

describe('k8s helpers', () => {
  it('podTone colors statuses', () => {
    expect(podTone('Running')).toBe('run');
    expect(podTone('ContainerCreating')).toBe('part');
    expect(podTone('Terminating')).toBe('part');
    expect(podTone('Init:0/1')).toBe('part');
    expect(podTone('CrashLoopBackOff')).toBe('bad');
    expect(podTone('Init:CrashLoopBackOff')).toBe('bad');
    expect(podTone('Error')).toBe('bad');
    expect(podTone('Completed')).toBe('');
  });

  it('isAuthError recognises 401 / exec plugin failures in both languages', () => {
    expect(isAuthError('Unauthorized: the token was rejected (401)')).toBe(true);
    expect(isAuthError('Không xác thực được: token hết hạn')).toBe(true);
    expect(isAuthError('pods is forbidden')).toBe(false);
    expect(authDetail('Unauthorized: token expired')).toBe('token expired');
  });

  it('svcPorts and fmtAge', () => {
    const s: K8sService = { namespace: 'a', name: 'web', type: 'NodePort', clusterIp: '10.0.0.1', selector: {}, created: 0,
      ports: [{ name: null, port: 80, targetPort: '8080', nodePort: 30080, protocol: 'TCP' }, { name: 'tls', port: 443, targetPort: null, nodePort: null, protocol: 'TCP' }] };
    expect(svcPorts(s)).toBe('80:30080/TCP, 443/TCP');
    const now = 1_000_000_000_000;
    expect(fmtAge(now / 1000 - 30, now)).toBe('30s');
    expect(fmtAge(now / 1000 - 600, now)).toBe('10m');
    expect(fmtAge(now / 1000 - 7200, now)).toBe('2h');
    expect(fmtAge(now / 1000 - 2 * 86400, now)).toBe('2d');
    expect(fmtAge(0, now)).toBe('—');
  });

  it('podsOf matches the selector inside the namespace', () => {
    const d: K8sDeployment = { namespace: 'shop', name: 'api', replicas: 2, ready: 2, updated: 2, available: 2, image: 'x', selector: { app: 'api' }, created: 0 };
    const pods = [pod(), pod({ name: 'b', labels: { app: 'web' } }), pod({ name: 'c', namespace: 'other' }), pod({ name: 'd', status: 'Pending' })];
    expect(podsOf(d, pods).map((p) => p.name)).toEqual(['api-7f9c6b5d4-x2kqp', 'd']);
    expect(runningSummary(pods)).toBe('3 / 4 Running');
  });

  it('explainPod reads status reasons and log patterns', () => {
    expect(explainPod(pod())).toBeNull();
    expect(explainPod(pod({ status: 'CrashLoopBackOff', lastTerminatedReason: 'OOMKilled' }))?.title).toMatch(/OOMKilled/);
    expect(explainPod(pod({ status: 'ImagePullBackOff', waitingReason: 'ImagePullBackOff', waitingMessage: 'not found' }))?.title).toMatch(/cannot be pulled \(not found\)/);
    const dns = explainPod(pod({ status: 'CrashLoopBackOff' }), ['Error: getaddrinfo ENOTFOUND rabbitmq']);
    expect(dns?.title).toMatch(/rabbitmq/);
    expect(dns?.hint).toMatch(/Service rabbitmq .*shop/);
    expect(explainPod(pod({ status: 'CrashLoopBackOff' }), ['dial tcp 10.0.0.5:5432: connect: connection refused'])?.title).toMatch(/10\.0\.0\.5:5432/);
    expect(explainPod(pod({ status: 'CrashLoopBackOff', lastExitCode: 1 }), ['boom'])?.title).toMatch(/exit 1/);
  });
});
