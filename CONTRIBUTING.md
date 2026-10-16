# Contributing to Dockspan

Thanks for helping out! Dockspan is a desktop Docker manager (Tauri 2 + Rust `bollard`/`kube-rs` + React/TypeScript/Vite/Zustand). This file covers everything you need to build, test and change it. Back to the [README](README.md).

## Requirements

Node 20+, pnpm, Rust (`rustup`), Docker, and the Tauri dependencies for your operating system (macOS: Xcode Command Line Tools; see <https://tauri.app/start/prerequisites/>).

## Commands

```bash
pnpm install
pnpm tauri dev        # run the app (Rust backend + real Docker)
pnpm tauri build      # package the app
pnpm test             # frontend tests (vitest)
cd src-tauri && cargo test                                          # pure tests (no Docker needed)
cd src-tauri && cargo test -- --ignored --nocapture --test-threads=1  # integration tests against real Docker
```

More detail for day-to-day work (single test, typecheck, bundle only the `.app`) is in [CLAUDE.md](CLAUDE.md#commands).

## Tests

### Integration tests against real Docker

The integration tests create/delete resources prefixed with `dockspan-smoke`, pull the `alpine:3.20` image if it is missing, and **never run prune**. If the engine is stopped, the tests start it with the same command the “Start” button uses.

### Multi-engine and SSH terminal tests

`multi_engine_flow` adds, tests, switches to, uses (CLI, exec) and removes an SSH, TCP+TLS and/or WSL2 connection, with a temporary `DOCKER_CONFIG`. `ssh_terminal_flow` (same `DOCKSPAN_SSH`/`DOCKSPAN_SSH_KEY`) drives a real PTY session: host-key question, a command, a resize seen by the remote shell, two sessions at once, `exit`, and a refused port.

Each part runs only when its variables are set:

- `DOCKSPAN_SSH=user@host:port` (+ `DOCKSPAN_SSH_KEY`; the host must already be in `known_hosts`)
- `DOCKSPAN_TLS=host:port` + `DOCKSPAN_TLS_CERTS=<dir>`
- `DOCKSPAN_WSL=<distro>`

A throwaway setup: an `alpine` container running `sshd` + `docker-cli` with the Docker socket mounted, and `docker run --privileged -e DOCKER_TLS_CERTDIR=/certs -p 127.0.0.1:23760:2376 docker:27-dind` (copy `/certs/client` out with `docker cp`). `wsl_list_probe` only reads.

When cleaning up such test containers, remove them (and their volumes with `docker rm -fv`) by name — never `docker volume prune` / `system prune` on your own engine.

### Kubernetes tests

`k8s_read_probe` only reads (current context, or `$DOCKSPAN_K8S_CONTEXT`). `k8s_write_flow` scales/restarts/deletes in namespace `dockspan-smoke` and refuses any context whose name does not contain `dockspan-smoke`, so run it against a throwaway cluster (never against your real clusters; `~/.kube/config` may point at production):

```bash
kind create cluster --name dockspan-smoke --kubeconfig /tmp/ds.kubeconfig
cd src-tauri && DOCKSPAN_K8S_KUBECONFIG=/tmp/ds.kubeconfig DOCKSPAN_K8S_CONTEXT=kind-dockspan-smoke \
  cargo test k8s_write_flow -- --ignored --nocapture
kind delete cluster --name dockspan-smoke --kubeconfig /tmp/ds.kubeconfig
```

## Working on the UI without Docker

Run `pnpm dev`, then open `http://localhost:1420/?mock` in a browser: `src/dev/mock.ts` provides a fake backend with sample data from the prototype (dev mode only), including two fake Kubernetes clusters. Playwright scripts use the locally installed Chrome:

```bash
node scripts/shots.mjs <output-dir>   # take screenshots of the screens
node scripts/flows.mjs                # check the interactive flows
node scripts/i18n-check.mjs           # find untranslated Vietnamese text in the English UI
node scripts/k8s-flows.mjs <dir>      # Kubernetes page flows (falls back to Playwright's Chromium when Chrome is missing)
node scripts/conn-flows.mjs <dir>     # Add/remove SSH, TCP+TLS, WSL2 connections, install Docker in a distro
node scripts/ssh-flows.mjs <dir>      # SSH page: hosts, several terminals, add/remove host, palette
```

The README screenshots in `docs/screenshots/` were taken with `shots.mjs` against the mock backend.

## Project structure

```
src/                 React frontend
  api.ts             Data types + Tauri command calls + events
  store.ts           Zustand: Docker data, actions (3 states: running / success / error), toasts, modals
  k8sStore.ts        Zustand: Kubernetes clusters, lists of the shown cluster, port-forwards
  lib/               Pure, tested helpers: sizes, log levels, prune list computation, project status, .env masking
  views/ modals/     The 9 screens and their modals/drawers
  i18n/              t(), plus en.ts / vi.ts translation tables
src-tauri/src/       Rust backend
  ctx.rs events.rs   Docker contexts (read/write ~/.docker/contexts), connection, engine monitoring (/events, auto-reconnect 1/2/5/10 s), engine start/stop
  bridge.rs wsl.rs   SSH/WSL2 bridge (docker system dial-stdio), WSL2 distro list and Docker install
  sshcfg.rs sshterm.rs  ~/.ssh/config hosts (ssh -G), interactive SSH terminals in a PTY
  containers.rs      Listing, lifecycle, logs/stats (streams), exec (terminal)
  k8s.rs             Kubernetes (kube-rs): clusters from kubeconfig, lists/watch, scale/restart/delete, logs, exec, port-forward
  images.rs netvol.rs prune.rs projects.rs cli.rs rawapi.rs store.rs
```

## Architecture principles

- The webview never touches the socket or kubeconfig; every connection, stream and secret lives in the Rust backend.
- The Engine API is called over the socket; the `docker` CLI is only used for `compose`, `build` and the volume commands (a temporary `alpine` container).
- Local data (projects, schedule, settings, added/hidden clusters) is stored in `store.json` inside the app's data directory.

The full architecture notes (state, streams, events, command naming rules) are in [CLAUDE.md](CLAUDE.md#architecture). Feature behaviour is described in [docs/connections.md](docs/connections.md) and [docs/kubernetes.md](docs/kubernetes.md).

## Internationalization

The UI is available in English (default) and Vietnamese. Every new user-visible string must be wrapped in `t("…")` and added to both `en.ts` and `vi.ts`; see [CLAUDE.md](CLAUDE.md#i18n) for the rules (backend error patterns included). Run `node scripts/i18n-check.mjs` before opening a PR.

## Pull requests

- Branch from `main` and keep a PR focused on one change.
- Run `pnpm build` (typecheck + build), `pnpm test` and `cd src-tauri && cargo test` before pushing.
- Never run integration tests against engines or clusters you care about (see above); the tests must never run prune.
- Do not rename existing Tauri commands; the frontend depends on them.
- Describe what changed and why, and attach a screenshot for UI changes.
