# Third candidate handoff

Source integration only. No tests, typecheck, lint, build, install, runtime, provider, account, OAuth, Keychain, or listener was run. This is not app acceptance and not a PASS.

## Pins

| Tree | SHA | Role |
|---|---|---|
| Frozen base | `8297fe6404caa114dcb0c2cd6006291a8abb2038` | ancestor of every candidate |
| PR4 | `134c4f043f102202a8de007bc9e24bcfd531eef5` | first candidate, unchanged |
| PR8 | `cf388d693fc8ff5211912a987f593ff5df42c02b` | second candidate, parent of this branch |
| Archive | SHA256 `6e1374923bd8f2683914ff600dbffd4ab8ab9c6952fd8f5662af2cbfba02cd66` | next-seven source |

Remote `origin/cursor/desktop-second-candidate-3a08` was fetched and contained `cf388d693fc8ff5211912a987f593ff5df42c02b` before this branch was created. The Mac scan missing that object is not a failure.

## Applied input matrix

| Packet | Tip | Applied | Class |
|---|---|---|---|
| 1 MCP login | `0fb3cd35cd018fc921f50f9e494d9164cf6fd19f` | yes, then mounted | ready feature; device-code custody not bound |
| 2 Files grid | `f87393aed4a2d13a70eff38577e7aff5a9c0c8ca` | yes, then mounted | ready feature |
| 3 Files import | `349aca1f790145128c622ea544bd34af72cc2783` | yes, then mounted | ready feature; chat composer not pointed here |
| 4 Private regex | `54571a8f6c1b4af38d354989b31812768ac291d4` | yes, then mounted | ready feature; replaces private `fs_search` only when `workspaceSearch` is on |
| 5 Web fetch continuation | `79dec2c86b3b2a6cec2a02e1b6dd211db2a3b6c7` | yes, then mounted | ready feature; save stays unconfirmed when authority is missing |
| 6 Isolation fixtures | `f57b5840514720b85bda8ba0b92aaa4cbc983b9e` | yes, additive only | design/fixtures; startup not changed |
| 7 Duplicate evidence | `95695eaf020b6a6733cd89bbf6175f2d0076acba` | yes, inert types and docs | evidence only; no enforcement |

No packet was rejected. Finish-7, PR5–PR7, master nine, and RD37/RD38 were not reapplied. Patch paths did not overlap the PR8 delta.

## What is mounted

- MCP login factory replaces `desktopMcpSignInTools` at `apps/engine/src/tools/registry.ts:111`. Both subscription filters admit branded login tools only when `grants.mcp` is on (`apps/engine/src/agents/providers.ts` Claude and Codex filters). Catalog row lists the four names and says device-code fallback needs a separate adapter (`packages/contracts/src/desktop-tool-grants.ts` `mcp` row). The sign-in closer requires enabled, non-ephemeral, and the `mcp` grant (`apps/engine/src/agents/systemPrompt.ts` `request_mcp_sign_in`). The loopback route is `apps/ui/app/api/desktop/internal/mcp-login/route.ts` via `apps/ui/lib/desktop/server/mcp-login-binding.ts`. The route factory is called without a device-fallback port (`apps/engine/src/desktop/mcp-login-tools/route.ts` comment at the backend call).
- Files grid replaces the list inside `DesktopCoworkerFiles` (`DesktopFilesGrid` in that file). Thumbnails read the existing `/read` route. The hidden-file test assertion now looks for `[data-files-name=".env"]`.
- Files import uses `FilesImportMenu`, drag-and-drop, and `FilesImportTray` on the same panel. Bytes go to `POST /api/desktop/agents/:agentId/files/import`, which resolves `coworkerWorkspace` and calls `publishFilesImport`. The older one-file `POST` on `files/route.ts` remains. The chat composer was not retargeted.
- Private regex `fs_search` overwrites the literal search only when `hasDesktopToolGrant(..., 'workspaceSearch')` is true (`registry.ts:110`). The search itself rechecks the grant and skips `.rerun*` segments (`apps/engine/src/desktop/private-search/files.ts`).
- Served HTML is in the artifact union (`apps/engine/src/desktop/isolated-screen/types.ts`), both transport allowlists, `exportPath`, the UI artifact schema, and `publish-web-fetch`. `executeWebFetch` saves only when a continuation port is bound. The tool binds that port only when `runId` and `toolCallId` exist and `isolatedScreenOwner` can be read; otherwise the fetch stays available and unsaved. Publication requires `webFetch` and `privateFileWrite` (`browser-exports/service.ts` web-fetch branch).

## Gated or missing, with the dependency

| Item | Why it stays closed |
|---|---|
| Device-code / OAuth custody | No canonical human fallback decision or encrypted pending-device store. Binding `ApprovedDeviceFallback` would invent one. |
| Packet 6 startup | `apps/desktop/src/main/index.mjs` does not import `validation-isolation`. Network and provider suppression are not proven by the fixture. Native smoke stays BLOCKED. |
| Packet 7 enforcement | Four options are documented in `packages/contracts/src/desktop-duplicate-policy-options.ts` and are not exported from the contracts barrel. Duplicate behavior is unchanged. |
| Coworker overview | `DesktopCoworkerOverviewRootMount` needs `DesktopOverviewIdentity` (`ownerId`, positive `workspaceId`, `agentId`). The conversation shell does not receive that identity, boxes, or a truthful `canManage`. Passing `canManage: true` would invent manager rights. |
| Notify pending-row loop | `/api/desktop/engine/notify-user` still returns `unknown` and does not retry. The toast path still records shown before the native bridge. There is no confirmed native result adapter to drive pending rows, so that loop was not added. |
| Custom provider, OpenCode, chat v2, company HTTP, RD38 I | No new production port arrived with these packets. Optional connectivity stays unstarted. Company profile still has schema only. |
| Named connection select | Still 503 without `authorizeSelection`. The panel still receives `selectionContext={null}`. |
| Foreman file tools | Still registered only for the Foreman id when the read/write grants are exactly true. Empty tools with grants off is the default, not a defect to clear. |
| Share memories/database, WhatsApp, live host, public share, webhook, mobile, account activation | Still waiting on their own authorities. Profiles are not a second account. |

## Review notes

- The continuation client posted identity without `artifacts`. The authored client test expects `body.artifacts`. The publisher now puts the base64 artifacts on that field so `publish-web-fetch` can use the existing parser. A missing or refused save stays unconfirmed (`webFetchContinuationNote`).
- Files import progress reported to the tray is the request boundary. The publisher still checks the path, reservation, type, size, clash, owner, and link. An unconfirmed result is returned with its code and is not treated as saved.
- Selected vision model, `.rerun*` exclusion, Brain review, and the unknown-is-not-shown notify rule from PR8 are unchanged.
- All authored regressions remain UNRUN. Do not read this handoff as a green report.
