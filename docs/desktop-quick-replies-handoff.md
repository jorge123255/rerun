# Desktop suggested replies integration

Suggested replies are integrated into the Mac coworker chat, saved history, and Edit coworker settings.

## Original design and saved history

- `DesktopQuickReplies.tsx` reuses the original `Suggestions`/`Suggestion` presentation and renders labels as text. `DesktopAssistantReply.tsx` places it after sources and before the copy/regenerate/feedback actions, matching Rerun.
- `lib/desktop/quick-replies.ts` uses the original validation and bridge-alias handling. Only validated labels or `{ replies }` leave its helpers.
- `publicDesktopHistory` in `lib/chat/engine-history.ts` explicitly projects the synthetic `suggest_replies` part, preserving validated labels without stored output or arbitrary transport metadata. The assistant renderer suppresses its generic tool row, including bridge aliases.

## Send admission and retries

`DesktopConversation.tsx` supplies `onSend(text): Promise<boolean>`. It returns `true` only after a successful HTTP response carries both `x-session-id` matching the selected saved chat and `x-run-id` matching the submitted `requestId`. This confirms turn admission, not reply completion. HTTP success alone is insufficient, and a fulfilled SDK `sendMessage` promise is insufficient because the SDK can swallow transport failures.

The handler requires a saved session and a verified history transcript. The clicked message must still be the current chat's final transcript message, be an assistant message, and contain the selected validated label. Its scope ref rejects callbacks retained from another tab or message. There is no suggestion-send path for a new, unsaved chat.

Pending or unknown questions/approvals, disabled coworkers, unavailable model selection, running/stopping replies, unread or occupied queues, and relevant errors block sends. The synchronous request ref also guards ordinary send, queue dispatch, regeneration, question answers, and approval decisions. After admission, ordinary text can be queued behind the running reply through the existing queue flow.

A repeated attempt for the same coworker, session, message, and label reuses its request UUID within the mounted conversation. The handler resets SDK messages to the verified `history.transcript` immediately before sending, removing any optimistic user row left by a failed transport before a fast retry. Failed or unconfirmed admission releases the suggestion latch; a retry remains available for that message while authoritative history refreshes.

The presenter latches only on explicit `true`. `false`, rejection, and synchronous throws release it. Message-scoped activation tokens prevent an old callback from clearing a newer activation, and a synchronous ref prevents duplicate clicks.

Only the chosen label is sent, with `agentId`, saved `sessionId`, and `requestId`. Existing composer text and the file draft are preserved; neither is included in the suggestion send.

## Coworker setting

Edit coworker exposes **Suggested replies**. Its `suggestedReplies` setting reads and patches the existing engine `config.tools.quickReplies` preference, preserving unrelated settings. The stale unavailable-tool catalog entry has been removed.

`suggest_replies` remains synthetic engine output, not a callable provider tool or a new permission grant. The original engine generation behavior and hosted callers remain unchanged.

## Validation status

Root ran all 38 focused suggested-reply cases successfully, covering validation, presenter behavior, guarded sends, receipt matching, retry identity, draft preservation, and the optimistic-row retry regression. Native Mac acceptance passed on installed build `313d204`: Codex read the renamed file as 42, saved suggestion buttons survived restart, Add eight produced one turn and a reply of 50, and the reply survived a second restart. The current text/file composer draft stayed intact and was not sent with the suggestion. The later C9 integration adds durable ordinary drafts per coworker/open chat tab, including selected file paths. It preserves this suggestion-send behavior and survives full Mac restarts; see the runtime contract and parity checklist.
