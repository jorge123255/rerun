# H — Exact saved Foreman reply/run binding: unavailable on PR24
Base/parent d518abdbfd38985ab4c185950c22e36b1b90a269; tree 94f7b0220733175e86c022befcd592752303be82.
Branch desktop/next-h-foreman-saved-reply-binding.
Worktree /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-h-foreman-saved-reply-binding.
Clean exact pin verified before edit. Documentation-only delivery; existing UI gate remains unchanged.

Original c33c020ffb33263ec29de6f76d9b269bca786d90 components/foreman/useForemanChat.ts regenerateEngine forwards messageId; MessageView delegates saved reply actions. Mac coworker path: server/engine.ts stable regeneration request -> engine http/routes/chat.ts regenerateChat -> db/repos/regenerations.ts getRegeneration/forkReply. The coworker fork atomically creates alternate session/run/receipt and copies prefix through the exact preceding user turn, preserving original rows. Its replay returns the same alternate.

PR24 Foreman source still lacks the required authoritative link:
- engine db/repos/messages.ts appendMessage persists id/session/role/content/sources/createdAt/author, but no immutable originating run ID or preceding-user reference on the saved reply.
- UI lib/chat/engine-history.ts transforms assistant messages into engine-<id>, metadata.createdAt; some tool/card rows fold into prior UI replies. The rendered ID and previous text cannot prove the exact original completed turn.
- UI server/foreman/chat-store.ts records request run binding and input text/brief, not its committed output message IDs.
- engine desktop/foreman/routes.ts isOwnedForemanSession and desktop/foreman/binding.ts current() reject sessions with originAgentId/originSessionId. forkReply deliberately creates those fields. Root desktop_foreman_chats remains one unique workspace chat/session.
- PR24 foreman-alternates repository requires target proof and engine ownership registration and remains unmounted. Feedback row and recap bodies are not proof, nor may timestamps or loose text matching be used.

Therefore no narrow authorized engine fork adapter can currently be bound. Existing checkForemanRegenerate.durableAlternate must remain false. No engine endpoint was invented, source eligibility relaxed, active run touched, original transcript/rating/recap changed, or A starter continuation modified. No duplicate implementation of the existing alternate store.

Smallest authoritative contract needed (server/engine persisted or authenticated read):
{workspaceId, chatId, engineSessionId, assistantMessageId, sourceRunId, precedingUserMessageId, completedTranscriptRevision, replyDigest}.
The producer must be canonical engine message/run commit, not renderer metadata. Source run completion and reply/user membership must be revalidated under the same turn/admission lock as fork, with current workspace/grant and no active original OR alternate run, build or pending human decision. The stable fork receipt must additionally register a distinct authorized alternate session/run before any Foreman tools can act, and echo the exact source tuple + requestId. Do not clear origin flags or pretend the alternate is the original singleton.

One smallest unblock action: root add and expose the canonical saved assistant-message -> completed source-run/preceding-user binding above. That enables the PR24 target port to stop returning null; alternate-owner registration remains the next explicit mount prerequisite.

Mount proposal after those contracts: migration for the existing alternate ledger; trusted target/access binding; authenticated Foreman-specific atomic engine fork/lookup; separate saved alternate reader/tab matching DesktopConversation's existing alternate navigation, retaining original selection/draft/feedback/recaps. Stop addresses only alternate session/run. Do not replace original transcript or reuse singleton Stop. A owns starter decisions and their continuation.

Root runs existing PR24 missing-proof/blocker/replay repository fixtures and adds immutable-reference membership/completion, active-turn/build/human-decision denial, foreign/stale target, request conflict/duplicate, restart receipt and alternate-scoped Stop tests once the producer exists. No new runnable regression was authored because no producer contract can yet be exercised without fabricating authority. All tests/builds/Mac QA remain UNRUN; no native/account/service/install/push/PR actions.
Board/restart acceptance remains blocked: original saved reply -> authorized distinct alternate -> preserve original and vote/recap -> restart/reopen exact alternate -> stable retry does not execute again -> Stop affects alternate only.
