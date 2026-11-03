# Desktop packaging (internal preview)

Packages the desktop app shell into an unsigned macOS `.app` for arm64. This is an
internal/development artifact only: it is not signed, not notarized, and not for
general distribution. Signing (Developer ID on the OpenFlix team), notarization,
update hosting, and x64 builds are separate release work.

## Commands

```bash
pnpm install                                   # workspace deps incl. electron + electron-builder
pnpm desktop:package                           # stage runtime + build unsigned .app (dir target)
pnpm desktop:package -- --dmg                  # additionally produce an unsigned DMG
pnpm desktop:stage                             # stage resources only, no electron-builder
pnpm desktop:stage                            # always rebuild UI/engine from committed source
pnpm desktop:verify                            # re-run runtime checks only
```

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
- `package.mjs` — all stages + verify, then `electron-builder --mac --arm64 dir`
  (or `dmg`). `identity: null` in `electron-builder.yml` forces unsigned output.

## Boundaries

- Not staged: Chromium/patchright browser runtime, computer-control tools
  (`RERUN_DESKTOP=off` at launch), subscription provider CLIs (gated until verified),
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
- The unsigned `.app` may need `xattr -d com.apple.quarantine` if moved via download;
  intended for local/internal use.
- UI standalone tracing assumes the workspace `outputFileTracingRoot` at repo root;
  if `standalone/` emits an unexpected layout, `stage-ui.mjs` fails loudly.
