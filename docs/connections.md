# Connections & SSH

Dockspan talks to Docker engines through **docker contexts**, the same ones the `docker` CLI uses. Back to the [README](../README.md).

## Docker connections

The list is `docker context ls` (`~/.docker/contexts`, or `$DOCKER_CONFIG`) plus WSL2 engines kept by the app.

- **Add connection** writes a real docker context (same files as `docker context create`), so the CLI sees it too.
- **Remove** deletes it like `docker context rm` (the engine is not touched). It is refused for the default context, the active one and the CLI's current context.
- Supported engines: a local socket / named pipe, SSH, TCP (+TLS) and WSL2.
- **TCP+TLS** uses the context's `ca.pem` / `cert.pem` / `key.pem`.
- Start/stop works for local and WSL2 engines; remote ones are started on their own machine.

## SSH and WSL2 bridge

SSH and WSL2 engines go through a local bridge on `127.0.0.1:<random port>` that runs `docker system dial-stdio`:

- **SSH:** through `ssh` (BatchMode, your ssh-agent / `known_hosts`, optional key file).
- **WSL2:** through `wsl -d <distro> -u root`.

For SSH, the Add connection modal lists the hosts of `~/.ssh/config` (following `Include`, settings resolved with `ssh -G`). Picking one keeps the alias as the host, so every option of that block (ProxyJump, IdentityFile…) applies.

## WSL2 distros

The Connections page also lists WSL2 distros (`wsl.exe -l -v`), with the Docker version inside each running one, and an **Install Docker Engine** button (it runs the get.docker.com script).

## SSH page

The SSH page is independent of Docker:

- It lists the hosts of `~/.ssh/config`, SSH Docker contexts and hosts added in the app, and opens any number of terminal tabs per host.
- The system `ssh` runs in a real pseudo-terminal (`portable-pty`: openpty on macOS/Linux, ConPTY on Windows), so password prompts, host-key questions, vim/htop and resizing work.
- Terminals survive changing page and can be moved to a separate window; an ended session keeps its output and offers **Reconnect**.

## Testing these features

See [CONTRIBUTING.md](../CONTRIBUTING.md#multi-engine-and-ssh-terminal-tests) for the `multi_engine_flow` and `ssh_terminal_flow` integration tests.
