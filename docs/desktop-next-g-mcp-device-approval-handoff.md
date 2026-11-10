# G — Human approval for an exact MCP device method

## Result

Added local trusted review, encrypted decision/retirement receipts and a current approval lease for the already-supported `device-code-link-v1` shape. The explicit human action approves the persisted method snapshot; browser Connect cannot supply this decision. The renderer submits review ID, immutable review revision, decision ID and operation only. It cannot submit or alter issuer, client, scope, endpoints, registration or credential generation.

The existing sign-in card has an optional method-review panel. It shows the exact non-secret resource, issuer, client, requested scopes, device/token endpoints, verification page and registration revision. It distinguishes method approval from a verified connection. The card's ordinary browser behavior remains the default when the optional prop is absent. No production caller supplies it on this base.

Production activation remains gated for root's exact broker-adapter and integration review. No central route, service registry, migration ladder, engine contract/tool or live provider was mounted or changed. D/E/F files are outside this source package.

## Exact checkout and commits

- Fork: `jorge123255/rerun`, existing local Git objects only.
- Branch: `desktop/next-g-mcp-device-approval`.
- Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-g-mcp-device-approval`.
- Retained finish base: `7080add37a60bd604965649319143b8211818fd9`.
- Verified base tree: `e7db3a3f5df8057ffe86576153a8acff3360481b`.
- Branch and path were absent before creation; the new worktree was clean at that exact pin before edits.
- Source commit: `983357492fcf01d8cd51ba927200e0870670b624`.
- Source parent: `7080add37a60bd604965649319143b8211818fd9`.
- Source tree: `4218025ac1b65844a774598606655d21d770ca07`.
- Final delivery is the subsequent handoff commit; final SHA, parent and tree are reported from Git.

Older custody, broker-fixture, Foreman and all other worktrees are preserved. Normal local Git hooks only; the configured hook directory contained sample hooks and no checks were triggered. No hook bypass.

## Changed files

1. `apps/ui/lib/desktop/mcp-device-review.ts` — human-only projection and identity-only decision types.
2. `apps/ui/lib/desktop/server/mcp-device-approval/model.ts` — strict decision/candidate/receipt schemas and bounded review policy.
3. `apps/ui/lib/desktop/server/mcp-device-approval/store.ts` — additive schema export, encrypted review/receipt storage, source identity, bounded reads and optimistic updates.
4. `apps/ui/lib/desktop/server/mcp-device-approval/service.ts` — review, explicit decision, approval lease, Stop, trusted owner revoke and disposal.
5. `apps/ui/lib/desktop/server/mcp-device-approval/binding.ts` — canonical human source/owner/registration adapter plus required trusted metadata/generation port.
6. `apps/ui/lib/desktop/server/mcp-device-approval/api.ts` — authenticated human-handler factory, bounded strict requests and fixed errors; unmounted.
7. `apps/ui/lib/desktop/server/mcp-device-approval/service.test.ts` — offline SQLite, synthetic method/credential-generation and fake-broker custody cases; unrun.
8. `apps/ui/lib/desktop/server/mcp-device-approval/binding.test.ts` — canonical source adapter and immutable registration boundary cases; unrun.
9. `apps/ui/lib/desktop/server/mcp-device-approval/api.test.ts` — human authentication ordering, strict payload/session refusal and exact decision forwarding; unrun.
10. `apps/ui/lib/desktop/server/mcp-sign-in/binding.ts` — reuse existing approval authority through `deviceMethodAuthority`, including historical exact-source checks for later device use with current permission/registration admission.
11. `apps/ui/components/desktop/mcp-sign-in/DesktopMcpDeviceMethodReview.tsx` — optional human review/receipt UI with stable decision IDs, scope checks, expiry, cancellation and late-response rejection.
12. `apps/ui/components/desktop/mcp-sign-in/DesktopMcpDeviceMethodReview.test.tsx` — explicit-click, double-click, lost acknowledgement, changed owner and expired/inactive cases; unrun.
13. `apps/ui/components/desktop/mcp-sign-in/DesktopMcpSignInBlock.tsx` — optional child seam in the existing card; no mounted caller change.
14. `docs/desktop-next-g-mcp-device-approval-handoff.md` — this handoff.

## Original design and mounted comparison

Original reference retained from the preceding lane instruction: `rerun-build/rerun` dev `c33c020ffb33263ec29de6f76d9b269bca786d90`, inspected from local Git. Its `apps/engine/src/tools/mcp-auth.ts` discovers protected-resource metadata and device hints, then uses fixed client/scope values to start/poll. Discovery supplies metadata, not human authorization. `apps/engine/src/tools/builtin/self.ts` exposes the device login/complete/status tools; `apps/engine/src/tools/builtin/hitl.ts` exposes the separate sign-in request. `apps/ui/components/chat/McpSignInBlock.tsx` mounts browser Connect/Continue through `McpOAuthAuthorize`.

The mounted Mac path is `DesktopConversation` → `mcp-sign-in/DesktopMcpSignInBlock` → the existing authenticated session sign-in route → `mcp-sign-in/binding.ts` and its runtime/store. Its strict `desktopMcpSignInDecisionSchema` in `packages/contracts/src/desktop-mcp-sign-in.ts` records browser Connect/decline/cancel, with source and attempt checks. It does not review a device method. That schema and existing browser operations remain unchanged.

The delivered `mcp-device-custody/{model,store,custody,binding}.ts` already handles the supported method, encrypted pending code, exact approval rechecks, request reservations, expiry, unknown outcomes and canonical credential installation. This package reuses that authority shape and encryption; it does not duplicate the broker, token exchange or connection pool. The `mcp-login-binding.ts` → `apps/engine/src/desktop/mcp-login-tools/route.ts` production path still supplies no device fallback. The existing custody schema is already registered as version 37; do not register it again.

## Review and receipt semantics

- Only `device-code-link-v1` is admitted, using the existing strict method parser. Client-secret methods, extra credential/code/token members, query-bearing verification URLs and unsupported shapes fail closed. Validated metadata and current credential generation enter exclusively through a required server port.
- A proposal is immutable per exact existing human sign-in source. It carries local workspace/coworker/session, mapped engine coworker/session, immutable registration ID/revision, resource URL, issuer, endpoints, client, scope, generation and expiry. The public review revision and approval IDs are random UUIDs, not credential fingerprints.
- Review expires after at most five minutes. Approval lasts at most thirty minutes from proposal creation and is additionally bounded by the trusted candidate's validity. These are local conservative limits, not a new provider capability.
- Approve/decline are durable decisions with exact request IDs. Same-decision recovery reads the original decision; a different decision or stale revision cannot replace it. Declined, retired, expired, damaged or changed proposals do not silently become fresh approvals.
- `approvedMethod` finds exactly one matching approved receipt, rereads canonical source/registration/method/generation, compares the full reviewed authority, then returns the existing `DeviceApprovalLease`. It binds engine session as well as local chat; the existing custody/backend still independently authorizes the current active run. An unrelated new run or model claim cannot act as a human decision.
- The returned lease combines request, shutdown, trusted authority/generation and review-retirement signals. Its checker verifies current authority and deadlines. A timer aborts issued leases at expiry. Stop blocks local admission immediately and records retirement before acknowledging cleanup. Never-approved proposals do not touch device custody. The canonical adapter checks the entire saved approval before calling `custody.stop`, so a different approval sharing the registration/generation slot is preserved. Trusted owner revoke does the same for that owner's saved reviews. Cleanup can be retried without replaying broker effects.
- Store writes compare encrypted record versions; retirement rereads on bounded conflicts rather than overwriting a concurrent decision. A post-write authority failure conservatively retires the decision. Unknown storage acknowledgements are surfaced as unconfirmed; no effect is automatically started.
- Review and approval never start/poll a broker, install a token, probe tools or send a model continuation. Saved method approval is not connected status. The fixture's eventual connection uses the existing custody/backend and canonical successful probe.

All full review/decision records are encrypted with existing `createDesktopSecretCrypto`, including source and private credential generation. Public human views omit credential generation, approval ID and private record contents. Model status/results retain the original custody/login contracts. No code logs metadata, provider errors, codes or token values; handler/service failures are fixed text. Human review responses must not be forwarded into model messages or telemetry.

## Exact root integration seam

Root must review and bind one instance per existing remote-MCP runtime, not per HTTP request. Inside the existing service lifetime, the relationship is:

```ts
let custody: ReturnType<typeof bindApprovedMcpDeviceCustody>
const review = bindTrustedMcpDeviceMethodReview({
    runtime, db, key: masterKey, store,
    shutdown: entry.shutdown.signal,
    method: reviewedBrokerAdapter.method,
    stopCustody: approval => custody.stop(approval),
})
custody = bindApprovedMcpDeviceCustody({
    db, key: masterKey, workspaceId: String(runtime.workspaceId),
    service, watchOwner,
    approvedMethod: review.approvedMethod,
    broker: reviewedBrokerAdapter.broker,
})
```

`service`/`watchOwner` above mean the already-existing canonical service and owner watcher, not a second runtime. This is a binding relationship, not a ready-to-apply central patch. Construct both before publishing the service and do not expose review operations while `custody` is unassigned. Pass the existing same service lifetime's fallback into the root-owned authenticated login backend only after approval of the exact adapter. Preserve its current engine authentication, grant checks, final identity guards and fixed errors.

Register `desktopMcpDeviceReviewSchema` as a new additive app migration, with root-owned previous-schema/migration tests. This lane exports the schema but does not allocate a migration number or initialize it from a read. Missing storage fails closed. The authored fixture includes missing-schema and repeat-schema source cases; they do not substitute for the actual migration ladder test. Review rows are bounded to 128 per coworker. No deletion/retention policy is invented to make room.

The human handler is `createDesktopMcpDeviceReviewApi(resolveExistingRuntimeReview)`. It always uses `authenticateDesktopRequest`, including app cookie, origin and workspace admission; it does not accept engine bearer authentication as a human decision. Root can dispatch its two distinct actions from the existing authenticated session route after normal session matching:

- `review-device-method` with the existing exact `source`.
- `decide-device-method` with that source and `{ reviewId, revision, decisionId, operation }`.

The only operations are `approve-device-method`, `decline-device-method` and `stop-device-method`. The original browser action parser remains strict and refuses them. No route currently dispatches these actions. A human-only renderer adapter supplies the resulting review plus `onDecide` through the existing card's optional `deviceMethodReview` prop. No model tool or generic approval dialog is added.

## Missing activation prerequisites and product choices

1. **Exact broker and current credential generation.** `CanonicalDeviceMethodReviewBinding.method` is mandatory and has no default. It must return the current immutable registration ID, reviewed method, opaque canonical credential generation, validity deadline, current checker and revocation signal. The base remote store has no durable public generation getter. Root must bind a real canonical monotonic generation source and its invalidation hooks, not a static string, a UUID generated per read, discovered metadata alone or renderer fields. An authorized write from this exact device exchange must have defined generation semantics; unrelated credential replacement, browser sign-in or revoke must invalidate the old lease. The fixture uses an independent synthetic generation and does not claim production generation integration.
2. **Network confinement.** Root's exact broker adapter must validate the resource/issuer/endpoint relationship, public-address/TLS policy, redirects, size/time bounds, cancellation and response shapes. The existing method schema is not a DNS/network sandbox. No real broker/network implementation is added here.
3. **Atomic method selection across windows.** The optional card suppresses a new browser Connect while the device review is selected, disables device approval during existing browser work, and canonical device admission refuses a source already owned by a browser attempt/receipt. Before mounting both routes, root must make the browser/device choice atomic across windows and bind cancellation/continuation policy to that exact source. The base browser attempt writer has no reciprocal device-review transaction; a separate UI check cannot close that race. Do not activate based on the UI alone.
4. **Lifecycle hooks.** Wire exact device Stop plus `review.revokeOwner(owner)` before credential revoke/replacement, coworker disable/delete and applicable session Stop/permission transitions; registration and generation watchers must invalidate active leases too. Dispose the review on the existing shutdown lifetime. Existing browser `oauth.cancel` is not device retirement. Root must define how an approved method resumes the original human card without falsely creating its browser `connected` receipt. This package sends no continuation automatically.
5. **Ambiguous effects and new attempts.** Multiple live approved receipts matching the same target are refused rather than selecting one. Existing unknown custody is never reset by a new method receipt or a new call ID. Root must define explicit reconciliation/retirement before another attempt; no hidden retry or slot reset is supplied.

## Authored regressions — all unrun

- `service.test.ts`: separate human approval before fake broker admission; exact issuer/client/scopes and all method fields; encrypted records and private-output exclusion; current source/registration/credential generation; receipt recovery; foreign identity; strict stale/model/browser-Connect refusal; review and lease expiry including timer signal; Stop across recreation; revoked delayed token; unknown custody no replay; declined/damaged receipts; missing/additive schema.
- `binding.test.ts`: existing canonical source adapter called for the local human session; exact immutable registration passed to trusted discovery; source/permission and revision failures precede discovery; foreign registration metadata refused; Stop preserves a different approval in the same registration/generation slot.
- `api.test.ts`: authenticate before resolver; foreign session, browser action and injected method/token members refused; identity-only decision forwarding and no-store/fixed errors.
- `DesktopMcpDeviceMethodReview.test.tsx`: exact review contents, no mount-time approval, double-click latch, stable request ID after lost acknowledgement, late foreign reply rejection and expired/inactive controls.

Fixtures use only synthetic HTTPS `.example` metadata, fixture key bytes, SQLite databases and injected inert/fake authority/broker functions. No fixture was executed by this lane. Earlier broker/custody tests are not cherry-picked onto this base; root should retain and run those already-delivered suites alongside these sources.

## Root board/restart procedure

1. Run all appropriate source, type, binding, route, custody, migration and client regression checks. Independently review the exact broker/generation/selection adapter and central mounts before any activation. Keep the production fallback unavailable until these gates pass.
2. Mount a root-controlled fake adapter on disposable data. From the board open the exact coworker/session and its current MCP request; explicitly review the supported method. Check issuer, client, scopes, endpoints and registration revision at narrow/mobile, tablet, desktop and short viewport sizes. Approval must require its own click and must not report connected or invoke a broker.
3. Reload/cold restart with a saved proposal and with an approved receipt. Source, owner, method, registration and generation must be revalidated. No restore/read may start or poll. Original browser Connect behavior must remain unchanged when no device panel is supplied.
4. Explicitly start/complete one current approved fixture attempt through the existing backend. Inspect model status, transcript and logs for synthetic private sentinels. Only the canonical successful probe may publish tools; all pending/token bytes and generation remain private/encrypted.
5. Pause start/poll/credential admission and exercise device Stop, owner/session Stop, revoke, expiry, credential replacement, registration edit/delete and workspace/chat change. Resolve late fixture responses; no credential or tools may be published. Repeat after cold restart and with both original and new call IDs. Unknown must remain unknown.
6. Race two windows choosing browser versus device. Root's atomic choice must admit exactly one method. Confirm cleanup failures remain unconfirmed and retry only exact cleanup, never an external authorization/token effect.

## Execution boundary

Only source/Git inspection, authoring and normal local commits were performed. No tests, fixtures, typecheck, lint, builds, app launches, native board testing, cold restart, live services/accounts/credentials, provider changes, OS/Focus/permission changes, installs, VM/profile changes, push, PR, merge or publication. Root owns execution and acceptance. No installed approval/login success is claimed.
