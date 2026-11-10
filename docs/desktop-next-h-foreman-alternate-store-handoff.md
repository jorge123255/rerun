# H — Durable alternate repository; UI and engine dispatch remain GATED
Base/parent: aff68bebd97380edb3a70424bd2a7ff212affaab
Base tree: b0dd6e0c3c5c05405670f16aff31c66813f74673
Branch: desktop/next-h-foreman-alternate-store
Worktree: /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-h-foreman-alternate-store
Clean exact pin verified before edits. Final commit/tree supplied in delivery.

## Trace and exact missing reference
Original c33c020ffb33263ec29de6f76d9b269bca786d90 apps/ui/components/foreman/useForemanChat.ts regenerate delegates messageId to engineChat.regenerate. Original chat message actions call that saved-message path.
Mac coworker authority: apps/ui/lib/desktop/server/engine.ts reserves stable regeneration identity and accepts exact alternate x-session-id/x-run-id; store.ts retains alternate_session_id. apps/engine/src/http/routes/chat.ts regenerateChat uses getRegeneration for passive replay and forkReply for a new alternate. apps/engine/src/db/repos/regenerations.ts atomically records request, forked prefix, session and run, preserving the original.
Existing navigation pattern: DesktopConversation.tsx opens the returned alternate as a separate saved conversation/tab, transfers only its own draft admission, and retains original conversation. Use that pattern, not replacement of Foreman's current transcript.

Mounted Foreman history: server/foreman/binding.ts reads publicDesktopHistory(transformEngineMessages(...)) and returns recaps. lib/chat/engine-history.ts gives assistant rows engine-<raw-id> plus createdAt; it does NOT expose an immutable sourceRunId / precedingUserMessageId / transcript-revision binding. Feedback merely scopes a vote to chat + message string, and is NOT target proof.
Furthermore engine desktop/foreman/routes.ts isOwnedForemanSession and desktop/foreman/binding.ts current() explicitly reject originAgentId/originSessionId, which forkReply creates. UI database desktop_foreman_chats has one UNIQUE workspace_id. Calling the ordinary coworker fork endpoint and then resuming it as Foreman would violate these current identity checks.

Missing prerequisite: authoritative raw Foreman message -> completed source run -> preceding saved user message + owned source session + exact history revision/digest; a registered alternate session/run binding that Foreman tools/admission/Stop can validate without pretending it is the original singleton. No timestamp inference, parsed engine-* prefix, feedback row or renderer-supplied previous text substitutes for this proof.

## Delivered / scope
apps/ui/lib/desktop/server/foreman-alternates/repository.ts:
- additive FOREMAN_ALTERNATE_SQL fragment, scoped stable request fingerprint, durable reserved/uncertain/ready receipt;
- injected access and exact target proof; rejects missing/foreign/stale/noncompleted target, active turn/build and pending human decisions;
- one initial engine fork invocation per reserved request, subsequent explicit requests do passive exact lookup only; never automatic redispatch on uncertain/missing result;
- verifies returned session/run differ from originals. No source transcript, rating, recap, current conversation or existing table is modified.
handler.ts: unmounted authenticated bounded desktopRoute POST factory with runtime workspace guard.
repository.test.ts: offline SQLite source covers missing proof and blockers, lost acknowledgement, database reopen, exact recovery, conflicting IDs and foreign scope. UNRUN.

This is a repository/handler delivery, NOT a working Foreman engine fork. No engine dispatch adapter is supplied because the canonical reference and alternate authority above are absent. Optional engine port omitted => refuse before reservation. Root must keep checkForemanRegenerate.durableAlternate false and current UI gated.

## Root completion seam / acceptance
Apply FOREMAN_ALTERNATE_SQL in the central migration ladder only after ownership design is accepted. Bind target(tx,input) to raw canonical history and exact idle state under the shared Foreman turn/Stop/build/human-decision lock; access must recheck current workspace/grant. Proposed root route uses createForemanAlternateHandler(repositoryForRuntime), not ordinary chat send.
Only provide AlternateEngine after a Foreman-specific authenticated engine path can atomically validate target/blockers, fork with stable request ID, register alternate ownership BEFORE dispatch, preserve original and return exact receipt. lookup must remain read-only across restart. The ordinary forkReply code is the reference for prefix/receipt atomicity, not an adapter to mount unchanged.
For a ready, proven alternate, root offers a separate saved alternate tab/reader using the existing alternate-navigation pattern. Retain original selection, original feedback/recaps and drafts. Stop carries only alternate session/run; never use the original singleton's Stop. No automatic opening of a still-uncertain result.
Root must execute suites and board/cold-restart tests: original intact, distinct alternate readable/reopenable, one request across response loss/restart, foreign/stale targets denied, active turn/build/pending question/approval denied, Stop targets only alternate. Full engine path and native acceptance BLOCKED on the exact reference and binding prerequisite. No tests/builds/app/provider/account/installation/push/PR/permission changes.
