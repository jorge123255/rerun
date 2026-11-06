# Second source integration candidate

Source composition only. Not tested, not typechecked, not built, and not accepted. This is not a whole-app PASS.

PR4 stays `134c4f043f102202a8de007bc9e24bcfd531eef5` on `cursor/desktop-delivered-integration-3a08`. This candidate is a new branch. It does not rewrite PR1–PR7 or that tip.

## Pins

| Role | SHA |
|---|---|
| Frozen base | `8297fe6404caa114dcb0c2cd6006291a8abb2038` |
| PR4 tip, parent of this candidate | `134c4f043f102202a8de007bc9e24bcfd531eef5` |
| PR4 root wiring | `a6d1a7d39a321573f159dca434b3f030bdf3e01f` |
| Seven-packet archive | SHA256 `4eaae3b386aead6d6e704a2327a2fca126ad63b9f44172ce4679a8ba62ab7714` |
| Seven compose commit | `11e5fa2ed` recorded in git log as the commit `feat(desktop): compose the seven delivered finish packets` |
| PR5 remote tip | `716d46b4cd3d4256a80d4b014785bc62aaa44893` (impl `455f3becb1e8023626c626c517ea6017fda7adb5`) |
| PR6 remote tip | `5e2abb4b16f7763a2da08b43c1c8880aa79ffb71` (impl `2cc4fb9e8eee302170a399fa5e52c585af722ab7`) |
| PR7 remote tip | `4ad8449b56118ed9ee0bdda8d276a48dba3ba043` (impl `8f1c906f658dbaa2d4f054d065c388e2204836c8`) |

Cherry-picks on this branch are new SHAs. The remote tips were verified before cherry-pick and were not replaced with later tips.

## Seven packets

| Packet | Tip | Review |
|---|---|---|
| Scheduler | `933592d550df96f34131d0783e43ff9d77dbf19a` | Accepted. Computation stays inside `next-run.ts`. HTTP write/update map `ScheduleTimingError` to 400. |
| Team reads | `0e85c69556bd53a9f89d01670574fdfd07371954` | Accepted default-off. Directory reads `desktop_agents` in the desktop catalog only. No disk listing of agents. |
| Download | `2ba0bcf9fc7a1c20a8d40bdedb0da32c388fbac6` | Accepted. Public GET, 50MB, 3 redirects, reserved `.rerun*` / `.rerun-skill*` refused, ordinary hidden names allowed. Not `webTools`. |
| Vision | `bacbd5bbccb5569cf7a4ba6268d128b51e72cb46` | Accepted with a repair. The packet substituted another seeing Go model on the same OpenCode connection. This branch returns null instead. The selected model and connection are not replaced. |
| Table views | `ea31f8c8431aa0272738e47803d1560c0734dc33` | Accepted. Save and delete view only. Rows are not deleted. Grant `tableViewWrite` defaults off. |
| Notify | `2c94faa22bd04b4629f3510557d51b2bd23a3b0d` | Partially mounted. The tool is registered only with the `notify` grant. The loopback returns `unknown` and does not mark `shown`. The existing toast-first path was not reused as proof of delivery. The pending-row renderer loop is not wired. |
| FX | `51fbe67470798d901f55362a645a11fc5cab6ffb` | Accepted. Overflow grouping replaces the batch cap of 14 and keeps per-file document outcomes. Camera table is desktop migration 35. Five loading skeletons replace loading sentences only. |

No packet was rejected. None were double-applied onto PR4’s RD37/RD38 or PR1–3 files. Patch paths did not overlap the PR4 delta.

## Migrations

| Ladder | Version | Id |
|---|---|---|
| Desktop UI sqlite | 34 | `company-profile-derived-attempts` (from PR4) |
| Desktop UI sqlite | 35 | `fx-board-camera` |
| Engine data-dir | 8 | `desktop-api-connections` (from PR4) |

Subscription-profile DDL was not given a number. A profile directory is not a second ChatGPT or Claude account. The single `mac-chatgpt` and `mac-claude` adapters stay the only authenticated sessions.

## Mounted

- `apps/engine/src/tools/registry.ts` desktop branch: download, table views, team reads, vision, notify.
- `packages/contracts/src/desktop-tool-grants.ts`: `download`, `tableViewWrite`, `teamRead`, `vision`, `notify`. Each stored grant is on only when the value is exactly true.
- `apps/engine/src/desktop/team-reads/directory.ts`: catalog SQL, workspace mismatch returns other-workspace without the foreign name.
- `apps/engine/src/http/routes/schedules.ts`: timing failures are HTTP 400.
- `apps/ui/lib/desktop/server/schedules/api.ts`: preflight calls `nextRun()`.
- `apps/ui/components/desktop/DesktopConversation.tsx`: `planFxAttachmentBatch`.
- `apps/ui/app/api/desktop/workspaces/[workspaceId]/board-camera/route.ts` and `DesktopApp` camera boundary when `runtimeWorkspaceId` is known. Quit awaits that flush and does not treat `false` as saved.
- Loading skeletons in Files, Memories, Settings, Schedules, and Tools. Error text stays.

## Gated, not enabled

| Item | Why |
|---|---|
| API-connection select | `createApiConnectionsRouteHandlers` is called without `authorizeSelection` (`apps/ui/app/api/desktop/api-connections/[workspaceId]/[kind]/route.ts`). The panel passes `selectionContext={null}` (`DesktopSettings.tsx`). Settings `setBoxDefault` remains the default-model path. This is an intentional gate, not a failed named-connection request. |
| Share memories and database | Unavailable strings remain. Capture, validation, and install are not all bound. |
| WhatsApp posting | Component is not mounted. |
| RD38 I startup | `apps/desktop/src/main/index.mjs` does not import `remote-gateway`. The existing `remote-machines` coordinator is the store. No listener was added. |
| PR5 optional connectivity | Modules are present and default disabled. `createOptionalConnectivityFoundation` is not called from startup. No host, relay, public share route, webhook delivery, or phone pairing. |
| PR6 extra profiles | Selector is not mounted. No migration creates a second account. Named profiles stay unavailable. |
| PR7 overview shell | Not inserted into `DesktopConversation`. The existing coworker card and accepted panels stay. Mounting it would need a proven owner/workspace identity and `canManage` from a real manager check; those props are not on the conversation today. |
| Custom provider, OpenCode, chat-interaction v2, company-profile HTTP | Modules from PR4 remain unmounted. No production port bundle or Foreman app object was passed in. They are unavailable, not reported connected. |
| Notify native shown/failed | The new route answers `unknown` and does not retry. It does not call the OS banner. Unknown is not shown. |
| Duplicate grant inheritance | Unchanged. No new forbid-copies rule. |

## Foreman listing

`foremanAgentFileTools` (`apps/engine/src/desktop/foreman-agent-files/tools.ts`) returns no file tools unless `foremanAgentFilesRead` or `foremanAgentFilesWrite` is exactly true, and only for the Foreman id. `desktopForemanTools` still returns before the hosted `agentFilesTools()` mount (`apps/engine/src/tools/registry.ts`). An empty file-tool list with the grants off is the default-off gate, not a confirmed wiring failure.

## Checks

Authored regressions are unrun. No typecheck, lint, build, install, or runtime was executed. `@rerun/contracts` `dist/` was not rebuilt.
