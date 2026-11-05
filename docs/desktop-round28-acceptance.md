# Round 28 Mac acceptance — November 5, 2026

**Accepted: all eight agent handoffs plus the earlier root attachment-only slice (9/9). Installed product: `06ebdf63126335615bf56142fed96b0771e84e89`. Company Brain completes D8, reducing the remaining capability groups from 25 to 24.**

Root reviewed the final handoffs, repaired integration and native failures, and ran every test, build, installation, live Codex request and Mac check. Internal helpers performed source review and authored tests only. All eight agent worktrees remain clean and unchanged. No code was pushed.

## Original Rerun code and design

Reference remains `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. Brain retains the original BrainEditor, BrainPageParts, BrainTopBar, ProposalCard, ProposalList and Now/After rendering. Desktop wrappers provide authenticated local storage and actions. Files keeps the original frame, header and sibling navigation. Native file publication uses the original approval presentation, backed by exact captured-file authorization.

See `desktop-round28-integration.md` for full handoff commits and source corrections. Final handoffs: A `be36fe6`, B `8f631f2`, C `e31d6e0`, D `d718514`, E `102a221`, F `ea1cb30`, G `5a3edf5`, H `abaf89a`.

## Native acceptance

| Work | Observed in the Mac app |
| --- | --- |
| A — GIF/WebP | GIF test-pattern frames changed; WebP showed blue and red frames. Both reopened after restart in the existing Files frame. |
| B — audio | FLAC and M4A advanced through playback to 0:01; Ogg reached 1.0065 seconds. All reopened after restart; FLAC playback was repeated after restart. |
| C — video | WebM, MOV and M4V played the generated video through 0:02. All reopened after restart; WebM playback was repeated afterward. |
| D/G/H — Company Brain | Created and autosaved a page; actual Codex brain_search/read/propose returned its content. Pending proposal survived a clean quit/reopen. More details displayed amber → violet; Accept saved violet. History showed the coworker proposal revision. Restore returned amber while preserving all three revisions. A second proposal was dismissed without changing the page hash or revision IDs. Final restart retained the page, history and both decisions. |
| E — native file review | Codex edited a temporary copy. Saved source stayed BEFORE while approval was pending across restart. Approve published exactly `WRITEBACK28 APPLIED` plus newline. Not now → Confirm rejected a second edit without changing the file. Stopping after a native edit and during a local wait left the approved file unchanged, created no publication proposal and left no worker running. Saved/rejected receipts survived final restart. |
| F — local MCP | User approved the separate local-program permission for the disposable QA coworker. Saved canonical packaged Node plus the reviewed arithmetic/wait fixture; probe listed add/wait. Real calls before and after restart returned `LOCAL28: 42` with distinct arguments and recorded non-error tool results. Stop cancelled an active wait and removed its process. Disconnect showed zero tools; reconnect listed two. Revoking the grant yielded `LOCAL28 UNAVAILABLE` with no tool call. The grant is left off. |

The board stayed visible behind coworker chat, and closing the panel returned to the board. Original account remained connected throughout the corrected restarts, with no further password prompt. Brain pages are workspace knowledge; private Memories remained a separate list/search (ORBIT28 returned no private-memory matches). Learning from replies created an independent QA memory rather than copying the shared page store.

## Fixes found and made by root

- Admit authentic local MCP tools into the Codex adapter using bounded Zod schemas; retain rejection of copied adapters.
- Reject native capture/publication from cancelled runs and remove actionable controls from cancelled proposals.
- Stop cleared Brain draft tombstones from consuming active quota; preserve revision checks, mutation identities and save ordering through interruption.
- Correct WebM block integers independently of EBML unknown element sizes.
- Protect active chats and navigation while the Brain modal is open; use one canonical Brain root on macOS.
- Treat final routine notifications as best effort while retaining mandatory tool/native-worker shutdown checks.
- Mark runtime file paths correctly so packaging does not include the source tree or fixtures.
- Native QA caught Next's graceful exit143 being treated as a failed Quit. Accept it only for a requested UI shutdown after authenticated cleanup for that launch, never for engine failures or raw signals.
- Retain an engine's failed exit after a stop timeout, so retry cannot forget unconfirmed native cleanup.

The first failed Quit required recovery of the stranded Electron shell after verifying its workspace services had already exited. That recovery was not counted as a graceful restart pass. The corrected build subsequently passed clean Quit/reopen checks, including the final `06ebdf6` build.

## Root verification

- Full UI run: **4,716 passed / 48 skipped**, 544 passing files and 15 skipped files. Later focused path checks: 12 passed. Final production UI build/type checking passed after the help-text and shell fixes.
- Engine full run: **3,397 passed / 3 timeouts**. All 14 tests in the affected files passed serially; two additional bootstrap/shutdown regressions passed afterward. This covers 3,402 unique engine cases across runs, not a single uninterrupted 3,402-case run.
- Final shell suite: **26 passed**. Parent-code negative controls reproduced the graceful-exit failure and both late-engine-failure cases; corrected cases passed.
- Compiled first-turn/restart/attachment-recovery checks: **2 passed**. Both type checks passed. Lint had no errors; existing warnings remain.
- Production packaging, runtime checks, source receipts, signing and canonical installation passed. The same Apple Development identity was reused. This is a local preview; notarization is not claimed.

Detailed root logs remain in the task's `work/` directory, including `round28-ui-accepted.log`, `round28-engine-accepted.log`, `round28-engine-timeout-recheck.log`, `round28-compiled-chat-verified.log`, `round28-shutdown-custody.log` and `round28-final-install.log`.

## Final restart and preservation

A verified full-workspace recovery copy was made with the app fully quit. Exact read-only comparisons before/after the final reopen matched the QA coworker's **7 chats / 34 messages**, configuration hash, recorded run statuses/tool results, Brain file/page/history/proposal records, local MCP configuration and call identities, and saved/rejected file-review receipts and file hash. Cancelled work did not replay. The prior attachment-only conversations retained eight messages each, an empty queue and the same delivery receipt.

The two original coworkers retain their exact **23 chats / 88 messages**. The original Round26 QA pending approval was untouched. Clearly named QA coworkers, fixtures and paused routines remain for review. The local-program grant on the QA copy is off. The app is left open on the board with Codex connected.

## Remaining scope

D8 is complete for its recorded shared-page/edit/history/proposal-review scope. D5 remains open for SVG, AVIF, ICO and BMP previews. E2 still needs Rerun's own web search; this delivery covers bounded text/Markdown native writeback, not arbitrary binary publication. E5 still needs real OAuth sign-in acceptance and legacy SSE; local programs use explicit executable/arguments, with no custom environment. They run as the Mac user, not inside an OS sandbox. Actual macOS notification banner/click acceptance remains open under C7. Broader chat media inputs/results are separate checklist items.
