# Desktop preview runtime

The preview uses an Electron main process, a production Next child, and a separate engine child. It supports one local workspace and chat through API providers or a ChatGPT subscription. Shell, MCP subprocesses, browser/computer tools, Claude subscription execution, schedules, workspace reset/deletion and public publishing are unavailable in this slice.

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

The **Memories** button in coworker chat lists that coworker’s saved Rerun notes. **Add memory** saves the content, kind and tags locally. Each note has its own delete confirmation. Listing, adding and deleting these notes works without a model call. The desktop routes resolve the local coworker before reading or changing its memory store.

**Recall memories** searches that coworker’s notes locally. Press Enter or choose **Search** to see up to five matches ranked by keyword relevance and memory strength. **Clear search** returns to the full list. Looking up a note in this panel does not increase its access count or strengthen it.

When a coworker has memory enabled, a chat message uses the same local keyword search. Up to five relevant, active memories can accompany the message to the selected chat provider, including notes saved only as Markdown. A note already present in the conversation context is skipped. Chat can refresh the last-use time of an indexed match without increasing its access count. Rerun’s separate automatic learning setting still controls whether the coworker reviews a completed exchange for facts to save or correct.

In **Edit coworker**, **Use saved memories in chat** controls whether a new turn retrieves notes. **Learn from replies** controls whether a completed exchange can add, correct or remove a learned fact. You can use saved notes with learning off. Switching recall off pauses learning and preserves the learning preference for when recall is enabled again. Rerun also pauses learning for coworkers whose existing self-improvement setting is off. The **Memories** panel still lets you manage saved notes manually.

**Attach from Files** in coworker chat selects one existing UTF-8 `.txt` or `.md` file of up to 32 KiB from that coworker’s workspace. The filename appears next to the draft, where you can remove it. When you send your question, the Mac app reads the file and sends that version to the selected provider as part of the message. The saved conversation shows the filename and uses the original text even if the workspace file later changes or is removed. A file that can no longer be read leaves the draft available to edit and retry.

In **Files**, **Import file** copies a single local `.txt` or `.md` document of up to 1 MiB into the selected coworker’s current folder. The final filename appears only once the full document is written. An existing name is preserved, including when two imports race. **Find chat** on the Team board searches local conversation titles across coworkers. Each result shows the coworker and opens that exact saved chat.

Assistant replies render Markdown in live and reopened chats, including headings, lists, tables and fenced code blocks. **Copy reply** copies the answer’s original Markdown. The user’s message stays literal text, including its attachment label. Markdown images display their alt text, and eligible HTTPS links open in the system browser when clicked.

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

The preview is not a general-distribution release. Native computer control, Claude subscription execution, general connectors, workspace reset/deletion, migration from an existing install, telemetry consent, public publishing, signing/notarization and update hosting require their own validated integrations.


## ChatGPT device-code sign-in

Settings → AI providers → Connect ChatGPT (Codex) starts device authorization on the bundled Codex app-server. It returns a verification link and short code. Once OpenAI approves, the engine reads the ChatGPT account and runner model catalog, registers the connection, and selects its default model. The CLI owns refresh and stores credentials in the macOS Keychain scoped to a separate Rerun Codex home. Rerun stores connection metadata and a sign-in flag, not the OAuth tokens. Cancel or sign out in the same panel.

Opening the connected Codex panel or choosing **Refresh models** reloads every page of models the runner offers for chat. Rerun keeps the selected model while it is available and retains the saved catalog if a refresh fails. The reasoning-effort picker uses the levels reported for that model. Its selection is stored with the workspace default and applied to the next coworker turn, including in an existing conversation. **Model default** uses the effort recommended by Codex.

Both streaming chats and one-shot model calls use the pinned arm64 runner via the verified resource manifest. Its launcher clears the environment, applies a macOS sandbox, and uses a private working directory. Rerun does not borrow a personal Codex login or launch the user's installed CLI.
