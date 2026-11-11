# Ask User Skip

Base: `dcf8dfae43e1887a31c4f16b833c84976896c6f8` (tree `7b1774d0bb1ce10d9f409fa91f7b1354c979ce80`).

Upstream source: `71a2952cc8f3d91d2f40c3e6d27b82e07bbd7f97` (`fix(harness): keep coworkers delivering instead of looping or waiting`, #77). The sentence ported from `apps/engine/src/agents/systemPrompt.ts` is: a question the user skipped is answered. Continue with one stated assumption, deliver, and do not ask it again unless they bring it up. Called-coworker brain text, setup/onboarding copy, and `calledBy` are unchanged.

## Mounted path

- Tool: `desktopQuestionTools` in `apps/engine/src/desktop/question-tool.ts` mounts `ask_user` only when `hasDesktopToolGrant(..., 'askUser')` is on. The hosted `tools.askUser` flag stays false and does not advertise the tool.
- Prompt: `buildSystemPrompt` now uses that same grant (and `enabled`) for the asking section and for `ask_user` in turn order. Foreman keeps its own `tools.askUser` mount in `apps/engine/src/desktop/foreman/binding.ts`.
- Card: `QuestionForm` Skip submits an empty answer list. `serializeAnswers` writes `[skipped]`. Dismiss is `HITL_CANCELLED.question` (`[User dismissed the questions without answering]`), not a skip.
- Persistence: `answerDesktopQuestion` writes `desktop_question_answers` (`payload`, `answer_text`, `accepted`) and sends that text as the user turn with the question guard on `desktopQueuedTurn`. `accepted = 1` hides the card. A lost acceptance is reconciled from the same row after the database is closed and reopened.
- Pending: no receipt, or `accepted = 0`, still returns the question.
- Revoked / rejected: an `ask_user` tool result that is an error is not a pending question, and a skip post is refused (409) with no receipt. A disabled coworker is refused (403) and the row is not accepted, so the question stays pending.
- Grant revoke stops a new `ask_user` call (`question-tool.test.ts`). It does not rewrite an already delivered card into a skip.

## Quick replies and computer

Quick replies mount on the desktop transcript (`DesktopQuickReplies`). The prompt now says a click sends text only, and to leave the block out when the message is waiting for a value only the user has. The mounted adapter still parks a value-announcing reply in the composer (`quickReplyDraft`) instead of sending it.

The computer sign-in sentence is included only when `request_takeover` is offered (`offersTakeover`: browser and `desktopAvailable`). Without that capability the sentence is absent.

## Codex QA

Board → open a coworker chat whose Tools grant includes Ask the user → send a message that draws an `ask_user` card → click Skip → confirm the card closes and the reply continues → Cmd+Q (Stay, then quit, if a draft dialog appears) → relaunch → the same chat does not show the skipped card again, and the transcript shows the skipped answers. A second chat with an unanswered card is still pending. Dismiss on that card is not the same as Skip.
