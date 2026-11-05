# Isolated Linux screen (round 29, lane A)

Original pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. Contract: `docs/desktop-round29-interfaces.md` (E3). This lane authors the guest and the engine service. It does not register tools, issue tickets, or decide grants.

Root execution and native acceptance are pending. This lane did not build, pull, or run the image, and did not run tests, typecheck, lint, packaging, or the app. The capability is not accepted.

## Owned files

- `apps/engine/desktop-guest/**` — image and guest supervisor.
- `apps/engine/src/desktop/isolated-screen/**` — `IsolatedScreenService` and its tests.
- This note.

`apps/engine/src/desktop/isolated-screen/index.ts` exports `createIsolatedScreenService`, `shutdownIsolatedScreens`, `reconcileIsolatedScreens`, `disposeIsolatedScreen`, `IsolatedScreenRefusal`, `GUEST_IMAGE` (`rerun-desktop-guest:round29`), and `GUEST_PLATFORM` (`linux/arm64`). Importing the module does not spawn Docker. The production client is created on the first hook call.

## Original behavior kept

| Original | What the guest keeps |
| --- | --- |
| `apps/engine/src/desktop/session.ts` | Xvfb, openbox, x11vnc `-localhost -forever -shared -nopw -quiet`. `desktopAvailable()` needs Linux plus openbox, x11vnc, and xdotool. `computerAvailable()` also needs maim. `desktopEnv` sets `DISPLAY` and `GTK_THEME=Adwaita:dark`. |
| `apps/engine/src/desktop/control.ts` | JPEG fit `fill`, quality 75, max view 1280×720. Pointer scale is `max(1, width/1280, height/720)`. Type delay 12 ms. Capture cap on the host is 64 MiB; the guest frame caps PNG at 8 MiB. |
| `apps/engine/src/desktop/panels.ts` `openboxConfig()` | Empty `<keyboard>`, theme Rerun, Liberation Sans 10 bold. No dock keybind. |
| `apps/engine/src/tools/builtin/browser.ts` | Text 50_000, links 300, link text 80. Bot-wall wait 15 s, consent click, render settle. `detectBotWall` from `apps/engine/src/tools/bot-wall.ts` still runs on the host, and HTML is dropped. |
| `apps/engine/src/tools/builtin/computer.ts` | screenshot, left_click, right_click, double_click, mouse_move, left_click_drag, scroll (1–30, default 3), type (chunks of 40, max 8000), key, wait (0–10 s, default 1). The human-driving sentence is copied unchanged. |
| `apps/engine/src/desktop/takeover.ts` | A lease excludes the model. Releasing buttons is `mouseup` 1 and 3. |

`apps/engine/src/desktop/apps.ts` is not ported. There is no terminal, no file manager, and no host-to-guest copy.

## Mac adaptation

The engine on this Mac is not the Linux box those files assume. `holdDisplay` in `apps/engine/src/tools/virtual-display.ts` returns a null display when `process.platform !== 'linux'`, and the original browser then goes headless. That fallback is not used. Nothing here imports `session.ts`, `control.ts`, `virtual-display.ts`, or patchright.

Each coworker gets one guest container. The Mac engine talks to it only through the Docker CLI on the host (`spawn('docker', args, { shell: false })`). The guest does not see the Docker socket, the host home, the workspace, credentials, or a published port.

`apps/engine/Dockerfile` is the whole engine image (Node, Codex, thunar, xfce4-terminal, tint2, hsetroot, git, jq). The guest is a separate Debian bookworm image. Do not reuse that Dockerfile.

Two x11vnc processes replace the single published server in `session.ts`. Drive listens on 5900. Watch listens on 5901 with `-viewonly`. The host reaches them only by `docker exec -i -- <exact name> rerun-vnc watch|drive`. `withViewer` hands the callback a stream and destroys it when the callback returns or the signal aborts. A browser `viewOnly` flag is not the control. Drive requires the current takeover lease.

The guest display is fixed at `:1` and `1920x1080x24` because `-displayfd` is an engine-side detail and the container has one screen. `ensure` returns the bounded JPEG size (1280×720 for that framebuffer), not 1920×1080. Clicks are JPEG pixels mapped back onto the framebuffer the way `control.ts` does.

Chromium is visible and uses `--no-sandbox`. `cap-drop ALL` breaks Chromium's setuid sandbox; the container is the sandbox. Do not add `SYS_ADMIN` to restore it. CDP stays on `127.0.0.1:9222` inside the guest. The profile is `/var/lib/rerun/profile` on the volume. Stale Singleton locks and cache dirs are cleared when the guest starts so a kept volume can start again. Workspace files are not copied in.

`browser.ts` accepts `z.string().url()`, which allows non-HTTP schemes. `navigate` allows only `http:` and `https:`, rejects userinfo, and rejects `file:`, `javascript:`, `data:`, `about:`, and `chrome:`. Opening the browser is `ensure` plus `navigate`, not an arbitrary command.

JPEG encoding stays in the engine with the existing `sharp` dependency. The guest has no Node and no npm packages. There are no new engine dependencies.

## Identity and lifetime

Owner is `{ engineAgentId, launchNonce }`, resolved by authenticated server code. Names are `rerun-screen-` plus the first 32 hex chars of sha256(engineAgentId), and `rerun-screen-profile-` plus the same key. Labels are `com.rerun.desktop.role` (`isolated-screen` or `screen-profile`), `com.rerun.desktop.managed=1`, and `com.rerun.engineAgentId`. The container also carries `com.rerun.launchNonce` and `com.rerun.sessionGeneration`. The volume does not carry the nonce, so a restart keeps the profile.

A name that exists without those labels is `name-conflict`. It is not removed. `ensure` issues a new generation (`crypto.randomBytes(16)` hex) when the process has no live session, the container is not running, or the launch nonce changed. The same process and the same running container keep the generation.

| Call | Container | Volume |
| --- | --- | --- |
| Abort of an in-flight call | Kept | Kept |
| Failed start (not abort, not a Docker prerequisite) | Removed | Kept |
| `stop` | Removed when labels match this generation and nonce | Kept |
| `dispose` | Removed when labels match | Removed when labels match |
| `reconcile(launchNonce)` | Stops owned containers whose nonce differs | Kept |
| `shutdown` | Stops every owned container | Kept |

`reconcile` and `shutdown` skip a row whose name is not the hash of its agent label, or whose inspect labels no longer match. They return `{ stopped, skipped, prerequisite }` and do not throw when Docker is missing, stopped, or not `linux/arm64`. `status` reports `docker-missing`, `daemon-unreachable`, `docker-wrong-arch`, `image-missing`, `image-wrong-arch`, or `name-conflict`, and `absent | stopped | starting | running | human`. `available` is true only when the prerequisite is `ready`. The status object has no port, socket, or secret.

`docker run` is detached, `--restart=no`, `--init`, memory 2g with swap 2g, cpus 2, pids 512, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--read-only`, and tmpfs for `/tmp`, `/run`, `/home/rerun`, and `/dev/shm`. The only mount is `type=volume` at `/var/lib/rerun/profile`. There is no `--platform`, `--publish`, host network, host pid, privileged, or bind mount. The entrypoint starts as root only to check mounts, chown the profile, and `setpriv` down to uid 10001 with `--no-new-privs` and empty capability sets. A mount of `docker.sock`, `/Users/`, `/Volumes/`, `/private/var`, Application Support, `.ssh`, `.aws`, `.gnupg`, or Keychains makes the guest exit 78.

While the lease is held, `act` and `navigate` throw the original human-driving sentence. Taking over aborts the in-flight model call. `finishTakeover` releases buttons, closes drive streams, leaves watch streams up, and returns `{ url }` for an `http(s)` location, otherwise `{ url: null }`.

## Image root must build

Do not pass `--platform` on `docker run`. Build once, for arm64:

```bash
docker build --platform linux/arm64 -t rerun-desktop-guest:round29 -f apps/engine/desktop-guest/Dockerfile apps/engine/desktop-guest
```

Base image: `debian:bookworm-slim` (the build pulls it; this lane did not). Packages: `ca-certificates`, `chromium`, `fonts-liberation`, `openbox`, `python3`, `util-linux`, `x11vnc`, `xdotool`, `xvfb`, `maim`. User `rerun` uid 10001. No engine, git, jq, Codex, Claude, thunar, xfce4-terminal, tint2, hsetroot, Docker CLI, or npm install. No new packages in `apps/engine/package.json`. `sharp` and `zod` are already dependencies and this service does not add a schema package; root adds shared serialized schemas at integration.

`scripts/desktop/stage-engine.mjs` should copy the guest next to the staged engine, after the deploy copy. No `docker build` in that script:

```js
await cp(join(repoRoot, 'apps/engine/desktop-guest'), join(target, 'desktop-guest'), { recursive: true })
```

## Root wiring, not applied

Startup in `apps/engine/src/cli/commands/desktop-run.ts`, after `reconcileInterruptedRuns()` and before `initialized = true`. A missing image must not stop the process from listening:

```ts
import { reconcileIsolatedScreens, shutdownIsolatedScreens } from '../../desktop/isolated-screen/index.js'

await reconcileIsolatedScreens(runtime.launchNonce, lifetime.signal)
```

Shutdown must not use `lifetime.signal`. That signal is aborted at the start of `shutdown()`, which would cancel Docker cleanup immediately. A Docker failure is logged and must not increment `failed`. Incrementing `failed` clears `shutdownActive` and skips `process.exit`.

```ts
const isolatedScreens = new AbortController()
await shutdownIsolatedScreens(isolatedScreens.signal).catch(error => logger.error({ err: String(error) }, 'isolated screen shutdown failed'))
```

Place that after `failed` is computed and before `process.exit`, still inside `shutdown()`.

Coworker deletion goes through `withDesktopAgentDeletion` in `apps/engine/src/desktop/agent-lifecycle.ts` and `agentRoutes.delete` in `apps/engine/src/http/routes/agents.ts`. Do not treat a client-supplied container name as the owner. Resolve the engine agent id (`ctx.agent.id` on tool calls) and call dispose with the desktop process `runtime.launchNonce`. Do it after `stopDesktop(id)` and before the folder rename. If dispose throws, do not rename, do not call `persistDesktopAgentDeletion`, and do not call `deleteAgentIndex`.

```ts
const screenShutdown = new AbortController()
await disposeIsolatedScreen({ engineAgentId, launchNonce: runtime.launchNonce }, screenShutdown.signal)
```

B owns the tool strings and Done/Skip receipts. C owns authenticated tickets. Root binds the Codex screenshot handoff. This service returns JPEG bytes and a page object. It does not claim a visual tool succeeded.

## Limits still open

- `setpriv --inh-caps=-all`, the mount check, the guest RPC loop, and `docker exec` duplex bridging have not been executed.
- Docker Desktop's `{{.Label "key"}}` format and `docker inspect -- name` have not been checked against a live daemon.
- An amd64 daemon reports `docker-wrong-arch` and does not start. An arm64 daemon with an amd64 image reports `image-wrong-arch`.
- Grant policy, tickets, tool registration, and result cards belong to B, C, and root.
- Tests in `apps/engine/src/desktop/isolated-screen/*.test.ts` are authored only. Root runs them.
- Root execution and native acceptance are pending. This lane does not mark the capability accepted.
