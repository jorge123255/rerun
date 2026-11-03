# Desktop preview runtime

The preview uses an Electron main process, a production Next child, and a separate engine child. It supports one local workspace and chat through API providers or a ChatGPT subscription. Shell, MCP subprocesses, browser/computer tools, Claude subscription execution, schedules, reset/deletion and public publishing are unavailable in this slice.

## Packaged resources

`runtime-manifest.json`, relative to the app Resources directory:

```json
{
  "protocolVersion": 1,
  "buildId": "source-commit-and-desktop-build-id",
  "nodePath": "runtime/node/bin/node",
  "uiRoot": "runtime/ui",
  "engineEntry": "runtime/engine/dist/cli/bin.js"
}
```

Paths are relative, confined to Resources, and checked after symlink resolution. `uiRoot/server.js` is the production standalone Next entry. Include its traced dependencies, public files and static chunks. Compile the engine with its compatible dependencies and assets. Compile/copy all files from `apps/desktop/src/main` to `apps/desktop/dist/main`; entry is `index.js` (which imports `index.mjs`). Keep `preload.cjs` and the startup HTML/CSS/JS alongside it.

The bundled Node runtime must match native libSQL/sharp modules. No runtime executable is resolved from the user's PATH.

## Persistent state

The app uses `~/Library/Application Support/Rerun Desktop Preview`. `identity.encrypted` holds the install ID, engine API key and credential-encryption key encrypted with Electron safeStorage; it fails closed if Mac secure storage is unavailable. Workspace 1 has a dedicated `workspaces/1/engine` directory and owner marker. Existing `~/.rerun` data is not adopted.

At each launch, main atomically writes mode-0600 `runtime.json`:

```json
{
  "protocolVersion": 1,
  "launchNonce": "random-uuid",
  "buildId": "same-as-resource-manifest",
  "workspaceId": 1,
  "dataRoot": "absolute-profile-root",
  "app": { "origin": "http://127.0.0.1:actual-ui-port", "sessionToken": "64-hex-random" },
  "engine": { "origin": "http://127.0.0.1:actual-engine-port", "apiKey": "64-hex-random" }
}
```

This file is server-only. The renderer must never receive it or the engine credential. Main sets an HttpOnly, SameSite=Strict `rerun-desktop-session` cookie before navigating to `/desktop`. Local UI routes authenticate this cookie and check Host/Origin; callbacks authenticate the engine separately. Loopback binding does not replace authentication.

## Startup

Main passes `RERUN_DESKTOP_APP=1`, `RERUN_DESKTOP_DATA_DIR`, and `RERUN_DESKTOP_RUNTIME_FILE` to both children. The UI also gets `RERUN_DESKTOP_UI_ROOT`, `HOSTNAME=127.0.0.1` and `PORT`. UI wrapper imports `uiRoot/server.js` and terminates on parent IPC disconnect.

Main waits for authenticated `GET /api/desktop/health` returning `{status:"ready",protocolVersion:1,launchNonce,buildId,workspaceId:1}` after local DB initialization. This route must not require an already-running engine. Main then starts `node engineEntry desktop-run` with loopback host/port, engine root/key, actual local hub origin, `RERUN_DESKTOP=off`, and the install encryption key in `RERUN_DESKTOP_SECRET_KEY`.

The engine validates the manifest, prepares its data directory, reconciles interrupted state, and listens. It sends IPC `{type:"ready",status:"ready",protocolVersion:1,launchNonce,buildId,workspaceId:1}`. Main also verifies bearer-authenticated engine `/health` before loading the UI. Both nonce and build ID must match. Failed starts use bounded retry and never adopt a pre-existing listener.

## Stop and limits

Main sends `{type:"stop"}` to the engine before stopping the UI, keeping callbacks alive while runs settle. Engine rejects new work, cancels and awaits active run cancellation, closes MCP and HTTP, acknowledges stop, then exits. Main has a bounded grace followed by forced termination of the owned PID. No arbitrary subprocess tools are enabled, and children react to parent IPC loss. Window close hides the app on macOS; explicit Quit stops services. No login item or hidden daemon is installed.

The preview is not a general-distribution release. Native computer control, Claude subscription execution, general connectors, reset/deletion, migration from an existing install, telemetry consent, public publishing, signing/notarization and update hosting require their own validated integrations.


## ChatGPT device-code sign-in

Settings → AI providers → Connect ChatGPT (Codex) starts device authorization on the bundled Codex app-server. It returns a verification link and short code. Once OpenAI approves, the engine reads the ChatGPT account and runner model catalog, registers the connection, and selects its default model. The CLI owns refresh and stores credentials in the macOS Keychain scoped to a separate Rerun Codex home. Rerun stores connection metadata and a sign-in flag, not the OAuth tokens. Cancel or sign out in the same panel.

Opening the connected Codex panel or choosing **Refresh models** reloads every page of models the runner offers for chat. Rerun keeps the selected model while it is available and retains the saved catalog if a refresh fails. The reasoning-effort picker uses the levels reported for that model. Its selection is stored with the workspace default and applied to the next coworker turn, including in an existing conversation. **Model default** uses the effort recommended by Codex.

Both streaming chats and one-shot model calls use the pinned arm64 runner via the verified resource manifest. Its launcher clears the environment, applies a macOS sandbox, and uses a private working directory. Rerun does not borrow a personal Codex login or launch the user's installed CLI.
