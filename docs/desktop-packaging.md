# Desktop packaging (internal preview)

Packages the desktop shell as an arm64 macOS `.app` using the stable local
preview signing identity. The preview is for internal development. Public
distribution still requires a release signing and notarization workflow.

## Commands

```bash
pnpm install                                   # workspace deps incl. electron + electron-builder
pnpm desktop:install                           # update ~/Applications/Rerun Desktop Preview.app
pnpm desktop:install --commit FULL_SHA          # install only this checked-out commit
pnpm desktop:package                           # build a separate signed preview
pnpm desktop:package -- --dmg                  # request the preview DMG
pnpm desktop:stage                             # rebuild runtime resources for QA without making an .app
pnpm desktop:verify                            # re-run runtime checks only
```

## Update the app on this Mac

Quit Rerun Desktop Preview, then run `pnpm desktop:install` in a clean build worktree.
The command builds its arm64 preview inside `~/Applications/.rerun-desktop-install.noindex`
and installs it at `~/Applications/Rerun Desktop Preview.app`. Open that app after installation.
Pass `--commit` with the full SHA to pin the build you reviewed.

The installer checks the final bundle ID and the matching manifest, Electron shell, UI and engine
build receipts. It checks again that the source is still clean and Rerun is closed before publishing.
macOS swaps the verified bundle into place atomically. A failed build or exchange leaves the
installed app intact. The installer clears its staging output on completion and recovers leftovers
from an interrupted install on the next run. A kernel lock allows only one installer at a time.

For agents reviewing code in separate worktrees, run `pnpm desktop:stage` for runtime QA.
Use `pnpm desktop:package` when you need a separate signed preview.

## Native macOS notification QA

Use the signed Rerun app bundle built from the commit under test. Before launch,
run this read-only check from that clean checkout. It verifies the signing
requirement and matches the manifest, Electron shell, UI and engine build receipts.

```bash
node scripts/desktop/verify-notification-preview.mjs "/absolute/path/to/Rerun Desktop Preview.app"
```

If this check fails, record native delivery and click-through as blocked. A
staged runtime launched through generic Electron can exercise the in-app toast,
Actions inbox and chat recovery. macOS can reject its notification authorization
under the generic bundle identity. Keep Electron’s renderer sandbox enabled.

For a signed preview that passes the check, record OS submission, observed
banner, and the conversation opened by clicking it as separate results.
macOS can suppress banner presentation during screen sharing even after it
accepts the request. Use the current notification settings and keep in-app
delivery results separate.

## Staged layout

Everything under `apps/desktop/` is produced, never committed (`.gitignore`d):

```
apps/desktop/
  dist/main/                     copied verbatim from src/main (plain ESM .mjs + preload.cjs)
  resources/
    runtime-manifest.json        { protocolVersion:1, buildId, nodePath, uiRoot, engineEntry }
    runtime/
      node/bin/node              pinned Node v22.23.4 darwin-arm64 (sha256-checked tarball)
      node/lib/node_modules/     bundled npm (+corepack) for engine MCP installs
      ui/                        Next standalone server.js + traced node_modules +
                                 .next/static + public
      engine/                    `pnpm deploy --prod` output: dist + production node_modules
    LICENSES/                    repo license + per-package third-party licenses
  release/                       electron-builder output (*.app, *.dmg)
```

`runtime-manifest.json` at the Resources root matches the shell contract
(`docs/desktop-runtime-contract.md`): the main process resolves `nodePath`,
`uiRoot/server.js`, and `engineEntry` (`dist/cli/bin.js desktop-run`) relative to
Resources, refuses symlinks escaping Resources, and runs no executable from PATH.

## What the scripts do (`scripts/desktop/`)

- `stage-main.mjs` — copies `apps/desktop/src/main/*` to `dist/main/`, checks the
  required entry/preload/startup files exist.
- `stage-node.mjs` — downloads the pinned Node 22 darwin-arm64 tarball, verifies its
  sha256 (pinned in `lib.mjs`), stages `bin` + `lib/node_modules` (npm included).
  No user-installed Node is used or required.
- `stage-ui.mjs` — builds `@rerun/contracts` then `rerun` with
  `RERUN_DESKTOP_STANDALONE=1` (enables `output:'standalone'` +
  `outputFileTracingRoot` in `next.config.ts`; web/Docker builds are unchanged),
  finds the emitted `server.js` tree, and stages app files + traced
  `node_modules` + `.next/static` + `public`. Stamps `NEXT_PUBLIC_BUILD_SHA` with
  the manifest `buildId`.
- `stage-engine.mjs` — builds the engine (`tsc`), then `pnpm deploy --prod` into a
  temp dir and stages it. `pnpm deploy` materializes the workspace `@rerun/contracts`
  dependency into real `node_modules` beside `dist/`, as the Dockerfile does.
- `stage-licenses.mjs` — repo LICENSE/TRADEMARK plus per-package license files from
  staged node_modules and the bundled Node runtime.
- `write-manifest.mjs` — `buildId = <git-sha>-desktop-<apps/desktop version>`.
- `verify-runtime.mjs` — manifest paths confined to Resources; bundled `node` runs
  and reports v22.23.4; `@libsql/client` and `sharp` load and execute under the
  bundled Node from the staged engine node_modules (N-API/ABI check); npm staged;
  no `.env`/`.git`/key-material files or Resources-escaping symlinks.
- `package.mjs` — all stages and verification, then `electron-builder` with a
  stable local signing identity and strict signature verification.

## Boundaries

- Not staged: Chromium/patchright browser runtime, computer-control tools
  (`RERUN_DESKTOP=off` at launch), the Claude subscription CLI,
  update feed, signing/notarization assets.
- Children receive a scrubbed environment (`childEnvironment` in the shell);
  `.env`, git metadata, and key material are rejected by `verify-runtime.mjs`.
- The engine's Linux self-updater/install paths and the UI service worker are
  disabled in desktop mode by the shell/engine owners.
- `apps/ui` needs `@libsql/client` for the local data layer (Group B); it is declared
  in `apps/ui/package.json` and lands in `pnpm-lock.yaml`.

## Known limits

- arm64 only; x64 staging would need a second Node tarball + arch-matched native
  modules (`@libsql/darwin-x64`, sharp prebuilds) — follow-up.
- UI standalone tracing assumes the workspace `outputFileTracingRoot` at repo root;
  if `standalone/` emits an unexpected layout, `stage-ui.mjs` fails loudly.


The engine stage resolves the pinned Codex native package from its installed dependencies, puts the Mac launcher and sandbox policy beside the executable, and records the launcher in the runtime manifest. Verification invokes the packaged launcher in a temporary profile and checks its version before building the app.
