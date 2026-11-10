# G — Atomic approved MCP sign-in method admission

## Coordination and preserved delta

This source explicitly depends on draft PR #25, not the remote finish branch.

- Verified base: `89ec2070571c7d0d588e8e10d3e1a860681d05a5`.
- Verified base tree: `487a0d7194a6dd0375c543e9b68f8136508d4bb8`.
- Branch: `desktop/next-g-mcp-method-admission`.
- New isolated worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-g-mcp-method-admission`.
- Branch/path were absent and checkout was clean before editing.
- Read-only `git ls-remote` confirmed `refs/heads/desktop/finish-cloud-base-20261106-8297fe64` remains `d518abdbfd38985ab4c185950c22e36b1b90a269` (merged PR #24). No remote update/fetch/push occurred.
- Source commit: `ba6a5c8c777fd64766cd86bef9842d166636095b`.
- Source parent: the exact PR #25 base above.
- Source tree: `6ebbdc094c90eb0b88921b0ad69f9cccded0039c`.
- Final delivery is the subsequent documentation commit, reported separately with its parent/tree.

Preserved earlier worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-g-mcp-device-approval`, branch `desktop/next-g-mcp-device-approval`, clean at `cb91709a69aa0a1cabce2baa2bc955cf057b245c`, tree `f130d3ab09eed7caa2d81ae50e8456489d1b66ea`, parent/source `983357492fcf01d8cd51ba927200e0870670b624`. Relative to its `7080add37a60bd604965649319143b8211818fd9` base, its complete package is 14 files, 1,081 insertions and 5 deletions. Before new edits, comparison of those production/UI/source paths with the PR #25 pin found only `mcp-device-approval/binding.test.ts` changed: 11 insertions/3 deletions replacing in-memory SQLite with a temporary file and cleanup. Every old production implementation path is already on the new pin. Nothing was copied, cherry-picked, reset or rebased from that older lane.

## Result and changed files

Added an unmounted encrypted SQLite selection contract, not a new sign-in system. It admits one method for an exact approved human request and one active method for the exact registration/credential generation. A separate durable reservation precedes any external start; a reservation that may have taken effect is never replayed.

1. `apps/ui/lib/desktop/server/mcp-method-admission/contract.ts` — strict private approval/request types, additive schema export, atomic `select`, single-use `reserve`, exact `retire`, trusted `retireOwner`, passive `inspect` and disposal.
2. `apps/ui/lib/desktop/server/mcp-method-admission/contract.test.ts` — authored offline SQLite/browser/device/generation/race/restart fixtures, unrun.
3. `apps/ui/lib/desktop/server/mcp/store.ts` — optional transaction reader for existing `credentialState`; default behavior unchanged.
4. `apps/ui/lib/desktop/server/mcp-sign-in/store.ts` — optional transaction reader for existing request/receipt reads and `readBySource`.
5. `apps/ui/lib/desktop/server/mcp-device-approval/store.ts` — optional transaction reader for encrypted review reads and `bySource`.
6. `docs/desktop-next-g-mcp-method-admission-handoff.md` — this handoff.

No screen, route, grant, default, registry, central migration, broker, refresh implementation or installed data changed. The three existing readers still use their canonical DB when the new argument is absent.

## Original and mounted trace

Original `rerun-build/rerun` dev `c33c020ffb33263ec29de6f76d9b269bca786d90`, tree `b1a34b46b40abeb1ffe8156a0c9fe0cb0ac3fd90`, was read from local Git:

- `apps/ui/components/chat/McpSignInBlock.tsx` exposes Connect/Cancel/Continue and mounts `McpOAuthAuthorize`; the user approves browser OAuth through that interaction.
- `apps/engine/src/tools/builtin/self.ts` exposes separate `mcp_login`/`mcp_login_complete`; `apps/engine/src/tools/mcp-auth.ts` discovers device metadata and performs the exchange. Discovery is not human approval and its original fixed client/scope/persistence is not imported as Mac authority.

The Mac uses `DesktopConversation` → existing `mcp-sign-in/DesktopMcpSignInBlock` → authenticated session route → `mcp-sign-in/binding.ts`/runtime/store for browser Connect. Device approval is the existing optional panel and `mcp-device-approval` review/decision receipt; custody uses `mcp-device-custody/binding.ts` and the original login backend contracts. These paths remain mounted or gated exactly as on PR #25.

PR #25's `mcp/credential-generation.ts` computes a private keyed generation from canonical registration identity/revision and exact sealed credential state. Its `advance` calls conditional `replaceOAuth`. Ordinary browser refresh continues through `mcp/oauth-loopback.ts` and the existing store/lifecycle. This package reuses those implementations. It changes no write or refresh logic, and does not reinterpret credential presence as human approval.

## Atomic contract

`approved(input, transaction, signal)` is a mandatory trusted server port. It must read the exact canonical human receipt and owner/session/source proof using the supplied transaction. It returns an immutable, private `ApprovedSignInMethod` plus a current checker/signal: workspace, local owner, engine coworker/session, immutable registration ID/revision/resource, canonical human request ID, exact approval/attempt ID, method, reviewed private credential generation and original expiry. No credential generation, target URL, permission, request ID or owner may be accepted as a model claim. The public-shaped input accepts only existing `source`, method and approval ID; those fields still require canonical proof.

`select` takes a SQLite write transaction, reads that proof, reads PR #25's actual credential state through the same transaction and recomputes/checks the private generation. It seals the full proposal and inserts it under both a per-request unique key and an active per-registration/generation unique index. Two windows/connections cannot select browser and device for the same request/generation. A competing distinct request for the same active registration/generation is also refused. A repeated exact selection returns its original random selection ID with `created:false`; changed payload, approval, owner or proof does not replace it.

`reserve` rereads the canonical proof and current generation under another write transaction, then changes `selected` to `reserved` once. Only its one `execute:true` response carries a short-lived lease for the bounded initial start. Root must use its signal/check, start at most once and dispose it afterward. Every subsequent reservation returns `execute:false`. A persisted `reserved` or `unknown` state is projected as unknown, including after restart or lost acknowledgement. This is not a connection result, permission to restart a broker, or a replacement for existing browser/device effect receipts.

`retire` verifies the exact internal owner/selection scope. An unreserved selection becomes retired; a reserved selection becomes unknown and retains its generation slot. Foreign-owner retirement cannot abort an issued lease. `retireOwner` is for the existing trusted revoke/disable/workspace-transition scope and aborts that owner's active leases before durable retirement. Expiry refuses selection/reservation and invalidates lease checks; passive inspection projects expiry without writes. Disposal stops local leases without replaying or deleting durable selections. No terminal row is silently reset or pruned; the ledger is bounded to 128 rows per coworker.

Full proof, source and generation are encrypted with existing secret crypto. Request/generation index keys are keyed digests and never enter public responses. Receipts contain only a random selection ID, method, bounded state and created flag. Failures are fixed text; no code logs raw proof, provider errors, credential-derived values or notification copy.

## Authoritative mount prerequisites

This is a contract and offline fixture; no production constructor call or schema registration was added.

1. **Human receipt/generation binding.** Root must provide `approved` for both methods through the existing authenticated human route and exact owner/source authority. Device reads must prove the real approved review/decision, full method snapshot, original expiry and private generation. Browser reads must prove the exact active Connect attempt and bind the generation reviewed/captured for that human action. The legacy browser request does not persist that private generation. Root must atomically capture it with the explicit Connect/selection event or add an immutable private receipt field; reading whatever generation happens to exist later is insufficient. The fixture's `fixture_browser_generation` table is explicitly synthetic, encrypted evidence for this port, not a production migration or an invented browser capability. It exercises actual browser request/attempt and device review/decision stores, while injecting synthetic current engine/source permission proof.
2. **One shared runtime and canonical readers.** Construct one contract instance inside the existing workspace/remote-MCP lifetime with its DB, secure key reader, canonical store and shutdown signal. Use the optional transaction readers added here to read browser/device receipts and credential state in the supplied transaction. Read-only proof callbacks must not open nested writes, start discovery, create an attempt or call a provider while holding this lock. Production permission/owner/session/launch transitions must supply their existing current checkers/signals. This contract does not replace them or create a distributed cancellation channel between processes.
3. **Additive migration.** Root allocates `desktopMcpMethodAdmissionSchema` in the app migration ladder, after reviewing dependencies. It is not initialized by construction/inspection. Root must run actual prior-schema migration coverage; the fixture authors missing/repeat-schema cases only.
4. **Both start seams, before any effects.** Route browser and device human selection through this same contract. Persist the returned selection ID with the canonical attempt, then require `reserve.execute === true` before the initial browser/device start. Do not put the guard only on one method or after metadata/authorization side effects. If an acknowledgement is lost, inspect/reconcile the same IDs; never start another method or create a new call ID to escape unknown state. For later callback/poll/credential commit, retain exact existing attempt authority and expiry, with PR #25's conditional generation advance for the approved exchange. A reservation lease covers the bounded initial start, not an entire human browser session or a generic permission to poll repeatedly. Ordinary established-credential refresh must retain its existing independent lifecycle and must not be routed through this one-time start gate.
5. **Stop/revoke/workspace transitions.** Feed exact authenticated selection scope into retirement and invoke trusted owner retirement before closing/finalizing the existing lifecycle transition. Continue exact browser cancellation and encrypted device cleanup through their current owners. An already-issued external effect remains unknown; retirement is not a claim that the provider reversed it. Root must define any later explicit retirement/reconciliation policy without clearing another method's generation slot.
6. **Broker still gated.** Canonical discovery must prove issuer/resource/client/scopes/endpoint binding and network confinement, including DNS/public-address, TLS, redirects, bounded responses and cancellation. The new contract proves selection at its database commit, not safe network discovery or external cancellation. It supplies no broker or provider capability. Production route/mount and model continuation stay unavailable until root reviews these exact adapters and lifecycle seams.

## Focused regression source, unrun

The fixture uses two real SQLite connections to one newly created temporary file, the actual browser request/attempt store, actual device review/decision store, real encryption and PR #25 generation/conditional credential writer. Only current engine/source authority and immutable browser generation receipt are synthetic; no provider network or login is used.

Authored cases: browser-first and device-first exclusivity; concurrent two-connection selection and reservation with exactly one external-start spy; exact selection reuse; reconstruction with unknown reservation and no replay; credential change before selection/reservation; losing late conditional credential write; selected versus reserved Stop; foreign retirement without lease invalidation; expiry, owner revoke and workspace shutdown; foreign/stale session/registration and injected sensitive fields; encrypted storage/redacted errors; absent/repeat migration; unchanged ordinary credential writes. Restoring the contract/SQLite connection is not a whole Mac cold restart claim.

## Repeatable root board-to-restart scenario

1. Review and integrate PR #25 plus this lane locally, then run all appropriate migration/source/type/fixture/browser/device/refresh checks. No checks were run here.
2. In disposable sandbox data, use only root-reviewed synthetic method metadata and a fake broker with counted start/poll/commit effects. Leave permissions/sensitive options off unless root explicitly enables the existing required permission for this fixture. Open one exact coworker/chat and human request from the board.
3. Open two views of the same request; explicitly select browser in one and device in the other. Both canonical authority snapshots must name the same registration/private generation. Admit one selection and one initial effect; the loser must create no provider/broker effect and cannot displace the winner. Reverse ordering in a fresh synthetic request.
4. Interrupt after the durable reservation, before observing an effect acknowledgement. Cold restart, reopen the same board/chat, and inspect/retry with original IDs. Unknown remains unknown; neither restored mount nor same/new tool-call IDs starts another effect or method.
5. For an unreserved selection, exercise expiry/Stop. For a reserved one, pause a fake response and revoke, edit registration, replace the credential or switch workspace. No late token may overwrite the current generation. Stop/transition leaves the appropriate retired/unknown receipt and unrelated owner/registration state untouched.
6. Confirm normal existing OAuth refresh still works under the original lifecycle, and that no private generation/token/metadata diagnostic entered model output, logs or public receipt. The original screen, route, permission defaults, profiles and installed app remain outside this lane's execution.

Only source/Git reads, authoring and normal local commits occurred. All regression execution, typecheck, builds, integration, app launch, Mac board/cold restart and physical acceptance belong to root. No live credentials/accounts, provider calls, install, VM/profile/permission changes, push, PR, merge or publication.
