# Round 34 B — webhook human requests (source handoff)

## Preparation and implementation plan

Prepared branch `desktop/round34-webhook-human-requests` and HEAD
`9c8a91e187642dbf103d65887bb589b5147c8305` verified clean before edits.
Only owned new trigger-requests paths and this document are changed.
Installed acceptance is root-owned; `40aa370` is not this feature's acceptance.

Design: keep one canonical ordinary-chat request authority. Add an immutable,
private webhook/event/run/request linkage journal, never an answer/credential
store or inbox authority. Reuse canonical forms and source-specific operations.
A stable continuation reservation is derived from the full trusted source.
Uncertain admission is reconciled by receipt-only reads, never webhook replay.
Missing authority fails closed, not a simulated success.

Implementation sequence (source-only; every execution check belongs to root):
1. Author regression sources for immutable identity, duplicate/lost ACK and isolation.
2. Implement shared view/decision envelope importing existing canonical types.
3. Implement bounded linkage journal and atomic follow-up reservation in injected DB.
4. Implement canonical source/decision/receipt adapters with exact run tool attribution.
5. Implement orchestration, restart reconciliation and explicit terminal handling.
6. Implement authenticated route adapter, projection metadata, client and existing-form slots.
7. Author UI/navigation/recovery regressions, root migration/routes/QA instructions.
8. Read own source/diff for scope, commit only owned files. Run no checks.

## Result and acceptance boundary

This is an **unexecuted owned-source package**, not installed acceptance of E9/C5/C6.
No tests, type checks, lint, builds, dependency installs, servers, providers,
Docker, app/native/restart QA, live data reads, credentials, publishing, push or
merge were executed. Read-only source/Git inspection and owned edits only.
Root directly integrates, executes and repairs findings; no repair task is
required from the user. No checklist count is changed.

The package cannot be enabled by supplying success stubs. Required root
functions are checked on construction and fail closed with a named missing
`MissingTriggerRequestAuthority`. In particular, **there is no safe standalone
MCP sign-in decision/admission authority in this base**. No OAuth flow, Skip,
credential write, new connection, grant or follow-up is fabricated for it.

## Original source/design mapping (all read at the original pin)

Pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

| Original | Meaning retained / local mapping |
|---|---|
| `apps/engine/src/runtime/trigger-runner.ts` | Each actual webhook delivery makes its own `source=trigger` session and headless run, and sends source attribution. Human replies do not fire it again. Local event ID is added by the already-present desktop trigger authority. |
| `apps/engine/src/http/routes/triggers.ts` | Token-only fire is separate from authenticated management; original returns engine run/session identifiers. Accepted desktop ingress deliberately returns only event admission metadata. New human endpoints remain authenticated and are never mounted on ingress. |
| `apps/ui/components/chat/AgentChat.tsx` | `findPendingHitl` belongs to the exact chat; answers/approval/secret/service/MCP/takeover summaries are one `sendMessage` user turn, not resumed webhook delivery. Original dismissal can Stop without an answer; Skip uses the original cancellation summary through canonical handlers. |
| `apps/ui/components/chat/QuestionForm.tsx` | Reuse `DesktopQuestionCard` and its shared `@rerun/ui/chat` question form, original ordering and inline cancellation. Existing desktop form does not add original question attachments; this package does not expand attachment authority. |
| `apps/ui/components/chat/ActionApprovalBlock.tsx` | Reuse `DesktopApprovalCard` and the original shared action block, `Approval required`, ordered decisions, `Not now` and decline notes. Generated prose cannot approve anything. |
| `apps/ui/components/chat/SecretRequestBlock.tsx` | Reuse desktop secret block; values go to the existing encrypted source-specific operation and only the canonical summary reaches chat. Original environment-variable storage is not copied. |
| `apps/ui/components/chat/McpSignInBlock.tsx` | Original `Sign in to`, `Not now`, `Connect`, `Continue`, `Cancel` require actual connector status/OAuth. Missing local pending-sign-in and decision authorities are shown unavailable, not replaced with the hosted component or a synthetic summary. |
| `apps/ui/components/chat/TakeoverAsk.tsx` | Existing `DesktopTakeoverCard` retains `Open browser`, `Open again`, `Skip`, `Done`; root supplies its existing exact lease operation for open/release. Mounting this component never acquires a lease. |
| `apps/ui/components/chat/TriggerPayloadBlock.tsx` | Reuse `DesktopTriggerPayloadBlock`: rounded-xl, 24-line auto-open rule, method badge, byte count, Copy, bounded payload scroller. Only an exact event/engine-session/slug payload envelope is accepted by the new wrapper. Normally leave the optional slot absent when the transcript already renders it. |
| `apps/ui/lib/chat-hitl.ts`, contracts `chat-hitl.ts`, original `inbox.service.ts` | Pending source and shared cancellation summaries stay canonical. Actions ID is the canonical request ID, not a second webhook inbox ID. Mark-read remains separate from deciding. |

Applicable root/UI `CLAUDE.md`, UI `AGENTS.md`, and
`docs/desktop-agent-assignment-standard.md` were read. No `bS.md` is tracked in
the prepared tree. The installed Next 16.2.6 guide
`node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
was read from root's coding tree because this worktree has no installed deps.
Server imports are `server-only`; hooks and interactive presentation are client
boundaries. No shared component, central mount, route or contract was edited.
The coding tree was read for adapter context only, particularly its new
`secret-requests/binding.ts`; it was not modified or used to copy live data.

## Canonical identities and contract (no second request schema)

`apps/ui/lib/desktop/trigger-requests/types.ts` imports existing question,
approval, takeover, desktop service and desktop secret schemas/types. The new
schemas are only linkage, observation and transport envelopes. They do not
replace `desktopQueuedTurn`, source request guards, forms or durable answer
records. No competing packages/contracts file is created. Root must add the existing secret contract's missing barrel export before compiling this package (fragment below).

Immutable link fields:
- root's persistent workspace identity (not listener origin or launch nonce);
- local coworker ID and exact engine coworker ID;
- delivery `eventId`, slug, local/engine session IDs and original trigger run ID;
- actual source run ID (original run or a receipt-proven human continuation);
- canonical request kind/ID, source message ID, tool call ID and fingerprint.

`triggerRequestKey` SHA-256 hashes the entire ordered identity tuple.
`continuationId` domain-separates a deterministic UUID-shaped canonical mutation
reservation; an existing canonical attempt is borrowed rather than replaced.
`stopRequestId` uses a separate domain. These are not engine delivery IDs.
`acceptedRunId` is the **actual canonical receipt's follow-up run**, never a guess.
Secrets retain the canonical store's separately generated immutable continuation
ID; the journal never tries to mint it or replace that store.

Question/approval/takeover fingerprints are the existing opaque sealed request
IDs; service/secret use the existing source fingerprint. Discovery checks the
actual tool log in the exact run (including tool name, owner/session/run and
non-error status), not a title/name match. Only original plus receipt-accepted
continuations are eligible. Ambiguous IDs or unlinked dashboard runs refuse.
A local copied coworker cannot inherit any original/canonical linkage.

The private journal stores identities, canonical mutation ID, a nonsecret
intent digest, phase/version and actual accepted run ID. **No answer text,
credential values, credential-value hashes, webhook bodies, tool arguments,
chat transcripts, tokens, source host paths or connection credentials** are
written there. For credentials only operation/revision/source metadata is
fingerprinted; the canonical encrypted store alone freezes values and attempts.
Replay probes transiently read the canonical saved nonsecret summary/text and
guard to call the existing `replayOnly` operation; those are not persisted or
returned by the journal. Do not log request bodies on these private routes.

### Exported modules (direct imports; root owns shared barrels)

Server `apps/ui/lib/desktop/server/trigger-requests/`:
- `identity.ts`: `triggerRequestKey`, `continuationId`, `stopRequestId`,
  `decisionDigest`, `bindDecision`.
- `journal.ts`: `TRIGGER_REQUEST_MIGRATION_SQL`, `createTriggerRequestJournal`,
  `TriggerRequestRecord`, `TriggerRequestJournal`.
- `canonical.ts`: `TriggerRequestRootBindings`, `MissingTriggerRequestAuthority`,
  `readCanonicalTriggerForm`, `invokeCanonicalTriggerDecision`,
  `readCanonicalTriggerReceipt`.
- `recovery.ts`: `probeCanonicalTriggerAdmission` (replay-only, never send).
- `lifecycle.ts`: `createTriggerRequestLifecycle`, `TriggerRequestPorts`,
  `TriggerRequestLifecycle` (`read/capture/reconcile/decide/stop`).
- `runtime.ts`: `createDesktopTriggerRequests`, `DesktopTriggerRequests`
  (`lifecycle/journal/discover/captureForSession/capturePending/reconcileEvent`).
- `intercept.ts`: `interceptCanonicalTriggerDecision`.
- `api.ts`: `createTriggerRequestsApi`, returning supported GET/POST functions.

Client `apps/ui/lib/desktop/trigger-requests/`:
- `types.ts`: exact link/view/decision/form schemas and types, canonical ID helper.
- `client.ts`: `createTriggerRequestsClient`, `TriggerRequestsClient`.
- `use-trigger-request.ts`: `useTriggerRequest`.
- `projection.ts`: `triggerRequestStatus`, `triggerRequestMetadata`,
  `decorateTriggerAttention`, `triggerResultTarget`, `sameTriggerResultOwner`,
  `projectTriggerEventOutcome`.

Presentation: `DesktopWebhookHumanRequest` and
`DesktopWebhookHumanRequestProps` in the new desktop component directory.

## Exact root integration and concrete missing authorities

### 1. Durable migration and startup

Root-owned `packages/contracts/src/index.ts` needs the existing canonical export:

```ts
export * from './desktop-secret-requests.js'
```

Do not clone the secret schema into a new contract. The prepared base exports
service/trigger contracts but not this existing secret contract. Preserve root's
already-integrated newer secret contract and its backward-compatible fields.
Root also owns the existing `apps/ui/lib/engine/client.ts` queued-turn typing: add
`service?: DesktopServiceRequestGuard` (and the integrated canonical secret guard
when binding secret recovery). The accepted engine route already parses service;
its pre-existing service adapter uses that runtime field.

Add **one new numbered central desktop DB migration** that executes the exported
`TRIGGER_REQUEST_MIGRATION_SQL` with root's normal migration transaction. It is
additive and re-runnable; do not edit an old shipped migration. The journal
constructor does not initialize schema on read. It uses root's injected Client,
not another database, file, global ownership registry or source store.

The table `desktop_trigger_request_links_v1` and index/immutable-source trigger
are defined completely in that constant. `phase` is one of `pending`,
`uncertain`, `accepted`, `superseded`, `stop-uncertain`, `stopped`. Versioned writes
and SQL predicates prevent a late result from replacing accepted/stopped data.
Do not cascade-delete lineage while a canonical admission/Stop is unresolved.
Deleted/replaced owners fail scope reads; root's deletion policy may prune only
closed metadata once all canonical receipts are safely retained/reconciled.

After normal engine interrupted-run reconciliation, reopen the existing DB with
the fresh runtime and construct `createDesktopTriggerRequests(runtime, db, root)`.
Enumerate only exact persisted webhook targets through root's durable event
store; call `reconcileEvent(target)` before `capturePending(target)`. This reads
receipts and `replayOnly` proofs. It never calls `fire`, sends a new user turn,
reacquires a takeover, repeats a secret write, or navigates. Listener origins and
launch nonce are validated freshly but are not part of stable linkage IDs.
GET reads do not create journal rows, reserve intents, admit replies or recover
by mutation. Existing canonical source-reader materialization remains owned by
those existing request services.

### 2. Required RootBindings (these are real dependencies, not supplied stubs)

`workspaceIdentity`: persist one opaque identity in root's existing workspace
metadata. Never derive it from origin, launch nonce, coworker name or install
path. Root DB ownership must agree with `runtime.dataRoot`.

`readDelivery(engineAgentId,eventId,signal)`: expose a **read-only authenticated
engine bridge operation** over the already-present
`DesktopTriggerStore.getEvent(engineAgentId,eventId)`, parse/project it through
`desktopTriggerDeliveryReceiptSchema`. Exclude `payloadPreview`, token and body.
The current management route has no exact event read operation; add its typed
allowlist/router bridge in root, not a token-only ingress route. Never use the
UI's current `projectDesktopTriggerHistory` to infer a resolved request: that
older resolver can turn missing/unsupported pending forms into `finished`.

`resolveSessionSource(sessionId,signal)`: verify local session/coworker binding,
then actual engine session source. Return `{kind:'ordinary'}` **only** for a
proven ordinary conversation. For a trigger session, resolve its exact durable
event/initial run and return `{kind:'trigger',target}`. Missing/unavailable event
mapping returns `{kind:'unavailable'}` and blocks fall-through. Add root's exact
engine event-by-session lookup; do not guess from a slug/title, choose the first
history page result, or silently classify a missing event as ordinary.

`withDecisionClaim(link,work)`: required root admission fence shared with
canonical human decisions, Stop, trigger deletion/disable, coworker replacement
and grant mutations. This package does **not** implement another claim authority.
A local Map alone is not sufficient unless root proves its single-process /
fresh-launch lifecycle and reconciles durable uncertain records before effects.
Do not hold a SQLite write transaction across a canonical handler that writes
the same DB; do not hold an engine agent mutex across an HTTP call that tries to
reacquire it. Root must recheck the immutable webhook source/current grant and
Stop tombstone **inside the engine's existing queued-turn admission lock**, or
fence every relevant mutation through its canonical coordinator. Current
question/approval/takeover guards bind the pending source but do not themselves
bind a deleted trigger or trigger grant. This TOCTOU admission fence is a
**concrete missing root authority**, not solved by preflight UI checks.

`assertCurrentRequestPermission(link,signal)`: revalidate current source run
terminal state, trigger existence and exact definition identity against the
event receipt, no deletion/replacement, enabled owner, current Triggers grant,
source-specific permission, setup gate, current model and actual registry /
service/credential authority. Do not promote any tool grant from webhook
payload or approval prose. `authorizeDesktopTriggers` is also called concretely.
Status 403 projects revoked, 404 deleted trigger, 409 replaced, otherwise
unavailable. The engine admission fence above must repeat decisive checks.

`stop(row,signal)` / `stopReceipt(row,signal)`: close the exact pending source
through root's existing Stop/cancellation authority with
`stopRequestId(row.link)`, persist its decision invalidation/receipt, and cancel
only the exact active run if any. Initial running trigger cancellation can reuse
`stopDesktopTriggerRun` / authenticated engine management `stop`; **that existing
function leaves a completed `needs-input` request pending**, so it alone is not
a completed implementation of this port. Follow-up runs are dashboard runs,
not new trigger deliveries; never stop them by refiring or slug lookup. Root
must supply durable source-request invalidation and receipt lookup, including
for a completed source. A lost Stop acknowledgement stays `stop-uncertain`;
reconciliation only reads the receipt and never repeats cancellation.

### 3. Existing source operations — exact adapter map

| Kind | Read | Actual decision/admission |
|---|---|---|
| question | `readDesktopQuestion(runtime,sessionId)` | `answerDesktopQuestion`, with existing source guard / saved answer / queued-turn receipt |
| approval | `readDesktopApproval` | `answerDesktopApproval`, ordered decisions and notes; no implied tool grants |
| takeover | `readDesktopTakeover` | `answerDesktopTakeover` only `done/skip`; `open/release` remain root's existing exact lease operations |
| service | `readDesktopServiceRequestView` | `desktopServiceRequestScope`, `desktopServiceRequestPorts`, `finishDesktopServiceRequest`; progress stays canonical and does not start a user turn |
| secret | inject root integration tree's `desktopSecretRequestPorts(runtime,sessionId).read/decide` | existing encrypted canonical secret authority and its `.recover` path; never substitute env writes or collect values in chat |
| sign-in | optional trusted `root.signIn.read` with exact source metadata | **missing standalone local authenticated sign-in decision and replay guard; unavailable** |

Root's integration tree has `secret-requests/binding.ts`; this base does not.
Bind `root.secret` after merging that actual authority. Its optional `probe`
must be a **read/replay-only** check of the canonical sealed receipt and exact
`desktopQueuedTurn.secret` fingerprint. Do not bind `.recover` to this probe if
that implementation can send an unadmitted turn. Before enabling credential
restart recovery, root must expose a read-only secret admission proof; otherwise
this package deliberately reports `unknown` and blocks contradictory actions.
A later explicit user retry remains a canonical source operation, not a replay
of credential writes or the webhook. No raw values are persisted by this package.

### 4. Canonical route interception — necessary for existing forms

Keep existing desktop auth, body limits, schemas and source-specific error /
retry handling. Add this **inside** the canonical authenticated route handler,
after parsing its canonical input and before calling the source decision:

```ts
const linked = await interceptCanonicalTriggerDecision(db, webhookRequests,
    sessionId, { kind: 'question', input })
if (linked) return linked
return answerDesktopQuestion(runtime, sessionId, input)
```

Use `kind:'approval'`, `kind:'service'` for Finish only, `kind:'secret'`, and
`kind:'takeover'` for terminal done/skip analogously. This returns null only for
proven ordinary-chat sources; ambiguous trigger sources refuse. It first
reconciles receipt lineage and captures the **actual** pending source, repairing
a missing notification/capture acknowledgement before deciding. Old callback
IDs cannot select a different source. Accepted exact retries return the already
admitted outcome; different intent stays rejected. No second user message is
created by an onAccepted callback.

For service Finish preserve the existing
`withDesktopServiceRequestAttempt`, `reserveDesktopServiceRetry`, refused
headers and client acknowledgement. Place interception where the old Finish
call is, inside those wrappers; progress is unchanged. The adapter supplies
`x-service-request-attempt-id` for the client's original transport ID while
retaining the canonical run ID. Bind underlying functions to the adapter, not
the HTTP wrapper, to avoid recursive interception. Preserve current secret
client transport-attempt headers/metadata through its canonical source adapter.
Route interception and the admission fence are mandatory even when root mounts
the new standalone presentation: the existing service/secret components call
their canonical endpoints directly.

New optional route mount (root-owned file only):
`apps/ui/app/api/desktop/sessions/[sessionId]/trigger-requests/route.ts`.
Create one `api = createTriggerRequestsApi(rootOpenFunction)` in a server binder.
The route file exports only `dynamic='force-dynamic'`, `GET` and `POST`, e.g.:

```ts
export async function GET(request: Request, context: {
    params: Promise<{ sessionId: string }>
}) { return api.GET(request, (await context.params).sessionId) }
export async function POST(request: Request, context: {
    params: Promise<{ sessionId: string }>
}) { return api.POST(request, (await context.params).sessionId) }
```

`api` is the root-bound server binder, not a fabricated missing import in a new
route file. The adapter authenticates with `desktopRoute`. GET takes a private
opaque link key and is read-only. POST supports only `decide`, `reconcile`,
`stop`; no public capture/publish/fire/retarget endpoint exists. Input is bounded
at 128 KiB. Browser reads are same-origin/no-store/redirect-error and bounded at
2 MiB; failures never reflect arbitrary server/provider error text. No response
or journal object is routed to an unauthenticated caller.

### 5. Capture, Actions, notifications, result navigation

After the trusted webhook run settles on an actual pending source, and after a
canonical follow-up settles, root calls `capturePending(exactTarget)` through its
internal signed callback/observer. Lost callbacks can be repaired on restart or
by explicit canonical route interception. Do not make a model tool or ingress
caller supply/approve this link; D retains trigger model-tool ownership.

`decorateTriggerAttention(existingCanonicalItem, view)` decorates only an exact
existing Actions/inbox row, with its existing request ID and kind. It does not
create or mark-read an inbox item. Bind `triggerRequestMetadata(link)` into the
existing notification metadata; current notification delivery settings, idempotent
attempt receipts, click signing and inbox read receipts remain root-owned.
Root must wire its already-integrated secret attention kind and a real sign-in
collector if one becomes available. Never widen kind enums with fabricated rows.
Apply stopped/superseded/accepted filtering consistently in root's canonical
chat/Actions projection, including historical reopen, rather than changing only
the wrapper's Stop button.

Use `projectTriggerEventOutcome` with the exact actual continuation run and a
confirmed complete pending-source scan. A source `done` with an unresolved
request remains `needs-input`; missing collectors/links remain `uncertain`.
An admitted follow-up says `Response sent`, not Done. Follow-up completion is
eligible for a Done notification only after matching the receipt-linked leaf
run and checking actual pending sources. Partial/broken/stopped execution stays
error/cancelled; no new Done/completion authority is added.

Mount `DesktopWebhookHumanRequest` in the exact existing webhook result tab,
not in the private composer or Board globally. Root supplies:
- `initial` from its authenticated view for the sealed link key;
- `active` only for the exact observed workspace/coworker/session/tab;
- `onAccepted(response,view)` that **adopts/reads the acknowledged stream/history**
  and never calls `sendMessage` or `fire` again;
- `onOpenResult(target)` that revalidates exact identities and opens the existing
  `trigger:<localSessionId>` tab through accepted adoption/navigation;
- `onOpenApps` from current Apps navigation; missing callback is truthful;
- `takeover.onAction` and optional screen from existing lease/viewer authority.

Do not remount the private conversation or replace its draft/camera when opening
a result. History mount, tab change and restart do not navigate or answer.
The hook aborts stale reads, fences delayed replies by generation and full source
identity, and cancels unadopted old response streams. All navigation remains
explicit click-driven. The wrapper does not own chat selection/drafts, voice,
board camera, browser lease, collectors or provider dispatch. Existing card
focus/accessibility and original spacing are reused; the wrapper adds status /
alert roles, wrapping rows and min-width protection, no new animation, dialog,
focus trap or global Escape handler. Root must check 375/768/desktop and short
700px layouts with its real composer and board mounting.

## Phase and recovery rules

- Capture freezes trusted source identity only, borrowing an existing canonical
  attempt ID if present; it never runs or answers a webhook.
- Before an explicit decision, reserve the nonsecret intent digest. The canonical
  source handler reserves its own answer/secret/service receipt and admits its
  own single queued user turn. No raw answer store is duplicated.
- Exact duplicate clicks serialize under root's claim and retain mutation identity.
- Unknown/connection-loss stays uncertain. Read-only replay probes use existing
  saved source text/guard and `replayOnly:true`; a missing queued turn is reserved,
  not sent. A known accepted canonical receipt promotes only the journal outcome.
- Proven absence of any canonical reservation can release only this unaccepted
  local digest, under the root claim. A staged secret is reserved, never absent.
  Absence is not inferred from timeout, HTTP error, disappeared UI or unknown DB.
- Resolved callbacks cannot answer a new request. Different intent is refused;
  an exact accepted retry only acknowledges the already-recorded result. When
  this journal learned acceptance externally, the canonical handler validates
  a user retry against its saved intent; it does not create another turn.
- Stop reserves `stop-uncertain` before root invalidation, blocks decisions and
  reconciles an exact durable receipt without repeating cancellation. Unknown
  Stop is not erased merely because the source turn was already complete.
- Capture/receipt reconciliation never deletes source data or replacement rows.
  Future schema migration is root-owned; incompatible/corrupt source records
  fail validation rather than being rebound by names.
- Bounds: 64 linked human requests per delivery, at most 65 eligible runs,
  15-second discovery budgets, current existing getRunTools API. That API lacks
  a cancellable signal parameter; its wait is deadline-fenced but root should
  add cancellation at the shared read transport if strict socket cancellation
  is required. No new dispatch occurs after the deadline.

## Authored regression SOURCES — ALL UNRUN

- `server/trigger-requests/lifecycle.test.ts`: exact identity, single canonical
  continuation, simultaneous clicks, cancellation/decline, missing permissions,
  changed source, lost admission/Stop ACK, restart, safe non-admission release,
  foreign acknowledgement rejection and no read effects.
- `server/trigger-requests/journal.test.ts`: additive migration, independent
  instances, immutable source, CAS reservation, workspace/copy/session isolation,
  accepted receipt protection and no accepted release.
- `server/trigger-requests/recovery.test.ts`: actual replayOnly shape and guard,
  queued receipt miss, foreign response/network unknown, missing secret probe,
  absence of credential-value fingerprinting.
- `server/trigger-requests/runtime.test.ts`: actual tool/run attribution,
  private/copy isolation, unlinked run rejection, changed launch/origin,
  unavailable source refusal and missing authority construction failure.
- `trigger-requests/projection.test.ts`: canonical Actions IDs, safe metadata,
  exact result tab, attention vs Done, uncertainty, actual leaf receipt topology,
  partial/error/cancelled follow-up outcomes.
- `trigger-requests/client.test.ts`: same-origin authenticated restore without
  fire, stale-key/chat rejection, sanitized failure and bounded reads.
- `components/desktop/trigger-requests/DesktopWebhookHumanRequest.test.tsx`:
  historical mount/tab switch without effects, exact navigation, stale delayed
  reply rejection and conflicting UI disabled while uncertain.

No red/green, type, lint, runtime, native or restart result is claimed. The test
fixtures only become active when root runs them; no fixture was executed here.

## Disposable root QA scenario — arithmetic only (not executed)

1. In a disposable root-owned test coworker/workspace, preserve an unsent private
   draft (`keep this draft`) and note selected tab and board camera. Use current
   local model/setup/grants. Create a local-only trigger `arithmetic-human` with
   instructions: "For this payload, ask one question about the arithmetic input.
   Wait for the explicit answer. Then compute the result. Do not call external
   tools, send messages, or ask for credentials." No services or credentials.
2. POST **once** to its actual local token URL with JSON `{"left":6,"right":7}`
   and a root-chosen stable `x-desktop-trigger-attempt`. Do not put credentials,
   chat state, response details or source linkage in the body.
3. Verify the public response is only the existing event/accepted/replay envelope,
   never a session/run transcript, interactive answer, token or workspace state.
   Record the private trusted event/session/source-run/tool/request IDs separately.
4. Verify the exact result chat shows the original payload block and real question,
   Actions uses the same canonical request ID, and notification metadata identifies
   source=trigger. The run may be done while attention remains; no Done tile yet.
5. Answer `42` explicitly; inject a lost UI ACK after canonical queued admission.
   Duplicate-click/retry and then fully restart. Root's receipt-only reconciliation
   must find the same follow-up run and exactly one new user turn. The trigger
   event count must remain one, not a new webhook delivery.
6. Verify only the observed result tab adopts the live reply. Open its historical
   result and switch tabs/workspaces during a delayed reply; there must be no
   navigation effect or lost private draft/camera. The original chat is unchanged.
7. In fresh disposable deliveries, exercise question Cancel, approval Not now /
   decline, service Skip, secret Skip through canonical source forms, takeover
   Skip through the existing lease authority, and Stop with lost ACK. Never use
   real secrets or acquire input without explicit root QA consent. Deleted trigger,
   disabled owner, changed source or revoked grant must block stale callbacks.
   Standalone MCP sign-in remains unavailable until its missing authority exists.
8. Verify partial/failed/cancelled follow-up is not Done. A completed leaf with
   a complete source scan and no pending request may notify completion once.
   Clean up only the exact disposable resources through root's normal deletion UI.

## Implemented / dependent / unsupported matrix

| Area | Owned source implemented | Root dependency / limitation |
|---|---|---|
| Existing canonical requests | Concrete question/approval/service/takeover reads and operations; secret typed binding | Root routes/grants/admission fence and new secret binding integration required |
| Durable linkage | Immutable identity, SQL migration fragment, reservations, CAS, metadata only | Root numbered migration and persistent workspace ID |
| Exact source attribution | Actual run/tool logs; initial + acknowledged continuation lineage | Exact read-only engine event and event-by-session bridges missing |
| Human continuation | Stable request identity and actual receipt run; explicit source handler only | Existing provider/model/source handlers remain authoritative; no direct webhook dispatch |
| Duplicate/lost ACK/restart | Receipt-only canonical probes, uncertainty, non-admission release, Stop tombstone | Shared admission/invalidation gate; secret read-only proof; root startup wiring |
| Actions/notifications | Decorates canonical rows, safe attribution, truthful outcome/completion gating | Existing root inbox/notification authorities and kind collectors; no duplicate store |
| Presentation/navigation | Original card/payload reuse, guarded stream adoption, exact tab target | Root mount, Apps/lease navigation, drafts and camera retention; Mac layout QA unrun |
| Stop / revoked / deleted source | Blocks through linked lifecycle and root preflight ports | Durable canonical invalidation + engine-lock admission fence are concrete missing authorities |
| MCP sign-in | Optional trusted pending metadata; honest unavailable card | No standalone local canonical sign-in decision/replay contract in this base; unsupported until root implements it |
| Question attachments | Existing desktop behavior retained | Original attachment-rich question form is not expanded here |
| Hosted/remote caller interaction | No publishing, new hosting or interactive caller output | Unauthenticated caller never receives human decisions; intentionally unsupported |

The entire original webhook human-request surface is **not claimed complete**:
exact lookup/admission/invalidation seams and standalone MCP sign-in are named
above. Root determines E9/C5/C6 installed acceptance after integrating and testing
these dependencies, including full restart. Prior round33
`e7203d3e5878823edbe2fa52b02cbba31064f22b` is review context, not acceptance.
