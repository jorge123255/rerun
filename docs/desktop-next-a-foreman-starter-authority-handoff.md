# A — Durable Foreman starter decision
Base/parent: aff68bebd97380edb3a70424bd2a7ff212affaab (PR #23 merge)
Base tree: b0dd6e0c3c5c05405670f16aff31c66813f74673
Branch: desktop/next-a-foreman-starter-authority
Worktree: /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-a-foreman-starter-authority
Clean exact pin verified before edits. Final commit/tree supplied in delivery.

## Source trace
Original c33c020ffb33263ec29de6f76d9b269bca786d90:
apps/ui/components/foreman/useForemanChat.ts answerWidget/addToolResult handles saved toolCallId, dedupes answered calls, dismiss seals without automatic resumption.
apps/ui/components/foreman/ForemanColumn.tsx routes text only when show_starter_pack is pending.
apps/ui/components/foreman/widgets/starter-pack/StarterPackWidget.tsx uses answered/custom, answered/chosen or dismissed output and restored verdict; original max picks is three.
Mac PR23 adapter: apps/ui/components/desktop/foreman/starter-pack/starter-answer.ts.
Mac canonical chats/turns: apps/ui/lib/desktop/server/foreman/chat-store.ts; engine saved tool and binding checks: apps/engine/src/desktop/foreman/binding.ts and routes.ts.

## Delivered
Additive files under apps/ui/lib/desktop/server/foreman-starter/:
- repository.ts — SQL fragment, trusted publication, pending read, consume-once shared text/cards/dismiss decision, exact receipt lookup.
- handler.ts — authenticated desktopRoute factory, bounded POST and passive GET, runtime workspace check. UNMOUNTED.
- repository.test.ts — offline SQLite fixture source. UNRUN.
No central migration, registry, tool or composer mounted.

A request ID is derived server-side from the exact workspace/chat/session/run/turn revision/saved message/tool call/grant revision/widget digest. Each identity has revision 1; changed source/grant/turn yields a new request that supersedes a still-pending predecessor. One pending request per chat, one receipt per request; decision and consumption commit in one write transaction. Same normalized text or set of selected offered cards recovers the identical receipt across reopen. Different choices, duplicate/unoffered cards, stale/superseded target and denied ownership/grant refuse. Dismiss has no continuation request ID. Receipt lookup requires current workspace/chat/grant access but need not revive the old pending turn. No continuation, install or model action is performed by this repository.

## Exact root migration/handler/composer seam
1. Apply FOREMAN_STARTER_SQL from repository.ts in root's existing numbered desktop database ladder; no lane-owned numbering and no new database. Export is a fragment, not an eager migration.
2. Construct createForemanStarterRepository(db, authority) for the authenticated runtime. authority.access(tx, scope) must verify canonical workspace/ownedForemanChat and current grant. authority.pending(tx, binding) must prove the raw saved show_starter_pack widget, its complete offered IDs/digest, exact engine session/current turn revision and grant revision. Reject Stop, changed turn, inactive workspace, welcome/ordinary chat and superseded saved widget. Use tx plus withForemanChatWrite/engine admission lock shared with all turn/Stop/grant mutations; a renderer UIMessage or in-memory boolean is not authority.
3. After the canonical engine widget is saved, publish its proven binding server-side. Never expose publish as a browser action. Current Mac tools do not yet publish this saved widget proof; this root/engine bridge is a required prerequisite.
4. Proposed root route apps/ui/app/api/desktop/foreman/starter/route.ts exports GET/POST from createForemanStarterHandler(async runtime => repositoryFor(runtime)). Factory already uses desktopRoute authentication and runtime workspace check. GET query workspaceId/chatId returns trusted pending; add requestId for passive receipt lookup. POST is StarterDecision {workspaceId,chatId,requestId,revision:'1',choice:{kind:'text',text}|{kind:'cards',chosen}|{kind:'dismiss'}}.
5. At DesktopForemanColumn.send, route only an exact trusted pending starter to this handler; use existing composer/draft. Map PR23 StarterAnswerPorts.receipt/answer to the returned text receipt: receiptId, ...receipt.request, answer:receipt.output. Do not treat a card/dismiss receipt as a text acknowledgement. Card and dismiss callbacks post the SAME request/revision to the SAME handler. Clear draft only after exact text receipt and unchanged scope/draft; no ordinary sendMessage fallback.
6. Apply receipt.output to that exact saved widget and its existing restored recap. For non-dismiss outcomes, continuationRequestId is a stable *intent*, NOT proof of dispatch. Root must bind a durable engine tool-result/continuation receipt using that ID and exact original widget, with at-most-once admission and passive recovery after uncertain acknowledgement. Do not translate it to ordinary chat, replay an uncertain effect, or install a template from this library. Dismiss must seal without resume.

## Regression source and remaining gates
Fixture covers consumption/conflicts across all three outcomes, offered-card checks, exact normalized card retry, scope/grant denial, stopped and superseded turns, and reopening the SQLite connection for receipt recovery. It uses a synthetic canonical proof callback. Root must run it and add/exercise real engine saved-widget proof, multi-client races and turn/Stop/grant mutation races under the shared lock; injected authority contracts are not evidence those mounts exist.
No tests/builds/typecheck/lint/formatters/native QA executed. No live services/accounts, push, PR, installation or permissions changed.
Activation remains gated on canonical saved-widget proof + root migration/route/composer + durable exact tool-result continuation. Root board/cold-restart QA: type/select/dismiss separate pending fixtures, race conflicting choices, recover identical receipt after restart, Stop/switch workspace/revoke grant during pending work, verify unchanged draft/old recaps and zero history-triggered actions. H's regenerate remains separate.
