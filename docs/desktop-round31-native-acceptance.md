# Round31 Mac acceptance

Accepted installed source: `40aa370b235e088fc3d603ecc174fc0f3d8d3ec8`, November 5, 2026. Original Rerun reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. App: `/Users/gszulc/Applications/Rerun Desktop Preview.app`.

## Accepted behavior

- From the board, a selected coworker mention and separately permitted call returned `CALL31C: CHILD31C: 42.`. The original call card opened the exact child conversation. A second live call was stopped without retry; its partial output and stopped status survived restart.
- Five delegated tasks used four concurrent isolated workers. The final test stopped one queued task and one running task; the other three finished with `ANSWER: 42`. The original panel showed `3 done · 2 stopped`. The final restart preserved every task outcome and immutable Stop receipt. Across four QA delegations, all 18 allocated private resources were retired; the stopped queued task did not allocate a worker.
- Original browser navigation options, links, screenshot and inert rendered-page exports worked with example.com. The live ScreenCard appeared only for the current active run. Takeover opened the isolated browser and Done resumed it. Three saved exports survived restart.
- Installing the public Nuxt app created its connector-owned usage skill. Its read-only presentation survived restart, and Codex read it and used the connected Nuxt documentation tools. Uninstall removed only that owned skill; the existing user skill remained.
- Original local Triggers settings and Control Center navigation worked. One POST arithmetic event returned `TRIGGER31: 42`; its payload and saved chat were visible. Duplicate delivery returned the same event without a second run. Passive preview, invalid secret and wrong-method checks passed. The trigger was then disabled; delivery refused before and after restart while history remained.
- After reopening the final signed build, a fresh board chat returned `RESTART31: 43`. Call and delegation cards reopened correctly. Closing chat retained the exact board state. A subsequent full quit completed without a draft warning; the final saved-state comparison passed.

## Root corrections and checks

Root repaired fresh engine packaging, exact Codex tool-call identity, cancellation deadlines, stable per-task Stop tokens, queued-task cleanup, stopped-state headlines, human trigger management independent of the model tool permission, and newly adopted background-chat navigation. The navigation fix retains existing tab/draft instances while refreshing the owner-scoped session list. Its regression failed on the old source and passed after the fix.

Root ran all execution checks. Relevant final logs include 68 engine cases for Stop/trigger integration, 132 UI cases, 40 engine queued-cleanup cases, 83 UI headline cases and the final 27 navigation/tab/creation/notification cases. These overlap and must not be summed. Engine/UI type checks, changed-file lint, strict signed packaging and installation passed for their recorded source versions. The final navigation-only change passed UI type checking and all 27 affected tests. Earlier exact-call SDK/provider and guest checks are recorded in the Round31 integration review/work logs.

## State and limits

The protected original **23 chats / 88 messages**, original unsent draft, board position and unrelated coworker state stayed unchanged. Final snapshots compare call/delegation receipts, messages, grants, tabs, drafts, browser exports, app skill ownership and trigger definitions/history. Only the delegation storage bookkeeping revision is normalized; task Stop tokens and outcomes are compared exactly.

Temporary file-edit, delegation, app and coworker-call grants were restored off and the call allow-list emptied. Model Trigger permission stayed off. The disposable webhook is paused with exactly one fire. No credential values or webhook secrets are included here. The app retained its stable signing identity and required no new password prompt in this update.

**E10 closes; 21 capability groups remain, down from 22.** E9 remains partial: local delivery is accepted; external hosting and the full human-input workflow are not. C4 still needs voice. E3 still needs Terminal/Files launchers. E4 still needs the remaining connection methods/accounts. Round32 source is integrated for review but is not installed or accepted; Round33 A–I tasks are prepared separately. No hosted publishing or remote delivery is claimed.
