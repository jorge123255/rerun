# Ask User Skip

Base: `dcf8dfae43e1887a31c4f16b833c84976896c6f8` (tree `7b1774d0bb1ce10d9f409fa91f7b1354c979ce80`).

Upstream source: `71a2952cc8f3d91d2f40c3e6d27b82e07bbd7f97` (`fix(harness): keep coworkers delivering instead of looping or waiting`, #77). The prompt treats an explicit Skip as an answer without a value or approval. The coworker continues any part that can proceed, states an assumption if needed, and explains remaining requirements. Called-coworker brain text, setup/onboarding copy, and `calledBy` are unchanged.

## Mounted path

- Tool: `desktopQuestionTools` in `apps/engine/src/desktop/question-tool.ts` mounts `ask_user` only when `hasDesktopToolGrant(..., 'askUser')` is on. The hosted `tools.askUser` flag stays false and does not advertise the tool.
- Prompt: `buildSystemPrompt` now uses that same grant (and `enabled`) for the asking section and for `ask_user` in turn order. Foreman keeps its existing prompt setting and separate tool binding.
- Card: `QuestionForm` Skip submits an empty answer list. `serializeAnswers` writes `[skipped]`. Dismiss is `HITL_CANCELLED.question` (`[User dismissed the questions without answering]`), not a skip.
- Persistence: `answerDesktopQuestion` writes `desktop_question_answers` (`payload`, `answer_text`, `accepted`) and sends that text as the user turn with the question guard on `desktopQueuedTurn`. `accepted = 1` hides the card. A lost acceptance is reconciled from the same row after the database is closed and reopened.
- Pending: no receipt, or `accepted = 0`, still returns the question.
- Revoked / rejected: an `ask_user` tool result that is an error is not a pending question, and a skip post is refused (409) with no receipt. A disabled coworker is refused (403) and the row is not accepted, so the question stays pending.
- Grant revoke stops a new `ask_user` call (`question-tool.test.ts`). It does not rewrite an already delivered card into a skip.

## Quick replies

Quick replies mount on the desktop transcript (`DesktopQuickReplies`). The prompt now says a click sends text only, and to leave the block out when the message is waiting for a value only the user has. The mounted adapter still parks a value-announcing reply in the composer (`quickReplyDraft`) instead of sending it.


## Codex QA

Board → open a coworker chat whose Tools grant includes Ask the user → send a message that draws an `ask_user` card → click Skip → confirm the card closes and the reply continues → Cmd+Q (Stay, then quit, if a draft dialog appears) → relaunch → the same chat does not show the skipped card again, and the transcript shows the skipped answers. A second chat with an unanswered card is still pending. Dismiss on that card is not the same as Skip.
