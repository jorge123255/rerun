# Sixth candidate handoff

Source repair of the five PR11 failures. No install, typecheck, lint, test, build, or runtime was run here. These changes are source-addressed and still UNRUN.

## Pins

| Tree | SHA |
|---|---|
| PR11 parent | `d4a8d22c089328fd1bf7fc62008b5e91c4513713` |
| PR10 | `1012ae4b9cef99574de5e42042fe8cd5b5663df8` unchanged |
| Codex preview | `66b228d5ad899e6e34bf932643d2f10a283e2e67` unchanged |

The validation target is the sixth-candidate pull-request head. Do not reuse `d4a8d22c`. Do not clean the stopped PR10 or PR11 Mac worktrees.

Evidence archive SHA256 `238318a602331cc377dbf981cfb2aaaebb220f01f582251226d8e73b24a8fa46`. PR11 recorded Node `v26.0.0`, pnpm `8.15.4`, install PASS, contracts build PASS, UI typecheck PASS, lint 0 errors and 993 warnings, App import tests 4/4, packaging 13/13, and a clean postflight with no unexpected emit.

## Failure to cause to repair

| Log | Cause in source | Repair | Rerun |
|---|---|---|---|
| Engine `TS2345` at `table-view-tools/tools.ts:104`, and the engine build with the same diagnostic | The tool schema leaves `layout` optional. `TableViewInput` requires it. The store already treats a missing layout as `table` | The save call now passes `input.layout ?? 'table'` after the rest of the input | UNRUN |
| UI `next build` Turbopack module-not-found for `export-metadata.js`, `open-without-links.js`, `transport.js`, `backend.js`, `errors.js`, `paths.js` | Those UI routes import engine source. The engine compiler rewrites `.ts` specifiers to `.js` on emit (`rewriteRelativeImportExtensions`). Turbopack was asked to load `.js` files that exist only as `.ts` | The UI-reached imports now use the `.ts` source names, matching `isolated-screen` and `web-fetch`. Node emit still rewrites them to `.js` | UNRUN |
| Private search: `ENOENT` on `~/.rerun/agents/reader/config.json.tmp`, 5 skips | `env()` caches the first read. Another file in the same Vitest process had already cached the default home directory, so the temp `RERUN_DATA_DIR` was ignored. The write failed and did not create the home file | The test points `RERUN_DATA_DIR` at its own temp directory, clears that cache, creates only that temp agent directory, and asserts the config path is under the temp root and not under `~/.rerun`. `afterAll` restores the previous value | UNRUN |
| Files import expected `Imported`; the rendered text was `1 file imported` | A successful tray is collapsed. The heading from `filesImportSettlement` is `1 file imported`. The per-row `Imported` line is not in the collapsed text | The assertion expects `1 file imported`. The clash sentence for the second coworker stays | UNRUN |
| Validation-isolation: Node `--test` could not find package `vitest`, 2 files failed to load | `@rerun/desktop` declares `node --test` and does not depend on Vitest. The fixtures imported Vitest, and `isolation.mjs` omitted the `.mjs` extension Node ESM requires | Fixtures use `node:test` and `node:assert/strict`. Relative imports use `.mjs`. They remain design checks, not a native startup proof | UNRUN |

The 993 lint warnings were not changed.

## Still closed

Named selection stays 503. Foreman file grants stay default false. Packet 6 is not imported by desktop startup. Packet 7 is not a policy. Selected vision still does not substitute another model. Unknown notify results are not retried. `.rerun*` stays excluded and ordinary hidden files stay. Share memories and database, device-code custody, overview, optional connectivity, subscription profiles, WhatsApp, live host, public share, webhook, and mobile stay unmounted. Full suites and the desktop listener glob stay blocked. Native smoke stays blocked. A HOME override is not isolation proof.

Finish-seven, next-seven, PR5–PR7, and the PR10 and PR11 repairs remain in this tree.
