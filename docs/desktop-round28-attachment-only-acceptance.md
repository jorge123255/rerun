# Round 28 — attachment-only messages accepted

Verified November 5, 2026 in the installed Mac app, source `328ed489f66bc1d9db32eaae81b8ef1d605f1882`, at `/Users/gszulc/Applications/Rerun Desktop Preview.app`. Root implemented and tested this slice. A–H’s separate round 28 assignments are pending; they are not included in this build.

Original Rerun `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`, `ChatComposer.tsx::handleSubmit`, permits attachments with no typed message. Desktop now supports that interaction with its structured, validated attachments. It keeps authored text empty, derives a first-chat title from filenames, and preserves the original composer/side-panel design.

## Mac and restart results

- Opened Round26 QA copy from the board and started a new chat. The empty composer’s Send button was disabled. After attaching `round28-image-only.png` without text, Send became available and the UI showed Draft saved.
- Fully quit and reopened Rerun. The same new-chat draft retained its image and empty textarea. Sending it created the title `round28-image-only.png`; Codex identified the red circle, blue square and exact `ORBIT 27` lettering. No answer was supplied in typed prose.
- Uploaded `round28-note.md` and sent it without typed text in the same chat. Codex reported the actual note color **amber** and marker **AMBER 28**.
- Started a longer ordinary reply, selected the note again and sent with no text while the reply was running. The Mac UI visibly showed **Queued Attachments only**. When the first reply finished, the queued attachment sent automatically and Codex answered from it. The queue cleared.
- Regenerated that attachment-only reply. The original chat remained intact and the alternate chat contained its own new reply.
- Fully quit/reopened again and opened the coworker from the board. Both tabs, their filenames, attachments and distinct final replies were visibly present. Closing the panel returned to the board.
- Exact read-only comparison before/after this final restart preserved both new conversations’ eight messages and their content hashes. Each has three empty-authored-text attachment turns; the fourth user turn was the longer queue-test prompt. There is exactly one queued-send receipt and no remaining queued message. Regeneration copies the preceding transcript into its alternate, as designed.
- The same signed identity and saved ChatGPT login worked without another password prompt during installation/restart/model checks.

## Root verification

- 118 UI/bridge tests passed across 16 affected suites. An older expectation that attachment-only Send must be disabled was updated to the new behavior, including disabling again after removal of the last attachment.
- 37 engine chat tests passed, including empty-turn refusal, image-byte validation, another-provider refusal and exact read-only queue reconciliation without new runs.
- Two compiled-engine integration cases passed after a fresh contracts/engine build: ordinary and attachment-only first messages recover after a lost registration response and full engine restart, even after the source attachment is removed. The recovered attachment-only title is `Map.md`.
- UI and engine type checks passed. Targeted lint completed with no errors and 50 warnings; lint is not claimed warning-free.
- Production packaging, packaged runtime checks and strict signature verification passed. The dependency symlinks in the coding tree were preserved. Tests used current source contracts explicitly where the older shared dependency tree otherwise resolved stale contracts; the compiled integration cases ran from the clean build worktree.

All tests, builds, installs, model calls and Mac operations were run by root. Helpers performed read-only review. No product changes followed native acceptance; any subsequent commit records documentation only.

## Data and scope

Verified recovery copies were taken before installation, with the saved image-only draft and before the final restart. The original Settings QA and Codex connection check coworkers retain their exact **23 chats / 88 messages**. The existing pending Round26 QA approval was not answered. Disposable Round26 QA and its copy remain, with paused routines; the copy now includes the two clearly named attachment test conversations.

This accepts root’s round 28 task and closes the previously unobserved native queued transition for this tested path. C3 remains partial for broader model media input and unaccepted native drop/paste/error interactions. **25 capability groups remain.** Actual macOS notification banners and real-provider MCP OAuth remain separately unverified.
