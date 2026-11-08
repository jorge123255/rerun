# Round 38 — Lane H: packaged-runtime readiness audit

Source audit and narrowly scoped readiness guards only. **No release-readiness or acceptance claim.** No tests, typechecks, lint, builds, packaging, installs, servers, provider/network calls, Docker, native UI, Keychain, signing, notarization or restart checks were executed. No live profile, log, credential, database or installed-app state was inspected. No certificate, entitlement, update-feed, dependency, installation or central runtime file was changed.

- **Worktree:** `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round38-h-readiness`
- **Branch:** `desktop/round38-h-readiness`
- **Prepared HEAD verified clean:** `6f6ad959a09abaf1947950b6f82413c94407e22a`
- **Owned guard commit:** `30031c78d5f0293bb7689167f37b2a830a86b4bb`
- **Owned source paths:** `apps/desktop/src/main/readiness/**` and this handoff
- **Central packaging/runtime files:** inspected read-only; exact proposed root fragments below, not applied here

## Stable workflow invariants preserved

The current source workflow is a **signed local preview**, despite stale unsigned wording in `docs/desktop-packaging.md`.

| Boundary | Inspected source and required preservation |
|---|---|
| Signer | Preserve `21C5B4D06CE5EDF47143C1327B72D76E478A065D`. `scripts/desktop/signing.mjs` selects the installed preview authority or an explicit unique identity and passes its hash to electron-builder. No alternative identity was introduced. |
| Canonical app | `/Users/gszulc/Applications/Rerun Desktop Preview.app`, bundle ID `build.rerun.desktop.preview`. `install.mjs` checks that ID, matching receipts, unchanged source, closed app and atomic publication. No second app or install-path change. |
| Dependency versions | Electron `44.9.0`, electron-builder `26.18.1`, pnpm `8.15.4`, bundled Node `v22.23.4`, Codex override `0.166.0`. No manifest/lockfile edit or install was performed. |
| Signing/notarization | `package.mjs` supplies stable signing arguments and runs `codesign --verify --deep --strict`. Notarization remains disabled for this local preview; no entitlement or hardened-runtime change. |
| Update/install | Atomic exchange under `~/Applications/.rerun-desktop-install.noindex`, kernel lock, source/installed-app race checks and cleanup. No update feed or installation change. |

## Original / stable-workflow mapping

| Area | Actual inspected paths | Finding / disposition |
|---|---|---|
| Packaging and stable identity | `apps/desktop/{package.json,electron-builder.yml}`, `scripts/desktop/{package,signing,install,provenance,lib}.mjs` | Stable signed workflow present; preserve it. Stale documentation identified separately below. |
| Resource staging and verification | `scripts/desktop/{stage-main,stage-node,stage-ui,stage-engine,stage-file-helper,stage-pdf-helper,stage-pdf-text,write-manifest,verify-runtime,packaged-layout.test}.mjs` | Two concrete defects H-01/H-02 below. Other inspected required entries and native helper paths remain manifest-bound. |
| Runtime/module resolution | `apps/desktop/src/main/{index.js,index.mjs,runtime.mjs,ui-host.mjs,supervisor.mjs}`, `docs/desktop-runtime-contract.md`, recent `d3f5a135` | Packaged UI host and engine entry resolve through Resources, not ASAR or PATH. Recent UI-shared engine helpers now use source-resolvable `.ts`/package imports; no remaining direct cross-source `.js` import was found in the focused sweep. |
| Workspace/profile ownership | `runtime.mjs`, `workspaces/{paths,isolation,catalog,coordinator}.mjs`, `index.mjs` | Per-install/workspace engine roots, owner markers, derived credentials, per-workspace Electron partitions and current-renderer checks remain intact. No ownership migration or alternate catalog is proposed. |
| Crash/shutdown cleanup | `supervisor.mjs`, `before-quit.mjs`, `ui-host.mjs`, `index.mjs`, existing native tests | Owned-child startup identity, bounded start/stop, draft flush, exact-runtime tool drain, uncertain-cleanup custody and parent-disconnect termination remain intact. No lifecycle rewrite justified. |
| Diagnostic/log redaction | `supervisor.mjs` shutdown diagnostic projection, child stdio handling, `write-manifest.mjs` | Diagnostics use a fixed allowlist without runtime objects, raw errors, paths, argv, provider data or environment. Child output is discarded rather than logged. No new redaction defect found in the inspected paths. |
| Prior readiness/handoffs | Round31–36 H handoffs, `desktop-handoff-integration-review.md`, `desktop-round35-integration.md`, `desktop-round36-g-handoff.md`, `desktop-packaging.md`, `desktop-runtime-contract.md` | Prior source/native evidence is historical context only, not acceptance of this package. Root must execute the new matrix. |

## Evidenced findings and minimal corrections

### H-01 — Resource scanner misses a parent symlink and a broken symlink

**Evidence:** `scripts/desktop/verify-runtime.mjs` resolves each symlink and records an escape only when `relative(realResources, target).startsWith('..' + sep)`. A link targeting the Resources parent yields exactly `..`, which that predicate misses. If `realpath` fails, `target` is null and the link is silently ignored. The runtime `loadBundle` predicate already handles the exact-parent case, so this is isolated to the staging verifier.

**Owned guard:** `apps/desktop/src/main/readiness/resources.mjs` exports `pathEscapesRoot`, handling exact parent, descendants of the parent and absolute different roots. `resources.test.mjs` covers those cases plus valid nested resources. Authored, unrun.

**Exact root patch fragment:** apply to `scripts/desktop/verify-runtime.mjs`; keep the rest of the verifier unchanged.

```diff
 import { readUiSharpManifest } from './ui-sharp.mjs'
+import { pathEscapesRoot } from '../../apps/desktop/src/main/readiness/resources.mjs'
 
 const execFileAsync = promisify(execFile)
@@
-await scan(resourcesDir)
+const canonicalResources = await realpath(resourcesDir)
+await scan(resourcesDir)
@@
         } else if (entry.isSymbolicLink()) {
             const target = await realpath(path).catch(() => null)
-            if (target && relative(await realpath(resourcesDir), target).startsWith('..' + sep)) escapees.push(path)
+            if (!target || pathEscapesRoot(canonicalResources, target)) escapees.push(path)
         } else if (forbidden.test(entry.name) || secretExt.test(entry.name)) {
```

The root patch intentionally rejects an unresolvable link rather than treating it as a valid packaged resource.

### H-02 — Native test and fixture adapters are copied into the packaged main process

**Evidence:** `stage-main.mjs` copies all of `apps/desktop/src/main` recursively. `electron-builder.yml` includes `dist/main/**/*`. The copied tree currently includes `remote-machines/*.test.mjs` and `remote-machines/fixtures.mjs`; fixture-only custody/cipher adapters and synthetic test identities are not production startup code. Existing production files do not import those test modules. This is unnecessary packaged surface, not evidence of a live secret.

**Owned guard:** `apps/desktop/src/main/readiness/production-main.mjs` exports `productionMainModule`, rejecting `*.test.mjs` at any depth and `fixtures.mjs`, while retaining production `.mjs`, `preload.cjs` and `startup.js`. `production-main.test.mjs` covers nested tests, fixtures, production modules and path separators. Authored, unrun.

**Exact root patch fragment:** apply to `scripts/desktop/stage-main.mjs`.

```diff
 import { cp, mkdir } from 'node:fs/promises'
-import { join } from 'node:path'
+import { join, relative } from 'node:path'
 import { cleanDir, desktopDir, existsSync, resourcesDir } from './lib.mjs'
 import { sourceStamp, writeStamp } from './provenance.mjs'
+import { productionMainModule } from '../../apps/desktop/src/main/readiness/production-main.mjs'
@@
-await cp(src, dist, { recursive: true })
+await cp(src, dist, { recursive: true, filter: source => productionMainModule(relative(src, source)) })
```

No production import needs to change. The new readiness guards themselves are included by the same copy; their `.test.mjs` files are excluded.

### H-03 — Packaging guide contradicts the current signed workflow

**Evidence:** `docs/desktop-packaging.md` says the artifact is unsigned and `identity: null` forces unsigned output. Current `electron-builder.yml` instead documents stable local signing, and `package.mjs`/`signing.mjs` select a stable identity and strictly verify the signed bundle. Following the stale guide would misrepresent the stable-identity workflow.

**Exact root documentation fragment:** update the introduction and packaging description, without changing signing configuration.

```diff
-Packages the desktop app shell into an unsigned macOS `.app` for arm64. This is an
-internal/development artifact only: it is not signed, not notarized, and not for
-general distribution. Signing (Developer ID on the OpenFlix team), notarization,
-update hosting, and x64 builds are separate release work.
+Packages the desktop app shell into a signed macOS `.app` for arm64. This is an
+internal/development artifact only: it is not notarized and not for general
+distribution. The established local preview signing identity is retained for
+Keychain continuity. Public distribution, notarization, update hosting and x64
+builds are separate release work.
@@
-`package.mjs` — all stages + verify, then `electron-builder --mac --arm64 dir`
-  (or `dmg`). `identity: null` in `electron-builder.yml` forces unsigned output.
+`package.mjs` — all stages + verify, then `electron-builder --mac --arm64 dir`
+  (or `dmg`). `previewSigningArguments()` selects the stable local preview identity,
+  and the script verifies the resulting signature with `codesign --deep --strict`.
@@
-- The unsigned `.app` may need `xattr -d com.apple.quarantine` if moved via download;
-  intended for local/internal use.
+- The signed local preview is not notarized; public distribution remains separate
+  release work. It is intended for local/internal use at the canonical app path.
```

Do not add the certificate hash to generated manifests or logs. It is recorded here only as an explicit preservation requirement from the assignment.

## Owned files and expected regression outcomes

- `apps/desktop/src/main/readiness/resources.mjs`: pure root-confinement predicate used by the proposed verifier fragment.
- `apps/desktop/src/main/readiness/resources.test.mjs`: exact parent `..`, outside descendants/siblings, different root and valid nested resources.
- `apps/desktop/src/main/readiness/production-main.mjs`: production-main module filter used by the proposed staging fragment.
- `apps/desktop/src/main/readiness/production-main.test.mjs`: nested test/fixture exclusion and production-entry retention.
- `docs/desktop-round38-h-handoff.md`: this audit and activation record.

No guard was added for signing, workspace ownership, shutdown or redaction because the inspected source did not establish a defect in those areas. No packaging pipeline replacement was created.

## Root verification matrix — all unexecuted here

| Area | Root action and expected evidence |
|---|---|
| Authored guards | Run `node --test apps/desktop/src/main/readiness/*.test.mjs`; parent/different-root escapes are rejected, production entries remain, test/fixture entries are excluded. |
| Existing packaging regressions | Run `scripts/desktop/{packaged-layout,signing,install}.test.mjs` with the repository's normal runner; existing resource, identity, bundle ID and atomic-install behavior remains. |
| Staged main inventory | After staging, enumerate `apps/desktop/dist/main`; no `*.test.mjs` or `fixtures.mjs` is present, while `index.js`, `index.mjs`, `preload.cjs`, startup files, workspace and remote-machine production modules remain. |
| Symlink fixtures | In a disposable staging fixture, verify a link to the Resources parent, an outside descendant and a broken link are all rejected; ordinary contained links remain accepted. |
| UI/engine module resolution | Run both typechecks and affected UI/engine suites, then the production UI/engine builds. Confirm shared engine helpers resolve in the packaged UI and no source-tree-only import is required. |
| Runtime staging | Run the normal stage and runtime verifier. Confirm bundled Node/native modules, helpers, resource confinement, manifest receipts and absence of staged secret/VCS files. |
| Signature continuity | Package with the unchanged stable workflow; verify the expected established signer and deep strict signature without changing entitlements/notarization. Do not create a second app. |
| Canonical install/restart | On root's approved QA path, install the exact reviewed commit at the single canonical app path, then verify startup, ordinary Quit, cold restart, workspace ownership and saved state. |
| Cleanup diagnostics | Exercise root's startup failure, Stop, crash and failed-drain fixtures; confirm owned children close or retry with custody intact and diagnostics contain no raw errors, paths, environment or credentials. |

## Residual risks and boundaries

- No staged bundle was produced or inspected in this lane. Root must prove the filter and scanner against actual output.
- No live signing certificate, Keychain item, installed signature or canonical app was read. Preservation is established from source plus the supplied invariant, not independently verified locally.
- The focused source sweep found no additional defect in workspace ownership, startup/shutdown custody or redaction; this is not proof of runtime correctness or release readiness.
- Remote-machine activation remains governed by its existing root dependencies. No remote pairing, external listener or gateway was enabled.
- The packaging guide has other historical product-scope prose; this package corrects only the evidenced signing contradiction and does not rewrite the guide wholesale.
- Root owns integration, all execution checks, repairs and any installed/restart decision. No push, merge, deployment or acceptance claim is made.
