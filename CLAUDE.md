# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Dockspan is a desktop Docker manager (Tauri 2 + Rust `bollard` + React/TS/Vite/Zustand). README and code comments are in English; the UI supports English (default) and Vietnamese, see the i18n section below. The original spec is `Dockyard – Đặc tả chức năng (từ prototype UI UX).md` (Vietnamese) and the UI prototype is `Docker Manager UI … App.html` (a bundle; its CSS was copied into `src/styles.css`). Implemented scope: phases 1–5 of the roadmap (spec section 11.5). Tray and the light theme are **not built**.

## Commands

Run `source ~/.cargo/env` first if your shell does not have cargo.

```bash
pnpm install
pnpm tauri dev                 # run the real app (Rust + real Docker); Vite on port 1420 (strictPort)
pnpm tauri build --bundles app # package the .app
pnpm build                     # tsc --noEmit + vite build (frontend)
npx tsc --noEmit               # typecheck only
pnpm test                      # vitest, everything
npx vitest run src/lib/prune.test.ts          # one file
npx vitest run -t "test name"                 # one test
cd src-tauri && cargo check
cd src-tauri && cargo test schedule_next_due  # pure test, no Docker needed
cd src-tauri && cargo test <name> -- --ignored --nocapture --test-threads=1   # integration tests against real Docker
cd src-tauri && cargo test k8s_read_probe -- --ignored --nocapture             # READ-ONLY probe of the current kube context
```

The integration tests (`src-tauri/src/smoke.rs`: `engine_and_docker_flow`, `compose_project_flow`, `exec_resize_probe`, `stop_probe`) are all `#[ignore]`, use Tauri's mock app, only touch resources prefixed `dockspan-smoke`, pull `alpine:3.20`, **never run prune**, and call `engine_start` themselves if the engine is stopped (which opens the real Docker Desktop).

Multi-engine test: `multi_engine_flow` needs `DOCKSPAN_SSH` (+`DOCKSPAN_SSH_KEY`), `DOCKSPAN_TLS`+`DOCKSPAN_TLS_CERTS` and/or `DOCKSPAN_WSL` (see README for a throwaway sshd/dind setup) and uses a temporary `DOCKER_CONFIG`. When cleaning up such test containers remove them (and their volumes with `docker rm -fv`) by name — never `docker volume prune`/`system prune` on the user's engine.

Kubernetes tests: `k8s_read_probe` only reads. `k8s_write_flow` writes, so it needs `DOCKSPAN_K8S_KUBECONFIG` + `DOCKSPAN_K8S_CONTEXT` and refuses any context not named `*dockspan-smoke*`; run it against a throwaway `kind create cluster --name dockspan-smoke --kubeconfig <tmp file>` (never write to the user's real clusters — `~/.kube/config` may point at production).

Working on the UI without Docker: run `pnpm dev`, then open `http://localhost:1420/?mock` (fake backend in `src/dev/mock.ts`, loaded only when `import.meta.env.DEV`). The Playwright scripts use the locally installed macOS Chrome: `node scripts/shots.mjs <dir>` (screenshots) and `node scripts/flows.mjs` (interactive flows; needs Vite running); `node scripts/conn-flows.mjs <dir>` covers the Add connection modal and the WSL2 section. Use `.tr:visible` when selecting table rows because the Containers page stays mounted. `node scripts/k8s-flows.mjs <dir>` checks the Kubernetes page against the mock (it falls back to Playwright's Chromium on machines without the macOS Chrome: `npx playwright-core install chromium-headless-shell`).

## Architecture

**The webview never touches the socket or kubeconfig**; every connection, stream and secret lives in the Rust backend. The frontend only calls `invoke` (wrapped in `src/api.ts`; command names follow section 11.2 of the spec, so do not rename existing commands) and listens to events.

Backend (`src-tauri/src`):
- `state.rs` `AppState`: the active bollard handle, the selected context, a map of background tasks (`spawn_task`/`abort_task`/`abort_prefix`, keyed like `logs:<id>`), exec sessions, and the `Store`.
- `ctx.rs`: contexts = default (DOCKER_HOST / local socket) + `~/.docker/contexts` (`$DOCKER_CONFIG` respected; meta/tls dir names are the SHA-256 of the context name, exactly like the docker CLI) + WSL2 engines from `store.wsl_contexts`. `CtxInfo` carries TLS dir, SSH key (`store.ssh_keys`, docker contexts have no field for it), WSL distro and `supported`/`reason`. `ActiveCtx.spec` holds the full `CtxInfo`. Always connect through `ctx::open` / `connect_active` / `open_spec` (negotiate_version is required: Docker 27 only speaks up to API 1.47). `ctx_add` writes the docker context files itself (no CLI needed), `ctx_remove` deletes them (refused for default, active and the CLI's current context). `ctx_switch` cancels every old stream, swaps the bridge and restarts the monitor.
- `bridge.rs`: SSH and WSL2 engines go through a `127.0.0.1:<random>` listener; each connection spawns `ssh -o BatchMode=yes … docker system dial-stdio` (ControlMaster on unix) or `wsl -d <distro> -u root -- … dial-stdio`. The active one lives in `AppState.bridge`; its last stderr line becomes the connection error (`ctx::explain_bridge_error` adds hints). The docker CLI gets `DOCKER_HOST`/TLS vars from `ctx::cli_env`; `/system/df` raw GET uses `ctx::raw_endpoint` (empty for TLS → bollard fallback).
- `sshcfg.rs`: `ssh_hosts` lists concrete `Host` aliases of `~/.ssh/config` (Include followed, wildcard patterns skipped) and fills HostName/User/Port/IdentityFile/ProxyJump from `ssh -G <alias>`; only identity files that exist are kept. The modal stores the alias as the SSH host (user/port/key empty) so ssh applies the whole config block.
- `sshterm.rs`: SSH page terminals. `ssh` runs inside a portable-pty PTY (`SshState`, separate from Docker/K8s state); blocking PTY reads use plain threads. Output goes to `exec://<sid>` like docker exec; a waiter thread emits `close` after the process exits and drops the master (ConPTY never reports EOF otherwise). `ssh_args` refuses hosts/users starting with `-` (option injection) and passes the host after `--`. Hosts added on the page are `store.ssh_saved`; `~/.ssh/config` is never written.
- `wsl.rs`: `wsl.exe` on Windows, or through interop inside WSL (`/mnt/c/Windows/system32/wsl.exe`); its output is UTF-16LE (`decode`). Only running WSL 2 distros are probed for Docker (probing boots a distro).
- `events.rs`: the monitor keeps the `/events` stream, emits `engine://status` and `docker://events`, and reconnects after 1/2/5/10 s; `engine_start/stop` depend on the operating system (macOS Docker Desktop/colima/orb, Linux pkexec systemctl, Windows). `engine_stop` must wait until nothing accepts connections on the socket before returning, otherwise starting again right away leaves Docker Desktop stuck.
- `containers.rs`, `images.rs`, `netvol.rs`, `prune.rs`, `projects.rs`: the command groups. Streams come back through the events `logs://<id>`, `stats://<id>`, `exec://<sid>`, `pull://progress`, `build://log` and `compose://progress`. For exec, the frontend **generates the `sid` itself and listens first** before calling `exec_open`, so the first output line is not lost.
- `cli.rs`: the `docker` CLI is only used for `compose`, `build` and the volume commands (a temporary `alpine` container); it always sets `DOCKER_HOST` to the selected endpoint and an extended PATH (`util::cli_path`) because GUI apps do not inherit the shell PATH. tokio `Command::output()` forces stdout into a pipe, so use `spawn()` when output must go to a file.
- `rawapi.rs`: a raw GET over the socket for `/system/df` (bollard 0.21 only models the API ≥ 1.52 format, so older Docker returns empty data). `Shared` build cache records are excluded from the totals to match `docker system df`.
- Commands that take an `AppHandle` are all generic over `<R: Runtime>` so they can be tested with the mock app; `generate_handler!` does not accept a turbofish.
- `k8s.rs`: Kubernetes through kube-rs, **independent of the Docker context**. Its own managed `K8sState` (cached `Client` per cluster, watch/log tasks, exec sessions, port-forwards) is separate from `AppState::tasks`, so `ctx_switch` (which aborts every Docker task) never touches it. Clusters = contexts of the default kubeconfig (`$KUBECONFIG` / `~/.kube/config`, id = context name) minus `store.kube.hidden`, plus `store.kube.extra` (other files, id = `<context>@<path>`); the kubeconfig file is never written. Lists fall back to the context namespace on a 403 for cluster-wide lists. Errors: 401 / failed exec plugin → `Unauthorized: …` (the frontend shows the login box via `isAuthError`). Events: `k8s://watch` `{cluster, kind}` (frontend debounces and calls `k8s_list`), `k8s://logs/<key>` and `exec://<sid>` (same payload as docker exec; keys generated by the frontend, listen first). `lib.rs` extends the process `PATH` at startup so exec auth plugins are found from a GUI launch.
- `store.rs`: local configuration (`store.json` in the app data dir: projects, cleanup schedule, settings, containers running before the engine was stopped, added/hidden clusters). Docker/K8s data is always read directly from the API.
- A project is a folder with compose/Dockerfile; `Project.composeProject` (the real name used for `-p` and the `com.docker.compose.project` label) is separate from `name` (the display name, renamable). Containers are linked to a project through that label.

Frontend (`src`):
- `k8sStore.ts` (`useK8s`): Kubernetes state (clusters, per-cluster status `checking/ok/auth/offline`, lists of the shown cluster + namespace, port-forwards). A `gen` counter drops late responses after a cluster/namespace change; watches run only while the Kubernetes page is mounted. The Kubernetes page is never blurred or covered by the Docker engine banner.
- `store.ts` (Zustand) is the center: Docker data, `busy` per container/project (3 states running/success/error through toasts), a single modal (`ModalState`; each modal keeps its form state locally), and `terms` (containers that have a terminal open). `init()` is idempotent (React StrictMode). Lists refresh from docker events with a debounce, not polling; only the CPU/RAM columns of the Containers table poll every 5 s while that page is visible.
- `lib/` holds pure, tested logic: Kubernetes helpers (`k8s.ts`: pod status colors, pod failure explanations, auth errors), prune list computation (`prune.ts`: a network/volume is "in use" if ANY container, even a stopped one, references it), log levels (`logs.ts`), project status, `.env` masking, formatting.
- The Containers page stays mounted after the first visit (App.tsx) and each container's `TerminalTab` is kept (hidden) so xterm.js sessions survive selecting another container or changing page; they are removed only when the container stops/restarts/is deleted or the app exits.
- `sshStore.ts` (`useSsh`) + `views/Ssh.tsx`: SSH hosts = `lib/ssh.ts` `sshEntries(config, contexts, saved)` (config aliases first, contexts pointing at the same host deduplicated). Like Containers, the SSH page stays mounted after the first visit so terminal tabs survive navigation; `?ssh=<target JSON>` opens `SshTerminalWindow` (window label `term-ssh-*`).
- `TerminalView` takes an optional `ExecBackend`; the pod exec drawer (`modals/Kube.tsx`) reuses it with the `k8s_exec*` commands. Esc inside a terminal goes to the shell, so drawers with a terminal close with their button.
- Separate terminal window: `main.tsx` accepts `?term=<id>` (capability `term-*` in `src-tauri/capabilities/default.json`).
- Styling uses the prototype's CSS classes (`.btn`, `.card`, `.tr`, `.modal`…) together with inline styles, no Tailwind.

## i18n

- `src/i18n/index.ts`: `t(key, vars?)`; **the key is the original English sentence** (insert values with `{name}`). Each language has its own table: `en.ts` (key → itself) and `vi.ts` (key → Vietnamese). A missing translation falls back to the key, never an error. Every new user-visible string must be wrapped in `t("…")` and added to **both** files (a test checks that the two tables have the same keys, that keys contain no Vietnamese, and that placeholders match).
- Do not call `t()` at module level (it would freeze the language when the file loads); use functions instead, e.g. `stateLabel()`, `engineLabel()`, `levels()`.
- The language is changed with the gear button **Settings** (in the header, next to the engine badge; it opens the `preferences` page) through `useApp().setLang`; `App` subscribes to `lang`, so the whole tree re-renders (no remount, terminals stay alive). It is stored in `localStorage` (`dockspan.lang`) and defaults to `en`.
- Errors returned by the Rust backend are **fixed English text**; `api.ts` translates them to Vietnamese with `tBackend` using the patterns in `VI_BACKEND` (`vi.ts`; `{x}` matches the variable part). When adding a new Rust message, add the matching pattern.
- Unit tests and the Playwright scripts run in English; only the language-switch step (and the i18n tests) use Vietnamese text. `node scripts/i18n-check.mjs` scans the English UI for untranslated Vietnamese text.
