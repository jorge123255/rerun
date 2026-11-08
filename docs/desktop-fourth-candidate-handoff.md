# Fourth candidate handoff

Source reconciliation only. No install, typecheck, lint, test, build, runtime, provider, account, or listener was run. This is not app acceptance and not a PASS.

## Pins

| Tree | SHA | Role |
|---|---|---|
| Frozen base | `8297fe6404caa114dcb0c2cd6006291a8abb2038` | ancestor |
| PR4 | `134c4f043f102202a8de007bc9e24bcfd531eef5` | first candidate, unchanged |
| PR8 | `cf388d693fc8ff5211912a987f593ff5df42c02b` | second candidate, unchanged |
| PR9 | `ff8f5b7fb53dc81ef5c0795182a0905d8266adfd` | third candidate, parent of this branch |
| Codex tip | `66b228d5ad899e6e34bf932643d2f10a283e2e67` | `desktop/macos-preview`, not merged |
| Codex exercised tree | `0bddbc5cd689a8d62bfbe6d6d3a82f42281f2c62` | parent of the Codex tip; docs-only difference |
| Old Codex root | `208038f5a24606c8834e7bdc1f352e81fa615c8e` | second parent of merge `66e99f86`; not merged wholesale |

The validation target is the fourth-candidate pull-request head after this handoff is pushed. Do not substitute `0bddbc5c` or `66b228d5`. Those SHAs do not contain PR8 or PR9.

## What was reconciled

Codex repairs were applied as patches from the commits below, then the four paths that both sides changed since PR4 were merged by hand. `desktop/macos-preview` was not merged.

| Origin | Decision |
|---|---|
| `d66f17ef` repair of connection admission, Foreman file permissions, share capture gates, Claude identity, Codex SDK error patch, catalog build fixes | Adopted, except the three overlap files below |
| `packages/contracts/src/desktop-tool-grants.ts` from `d66f17ef` | Adopted the `.js` import and the catalog-entry copy. Kept the PR9 MCP row, which already names `request_mcp_sign_in`, `mcp_login`, `mcp_login_complete`, and `mcp_status` |
| `packages/contracts/src/index.ts` from `d66f17ef` | Adopted exports of the existing share-memory and share-database modules. Did not drop PR9 exports |
| `DesktopConversation.tsx` from `d66f17ef` | Adopted `flushSync`, draft publication, and the inactive-tab editor guard. Kept PR9 chat recovery and attachment behavior |
| `66e99f86` import-refresh code (`34c9cf39` via the old root) | Adopted the import/share refresh callback, dialog wiring, and `DesktopApp.imports.test.tsx`. `DesktopApp.tsx` was edited in place so the FX camera boundary stays |
| `54202344` runtime symlink confinement | Adopted |
| `b0c02caf` launcher and test environment types | Adopted |
| `8407a1ff` attachment/voice workspace identity and `--publish never` | Adopted, with extra negative tests |
| `0bddbc5c` retained portable-archive review | Adopted. `reused: true` is accepted only when the review id, package key, and include flags still match |
| `ee40be71`, `66b228d5`, and the parity/tracker docs inside `66e99f86` | Rejected. They describe `desktop/macos-preview` or `0bddbc5c`, not this combined tree |
| Wholesale `208038f5` | Rejected |

## Preserved from PR9

Finish-seven mounts remain: team reads, download, vision with no model substitution, notify unknown-without-retry, table-view save/delete, FX camera, scheduler containment. PR5 optional connectivity stays unstarted. PR6 profiles stay unmounted. PR7 overview stays unmounted. Next-seven packets 1–5 stay mounted. Packet 6 stays fixtures only: `apps/desktop/src/main/index.mjs` does not import `validation-isolation`. Packet 7 stays an unexported evidence file. Share memories and database stay unavailable. Named selection stays 503 with `selectionContext={null}`. Foreman file grants still boot false and register tools only when the grant is exactly true.

## Workspace identity

`findDesktopAgent` already requires `workspace_id = 1` inside the open database. Attachment and voice checks were comparing that local row with the external runtime workspace id, so workspace 2 rejected its own coworkers. The check is now “the row is the local workspace 1 owner inside this database.” Callers still open `runtime.dataRoot`. A row stored as workspace 2 is rejected even when the runtime id is 2. An owner inserted only in another database is rejected. Those regressions are authored and UNRUN.

## Still closed

Device-code custody, native provider-off startup, duplicate-policy enforcement, overview identity, notify pending-row proof, custom provider / OpenCode / company HTTP activation, WhatsApp, live host, public share, webhook, and mobile pairing. A HOME override or the previous QA workspace is not isolation proof. The earlier native exercise used a real Codex login and does not authorize another one.
