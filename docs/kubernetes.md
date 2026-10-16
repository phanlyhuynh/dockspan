# Kubernetes

The Kubernetes page is **independent of the Docker context**: switching Docker engines never touches it. Back to the [README](../README.md).

## Clusters

- Clusters are the contexts of `$KUBECONFIG` / `~/.kube/config`, plus contexts added from other kubeconfig files.
- The kubeconfig is never modified. **Remove** only hides a cluster in the app.
- Per cluster, Dockspan checks the version and the nodes.

## Namespaces

- Use the namespace filter to narrow the lists.
- Users limited to one namespace (403 on cluster-wide lists) fall back to the context's namespace.

## Workloads

- **Deployments:** scale, rollout restart.
- **Pods:** status like `kubectl`, logs with `--previous` / follow and an explanation for common failures, an exec terminal, delete.
- **Services:** list, and port-forward from here.

Lists refresh through watches, not polling.

## Port-forward

- Forwards to `127.0.0.1`; privileged ports get +8000.
- Each connection picks a Ready pod again, so a forward survives pod replacement.

## Authentication

Exec auth plugins (gcloud, aws, kubelogin) are supported. A 401 shows “Log in again and retry”.

## Not included yet

Contexts with `SkipTLSVerify`, StatefulSets / DaemonSets / Jobs and YAML editing, and restoring port-forwards on restart.

## Testing

See [CONTRIBUTING.md](../CONTRIBUTING.md#kubernetes-tests) (`k8s_read_probe` only reads; `k8s_write_flow` needs a throwaway kind cluster).
