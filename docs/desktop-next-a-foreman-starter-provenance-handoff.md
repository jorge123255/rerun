# A — canonical starter producer: blocked, continuation remains gated

Branch: `desktop/next-a-foreman-starter-provenance`.
Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-a-foreman-starter-provenance`.
Base/parent: `89ec2070571c7d0d588e8e10d3e1a860681d05a5`.
Verified base tree: `487a0d7194a6dd0375c543e9b68f8136508d4bb8`.
Explicit dependency: draft PR #25. Remote `desktop/finish-cloud-base-20261106-8297fe64` was read with `git ls-remote` and remains PR #24 `d518abdbfd38985ab4c185950c22e36b1b90a269`.
The delivery commit/tree are reported externally because this file is part of that commit.

## Earlier lane preserved before edits

`next-a-bind-foreman-starter-widget`, branch `desktop/next-a-bind-foreman-starter-widget`, remains clean at `2d238b0f2f75dda7619a6653c56ea0c498c775c1`, tree `1502eb6b3c97aa530cf8317041e42661ce10463c`.
Its delta from PR #24 is exactly:

- `apps/ui/lib/desktop/server/foreman-starter/saved-widget-proof.test.ts`: +20/-0.
- `docs/desktop-next-a-bind-foreman-starter-widget-handoff.md`: +27/-0.

Both are in PR #25. The exact old-tip-versus-new-base difference in these paths is only the fixture database: old tip uses `:memory:`; PR #25 uses `mkdtemp` + file database and cleanup (+6/-2 when going from old to new). The handoff is identical. Retained the pinned PR #25 version; no carry-forward commit or cherry-pick.

## Original mounted path, exact reference

All original references below are at `c33c020ffb33263ec29de6f76d9b269bca786d90`:

- `apps/ui/components/foreman/ForemanColumn.tsx`: pending starter retains the composer and sends text to the pending widget callback.
- `apps/ui/components/foreman/useForemanChat.ts:236`: hub `answerWidget` guards tool-call duplicates and calls `addToolResult`; the engine branch instead sends an ordinary message. `dismissWidget` seals hub pending parts or stops the engine run. These are different backends, not a durable engine receipt protocol.
- `apps/ui/components/foreman/widgets/starter-pack/StarterPackWidget.tsx`: text/card verdict is reconstructed from saved output, with card selection kept until answered.
- `apps/ui/lib/foreman/scripted.ts:181`: `prepareScript` loads the pack; `runScript` at line 231 creates a tool-call ID and emits `tool-input-available` with no output. This is app-scripted, not a model tool execution inside an authenticated engine run.
- `apps/ui/app/api/chat/foreman/route.ts:112`: scripted `createUIMessageStream` assigns message IDs and its `onFinish` saves the transcript via `saveForemanConversation`.
- `apps/ui/lib/foreman/conversation.ts`: hub conversation persistence. Do not treat this hosted transcript write as proof that the Mac engine already committed an equivalent event.

## Mac authority and smallest commit seam

| Required field | Existing authoritative source | Missing connection |
| --- | --- | --- |
| Workspace, Foreman chat, engine session, admitted run | `apps/ui/lib/desktop/server/foreman/chat-store.ts`: `ownedForemanDispatch`, durable chat/turn rows; internal Foreman route authenticates engine launch and exact turn | Not attached to a saved starter event |
| Engine session/run/active Foreman | `apps/engine/src/desktop/foreman/binding.ts`: `current`, `ctx`, bridge binding; `routes.ts`: admission under agent lock and queued-turn receipt | No starter producer in `tools.ts` or bridge action |
| Message ID + exact widget/tool-call input | `apps/engine/src/runtime/loop.ts:335`: settlement receives `appendMessage` row, including assistant tool-call content; `db/repos/messages.ts` assigns the ID | No committed widget event links that output row to run/chat/grant; writes can fail and are caught |
| Tool-call ID/run/input | `runtime/loop.ts:171` `recordStepTelemetry`; `db/schema.ts` `tool_calls` | Telemetry has no saved message ID, workspace/chat or grant revision; missing result is recorded as error, so pending widget cannot require a successful tool result |
| Immutable digest/offered IDs | Could be computed from the exact bounded input persisted with a new event | Current template rail or renderer input is not an authenticated event |
| Current turn revision and grant revision | No starter-specific revision is captured in engine run context, chat turn wire or saved telemetry | `foremanBindingSchema` is workspace/chat/run/model; `RunContext` has no grant revision. `tool-grants.ts` reads current booleans, not a monotonic starter authorization revision. Plan/UI revisions and launch nonce are not substitutes |

The narrow prospective producer is a **successful saved-message commit during authenticated Foreman settlement**, paired with a starter offer emitted by that same admitted run. It must atomically save (or durably reconcile) an event containing `{workspaceId, chatId, sessionId, runId, turnRevision, messageId, toolCallId, widgetDigest, grantRevision, offered}`. Identity comes from the verified turn/engine context and returned saved row, never the renderer. A read must revalidate exact owned chat/session/run/current turn, current grant and Stop state under the same authority used for consume. Engine and app use separate databases; a callback alone is not an atomic cross-store commit. An engine outbox/reconciliation reference would have to survive loss of its acknowledgement.

**No production persistence/read API added:** the conditional prerequisite (all fields supplied by an existing authenticated run) is not met. Adding an API that accepts a caller's complete tuple would simply bless the same untrusted fields PR #25 rejects. H's completed-reply producer is separate and unchanged.

Smallest unblock: root supplies the authenticated engine starter-offer producer contract, including the authoritative turn/grant revision source and its revoke/Stop semantics. Decide explicitly which existing authorization governs displaying/answering this offer; do not manufacture a new grant or derive its revision from launch time, plan revision, file mtime, or a hash of current booleans (which loses revoke/regrant history). Then the settlement commit can persist its exact event and expose a read-only reference. This requires engine/root ownership of the shared settlement/admission seam.

## Authored regression source, unrun

New `apps/ui/lib/desktop/server/foreman-starter/unproven-producer-restart.test.ts` uses the actual PR #24 repository and disposable file SQLite storage. It refuses plausible unproven claims, variants of all saved identity fields, foreign workspace/chat before proof lookup, then closes/reopens storage after a simulated lost refusal response. Exact retry, conflicting cards and dismiss still produce no request/receipt. No network or continuation exists in this fixture.

This proves the intended negative boundary only when root runs it; it does not claim successful event persistence, a successful lost-response receipt or a mounted producer. Existing `repository.test.ts` authors positive consume-once receipt/reopen behavior with injected synthetic authority, not real producer proof. Existing engine `foreman/tools.test.ts` already enumerates tools and therefore documents the absent starter emitter; no duplicate tool-list test added.

## Migration order (separate)

No migration in this delivery. Root first defines the producer authority and event/outbox schema, then registers its migration in the existing engine/app ladders without changing historical numbering. Keep existing `FOREMAN_STARTER_SQL` tables/receipts intact. Event uniqueness must bind run/message/tool-call/revision, and exact replay must recover the same event after restart. Do not backfill legacy renderer parts as trusted events.

## Mount order (separate)

1. Persist authoritative offer event at successful engine save; passive exact event read/reconciliation after acknowledgement loss.
2. Bind PR #24 `StarterAuthority.access/pending` to that event and current authorization; `repository.publish` remains server-only. Compare digest/offered IDs and current revision, refuse foreign/stopped/superseded events.
3. Independently add exact tool-result continuation receipt/admission keyed by the existing `continuationRequestId`. Consume and dispatch must reconcile one intent; no retry may dispatch twice. Dismiss must not resume.
4. Only after 1–3, mount the existing starter handler and composer/card callbacks. Keep welcome intake and ordinary chat separate. Retain draft until exact unchanged-text receipt, Stop scope, card selection and restored recap. No changes to permissions/defaults in this packet.

## Root board-to-restart procedure

Current pinned build: board -> Foreman -> finish accepted welcome/intake. Confirm the existing template rail remains available, and restored starter-shaped history does not activate an answer/continuation. Restart and reopen; draft/recap/order and rail behavior remain unchanged, with no automatic tool execution.

After producer prerequisites: create a synthetic offer during one admitted owned turn; record exact event ID/tuple from passive engine read and compare saved message/tool call/digest. Drop the producer acknowledgement, cold restart, and reconcile the same ID with one event. Attempt foreign workspace/chat/session/run, changed message/tool call/digest/grant, superseded turn and revoked/stopped requests; all refuse without publication. Once continuation is separately integrated, choose text/card/dismiss, drop the response, restart and retry the exact request: recover one receipt and at most one continuation; conflicting choices refuse. Verify sibling draft, original recap and Stop remain scoped. This last scenario is gated, not accepted by source delivery.

No tests, typecheck, lint, builds, fixtures, app launches or Mac QA executed. Installed Next docs are absent; no Next API/code changes were made. No live accounts/providers, permissions, VM/profile/app changes, publication or main integration. Git identity/status/diff inspection only, plus local commit; hooks contain samples and no configured executable hook was found.
