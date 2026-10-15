# Dockspan

A desktop Docker manager that puts the **project folder at the center**: Overview, Projects (Compose), Containers
(logs, terminal, stats, inspect), Images (pull/build), Networks, Volumes (browse/backup/restore),
Cleanup (preview + automatic schedule), Kubernetes (clusters from kubeconfig) and Connections. Built with Tauri 2 (Rust, `bollard`, `kube-rs`) + React + TypeScript.

## Current scope (phases 1–3 and 5 of the roadmap)

Included: local Docker over a socket (reads `docker context`, switches between socket contexts), Dashboard, Projects
(add/detect compose, `compose up/stop/restart/down`, browse and edit files, `.env` hides sensitive values),
Containers (create/start/stop/restart/delete, realtime logs filtered by level, xterm.js terminals, stats, inspect),
Images (pull with progress, build, layer history, delete), Networks, Volumes, Cleanup with preview and automatic schedule,
the Ctrl/⌘K command palette, starting/stopping the engine per operating system, and a banner when the connection is lost.

Kubernetes (independent of the Docker context): clusters are the contexts of `$KUBECONFIG` / `~/.kube/config` plus contexts
added from other kubeconfig files (the kubeconfig is never modified; “Remove” only hides a cluster in the app). Per cluster:
version/nodes check, namespace filter, Deployments (scale, rollout restart), Pods (status like `kubectl`, logs with
`--previous`/follow and an explanation for common failures, exec terminal, delete), Services and port-forward to
`127.0.0.1` (privileged ports get +8000; each connection picks a Ready pod again, so it survives pod replacement).
Lists refresh through watches, not polling. Users limited to one namespace (403 on cluster-wide lists) fall back to
the context's namespace. Exec auth plugins (gcloud, aws, kubelogin) are supported; a 401 shows “Log in again and retry”.

Not included yet (as planned in the roadmap): SSH / TCP+TLS / WSL2 contexts, StatefulSets/DaemonSets/Jobs and YAML editing in Kubernetes, restoring port-forwards on restart, system tray and notifications, light theme.

## Language

The UI is available in English (default) and Vietnamese. Switch it with the gear button **Settings** in the header,
next to the engine status; the change applies immediately. See [CLAUDE.md](CLAUDE.md#i18n) for how to add translated strings.

## Running

Requirements: Node 20+, pnpm, Rust (`rustup`), Docker, and the Tauri dependencies for your operating system
(macOS: Xcode Command Line Tools; see https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev        # run the app (Rust backend + real Docker)
pnpm tauri build      # package the app
pnpm test             # frontend tests (vitest)
cd src-tauri && cargo test                                          # pure tests (no Docker needed)
cd src-tauri && cargo test -- --ignored --nocapture --test-threads=1  # integration tests against real Docker
```

The integration tests create/delete resources prefixed with `dockspan-smoke`, pull the `alpine:3.20` image if it is missing,
and **never run prune**. If the engine is stopped, the tests start it with the same command the “Start” button uses.

Kubernetes integration tests: `k8s_read_probe` only reads (current context, or `$DOCKSPAN_K8S_CONTEXT`). `k8s_write_flow`
scales/restarts/deletes in namespace `dockspan-smoke` and refuses any context whose name does not contain `dockspan-smoke`,
so run it against a throwaway cluster:

```bash
kind create cluster --name dockspan-smoke --kubeconfig /tmp/ds.kubeconfig
cd src-tauri && DOCKSPAN_K8S_KUBECONFIG=/tmp/ds.kubeconfig DOCKSPAN_K8S_CONTEXT=kind-dockspan-smoke \
  cargo test k8s_write_flow -- --ignored --nocapture
kind delete cluster --name dockspan-smoke --kubeconfig /tmp/ds.kubeconfig
```

## Working on the UI without Docker

Run `pnpm dev`, then open `http://localhost:1420/?mock` in a browser: `src/dev/mock.ts` provides a fake backend with
sample data from the prototype (dev mode only), including two fake Kubernetes clusters. Playwright scripts use the locally installed Chrome:

```bash
node scripts/shots.mjs <output-dir>   # take screenshots of the screens
node scripts/flows.mjs                # check the interactive flows
node scripts/i18n-check.mjs           # find untranslated Vietnamese text in the English UI
node scripts/k8s-flows.mjs <dir>      # Kubernetes page flows (falls back to Playwright's Chromium when Chrome is missing)
```

## Structure

```
src/                 React frontend
  api.ts             Data types + Tauri command calls + events
  store.ts           Zustand: Docker data, actions (3 states: running / success / error), toasts, modals
  k8sStore.ts        Zustand: Kubernetes clusters, lists of the shown cluster, port-forwards
  lib/               Pure, tested helpers: sizes, log levels, prune list computation, project status, .env masking
  views/ modals/     The 9 screens and their modals/drawers
  i18n/              t(), plus en.ts / vi.ts translation tables
src-tauri/src/       Rust backend
  ctx.rs events.rs   Docker contexts, connection, engine monitoring (/events, auto-reconnect 1/2/5/10 s), engine start/stop
  containers.rs      Listing, lifecycle, logs/stats (streams), exec (terminal)
  k8s.rs             Kubernetes (kube-rs): clusters from kubeconfig, lists/watch, scale/restart/delete, logs, exec, port-forward
  images.rs netvol.rs prune.rs projects.rs cli.rs rawapi.rs store.rs
```

Principles: the webview never touches the socket or kubeconfig; every connection, stream and secret lives in the Rust backend. The Engine API
is called over the socket; the `docker` CLI is only used for `compose`, `build` and the volume commands (a temporary `alpine` container).
Local data (projects, schedule, settings, added/hidden clusters) is stored in `store.json` inside the app's data directory.
