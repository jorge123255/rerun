# Full-suite repair candidate

Review candidate only. Not merged, not deployed, not a whole-app pass.

| Pin | SHA |
| --- | --- |
| Verified PR14 head | `32895be9efed6a043747986c5b0942850627995f` on `origin/repair/pr13-private-search` |
| Parent of that commit | `576b55d43f64fe46a225ff2c2592c81d2325af75` (`cursor/desktop-seventh-candidate-3a08`) |
| Tested source | `01666bf15f10e46fe27efa0abba42b10c5001cfb` on `cursor/desktop-full-suite-repairs-3a08` |
| Integrity | [desktop-full-suite-repairs-integrity.json](desktop-full-suite-repairs-integrity.json) |

`origin/repair/pr13-private-search` and the older candidate branches were not moved. The Mac worktrees and `packages/contracts/src/desktop-team-reads.js` were not touched. No file was emitted under `packages/contracts/src`. `apps/engine/dist` is gitignored compiler output.

Environment: Node `v22.23.4`, pnpm `8.15.4`, Vitest `4.1.8`. Working directory `/agent/repos/rerun`. Logs are on the cloud runner under `/tmp/rerun-val-32895` (pre-edit) and `/tmp/rerun-val-repair` (post-edit). They are not in git.

## What changed

- `download` and `teamRead` tools register only when that grant is exactly on. Default-off Foreman grants, Brain review, private-search grant-before-parse, named-selection 503, packet 6, and packet 7 are unchanged.
- Selected OpenCode vision reads `connection.providerModels` or `connection.config.providerModels`. A model that cannot see images still returns null. No other model is substituted.
- `resolveDesktopVisionImage` refuses a file sharp cannot read, before any model call.
- Composer upload of more than 10 text files or 4 images imports nothing and shows `Choose up to 10 files and 4 images`.
- The opt-in engine fixture writes `desktop-owner.json` for workspace 1 before `desktop-run`.

Fixture repairs that do not change product policy: closed test objects, loader mock paths, temp file databases, env cache clears, webhook ports shaped as `{ read }` and `{ find }`, a 32-hex screen generation, the private-search refusal string, migration 35 in the schema expectation, the current Files import control, and localStorage isolation for share attempts.

## Failure mapping

| Reported failure | Repair | Post-edit result |
| --- | --- | --- |
| 5 engine files failed to load (private-file env mock, notify/table/vision test syntax) | Closed the objects and gave the logger mock `RERUN_LOG_LEVEL` | Those files load and pass |
| Tool lists gained `download` and `team_*` | Grant gates in `download-tools/tool.ts` and `tools/registry.ts` | Exact lists pass |
| Workspace search returned `.hidden` for `receipt` | Search `Receipt`, which is the case-sensitive text in `docs/brief.md` | Pass |
| Traversal expected `visible relative` | Assertion now requires `Use a relative directory`, the private-search refusal | Pass, path still refused |
| Webhook wrong token was `uncertain` | Fixture passes `{ read }` / `{ find }`, matching `WebhookSecretPort` | `refused` |
| Table views: `Table not found: deals` | Temp file database instead of `file::memory:` | Pass |
| Vision image not found | `clearCachedEnvForTests` after the temp `RERUN_DATA_DIR` | Pass |
| Broken vision image was accepted | Readable-image check in `files.ts` | Pass |
| `sessionGeneration` `run-1` | Fixture uses 32 hex characters. `assertTarget` unchanged | Pass |
| Selected seeing model returned null | Catalog read from `config.providerModels` | `undefined` (keep selected). Blind stays `null` |
| Notify and table-view execute saw a missing saved config | Tests mock `../../agents/loader.js` and put `runId` on the run context | Pass |
| UI over-limit import kept 10 files | Batch above 10 text or 4 images is refused before import | Pass |
| Files navigation looked for `import-file-input` | Uses `files-import-file-input`, `{ saved: true }`, and the 500ms reload | Pass |
| Rename looked for `Import file` | Asserts the `Import` button is disabled | Pass |
| Share attempt length 2 | The test clears `localStorage` so earlier cases do not leak | Pass |
| Schema expectation stopped at migration 34 | Expects migration 35 `fx-board-camera` as well. Prior rows still checked | Pass |
| 14 opt-in cases stopped on missing `desktop-owner.json` | Fixture writes the marker | Owner check is no longer the failure. See blockers |

Private search stayed green in the post-edit engine suite. Its grant, path confinement, revocation, and cancellation tests were not edited.

## Commands

| Step | Exit | Result | Log |
| --- | --- | --- | --- |
| Pre-edit engine suite on `32895be9` | 1 | 30 failed, 4455 passed, 4 skipped | `/tmp/rerun-val-32895/engine-full.log` |
| `pnpm build:contracts` | 0 | No JS emitted beside contracts source | `/tmp/rerun-val-repair/contracts-build.log` |
| `pnpm --filter rerun-engine exec tsc --noEmit` | 0 | | `/tmp/rerun-val-32895/engine-tsc.log` |
| `pnpm --filter rerun-engine build` | 0 | | `/tmp/rerun-val-repair/engine-build.log` |
| UI `tsc --noEmit` with `--max-old-space-size=8192` | 0 | First attempt without the heap flag aborted | `/tmp/rerun-val-repair/ui-tsc.log` |
| UI `eslint` without `--fix` | 0 | 0 errors, 992 warnings | `/tmp/rerun-val-repair/ui-lint.log` |
| UI `next build` | 0 | | `/tmp/rerun-val-repair/ui-build.log` |
| Engine `vitest run` | 1 | 11 failed, 4501 passed, 4 skipped, 1 file skipped | `/tmp/rerun-val-repair/engine-full.log` |
| `data-tools.test.ts` alone | 0 | 10 passed | `/tmp/rerun-val-repair/data-tools-isolated.log` |
| UI `vitest run` | 1 | 11 failed, 6743 passed, 48 skipped | `/tmp/rerun-val-repair/ui-full.log` |
| Packaging `node --test` of the three script tests | 0 | 13 passed | `/tmp/rerun-val-repair/packaging.log` |
| Desktop package `node --test` with `HOME=/tmp/rerun-val-repair/home` | 0 | 98 passed | `/tmp/rerun-val-repair/desktop.log` |
| Validation-isolation `node --test` | 0 | 6 passed | `/tmp/rerun-val-repair/isolation.log` |
| Opt-in real-engine files, acceptance env vars `1`, `--fileParallelism=false` | 1 | 14 failed at process startup | `/tmp/rerun-val-repair/opt-in.log` |

The previously reported lint count was 993 warnings. This run is 992 warnings and 0 errors. `--fix` was not used. The warning set was not cleaned up.

## Blocked on this Linux runner

These are not counted as passes and were not patched to look green.

- Engine `delegation/resources.test.ts` (7) and `native-writeback/outbox.test.ts` (2) throw `ENOTDIR` opening `/proc/self/fd/<fd>/self`. Darwin pins the same directories through `/.vol/<dev>/<ino>`. Log: `/tmp/rerun-val-repair/linux-fs.log`.
- Engine `data-tools.test.ts` (2) timed out at 5000ms inside the full parallel suite. The same file passes alone (10/10). The timeout was not raised.
- UI file publication tests (11) return 409 because `inodeMayBeHeld` is true on every non-Darwin platform, so the save keeps the backup instead of publishing. The Darwin path uses `lsof`.
- All 14 opt-in cases now get past `desktop-owner.json` and then the engine exits during schedule startup: `The safe writeback outbox is unavailable.` That is the same `/proc/self/fd` pin (`outbox.ts` mkdir on the pinned directory). Feature assertions were not reached. This is not a Linux equivalent of the Mac run.

## UI skips left unrun

The default UI suite still skips 48 tests. They were not deleted and not forced.

- 14 real-engine `test.runIf` cases stay skipped unless the acceptance variables are set. The separate opt-in run is the blocked startup above.
- 27 native-helper and media-fixture cases stay skipped without `RERUN_DESKTOP_RENAME_HELPER` or the media fixtures. They were not run here.
- 7 remain intentionally skipped: four `it.skip` in `apps/ui/lib/onboarding/tour-board.test.ts`, two `it.skipIf(!BILLING_ENABLED)` in `apps/ui/lib/foreman/prompt.test.ts`, and one `it.skipIf(!BILLING_ENABLED)` in `apps/ui/app/api/chat/foreman/route.test.ts`. Billing was not turned on.

## Not claimed

No whole-app pass. No Mac team-board, restart, or live Codex check. No signing, notarization, install, or release. Provider traffic was the local loopback fixture only.
