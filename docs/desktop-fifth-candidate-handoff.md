# Fifth candidate handoff

Source repair of the PR10 validation failures. No install, typecheck, lint, test, build, or runtime was run here. Nothing below is a verified green result. The next Codex run has to rerun the commands.

## Pins

| Tree | SHA |
|---|---|
| PR10 parent | `1012ae4b9cef99574de5e42042fe8cd5b5663df8` |
| Codex preview | `66b228d5ad899e6e34bf932643d2f10a283e2e67` unchanged |
| PR9 | `ff8f5b7fb53dc81ef5c0795182a0905d8266adfd` unchanged |
| PR4 | `134c4f043f102202a8de007bc9e24bcfd531eef5` unchanged |

The validation target is the fifth-candidate pull-request head after this handoff is pushed. Do not reuse `1012ae4b`. The stopped Mac worktree and its generated `packages/contracts/src/desktop-team-reads.js` stay untouched.

Evidence archive SHA256 `c0369e7912972b570643dde7877706a734a8ef5ffbf62e320b9e3c26c0e0e44a`. Recorded identity: Node `v26.0.0`, pnpm `8.15.4`, HEAD `1012ae4b`, install and contracts build exit 0.

## Failure to diagnosis to change

| Log | Diagnosis | Change | Rerun |
|---|---|---|---|
| Engine typecheck/build, team-reads `TS6059` and the emitted `desktop-team-reads.js` | Engine source imported `packages/contracts/src/desktop-team-reads.ts`, so `tsc` pulled that file under `apps/engine` `rootDir` and emitted JS beside the contract source | `apps/engine/src/desktop/team-reads/*.ts` now import `@rerun/contracts` | UNRUN |
| Notify `TS2307` / `TS2835` / `TS2554` | Imports were one directory too shallow, extensions were missing, and `DesktopNotifyUserDeliveryError` requires the status `'unknown'` | `notify-tools/delivery.ts`, `tool.ts`, `index.ts` | UNRUN |
| Table-view `TS2307` / `TS2835` / `TS2345`, and the focused load failures in `tools.test.ts` and `search.test.ts` | `table-view-tools/tools.ts` imported `../agents` from inside `desktop/`, and the zod scope reached the adapters as `unknown` | Paths now start at `../../`. Scope must be `'agent'` or `'shared'` before save or delete. `index.ts` extensions added | UNRUN |
| `registry.ts` `TS7006` | The table-view callback lost its parameter type while that module failed | Callback parameter is `Parameters<typeof hasDesktopToolGrant>[0]` | UNRUN |
| Download and files-import `TS2367` | `lstat` reports `uid` as a number and the owner check used a bigint | `sameOwner` compares `BigInt(stat.uid)` with the expected bigint. The check still refuses a different owner | UNRUN |
| Vision `TS2367` / `TS2353` / `TS2322` | Provider union has no `'opencode'`, `CliModelOptions` has no `sessionId`, and `generateText` cannot take `model: unknown` | String compare with `DESKTOP_OPENCODE_PROVIDER`. Selected model is still kept (`undefined`) or refused (`null`). No fallback model. `sessionId` is not passed into `modelFor`. The port uses `LanguageModel` | UNRUN |
| Web-fetch continuation `TS2304` / `TS2835` and the transform `Expected , or }` | `client.ts` used `WebFetchContinuationPublisher` without importing it. `continuation.test.ts` was missing a closing brace | Import added, `.js` extensions added, brace closed | UNRUN |
| UI import route `TS2307` / `TS18046` | The relative path had one extra `../`, so the error class never resolved | Path now reaches `apps/engine` | UNRUN |
| UI notify route `TS2307` | Same extra `../` | Path corrected | UNRUN |
| `DesktopCoworkerFiles.tsx` `TS2769` | Node 26 rejects `Uint8Array<ArrayBufferLike>` as a fetch body | Bytes are copied into a new `ArrayBuffer` before `fetch` | UNRUN |
| Lint 5 `react/jsx-key` errors | The skeleton test rendered an array of elements without keys. The 993 warnings were not part of this repair | Keys added in `PanelLoadingSkeletons.test.tsx` | UNRUN |
| `DesktopApp.imports.test.tsx` four failures at `.focus()` | The board waits for `/api/desktop/workspaces/2/board-camera`. The fixture treated that read as unexpected, so the tile never mounted. Import refresh behavior was not reached | Fixture returns a workspace-2 camera snapshot. Assertions after the tile opens are unchanged | UNRUN |
| `DesktopCoworkerFiles.test.tsx` null `accept` | The panel now uses the multi-file import control, not the old single-file input | The test posts to `/files/import?path=docs/brief.md` and still expects the clash sentence for the second coworker | UNRUN |

## Still closed

Named selection stays 503. Foreman file grants stay default false. Packet 6 is not started. Packet 7 is not a policy. Duplicate inheritance is unchanged. Share memories and database stay unavailable. Device-code custody, overview, notify pending-row proof, optional connectivity, custom provider, OpenCode activation, company HTTP, WhatsApp, live host, public share, webhook, and mobile stay unmounted. Native smoke stays blocked. Full engine and UI suites stay blocked because they start listeners. The UI production build was not run on PR10 and is not run here.

Finish-seven, next-seven, PR5–PR7, and the Codex repairs that PR10 already carried are still in this tree.
