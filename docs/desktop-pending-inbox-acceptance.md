# Pending inbox read and live counts — Mac acceptance

Accepted November 4, 2026. Installed source: `c6fa087643e205a0e70a03bee264a8714eb41fa4` at `/Users/gszulc/Applications/Rerun Desktop Preview.app`. Coding branch: `desktop/m1`; packaging used the clean detached `codex-login-build` worktree. D's clean handoff `1545c0224bfd0b4fc74812d348470415a8035a4e` was integrated as `329950e` without changing its original worktree.

## Original code and implementation

Original Rerun reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. The port follows `WorkspaceInbox.tsx`, the shared `InboxSurface.tsx` and `inbox.service.ts`: pending/Done sections, buddy and status colors, per-row checks, and the original Mark-everything confirmation. The original source files remain unchanged.

Pending read receipts identify an exact question/approval, independent of the shared attention projection. Marking read never answers or approves. The original board and Control Center continue to show unanswered requests. Root wired schema initialization, corrected per-target deadline/failure results, guarded old callbacks/retries and confirmation lifetimes, and retained explicit partial/unavailable states.

Root's next slice keeps the collapsed Actions count current while the window is visible. Done counts sum terminal executions, including grouped runs. Explicit read actions require the open inbox; visible-chat Done auto-read remains. Hidden windows pause reads and Quit blocks new work.

Native QA found Escape could dismiss both the confirmation and the inbox: Radix consumes the event during capture, and its synchronous dismissal can attach the inbox's bubbling listener before that same event arrives. A regression failed against the previous source, then passed with the inbox respecting `defaultPrevented`. The corrected installed build passed the native Escape recheck.

## Root-run checks

- Full UI suite: **3,793 passed, 20 existing skipped** (427 passing test files; 13 skipped).
- UI typecheck, production packaging, bundled runtime checks and exact installed source receipt: passed.
- The earlier 70 focused checks are included in the full suite; the final synchronous Escape regression adds one case. Do not add overlapping totals.
- Coverage includes exact receipt identities, owner/chat/kind binding, new requests, deadline and partial retry behavior, startup/reopen and cascade deletion, confirmation pointer/cancel/Escape behavior, arrivals after confirmation, stale callbacks, closed counts, grouped Done totals, hidden-window pause and Quit.
- Engine source was unchanged; its suite was not rerun for this release. Packaging compiled the engine.

## Native Mac and restart evidence

Only root operated the Mac app and sent live model requests. Two disposable coworkers were opened from the board. Codex produced a Blue/Green question, a separate reply of **73**, and a sibling approval card. The collapsed count updated to **2 pending · 1 done** without opening Actions. Independent blank-tab drafts were saved for both coworkers.

1. Marking only the question read removed only that inbox row. Both pending identities and all coworker messages, settings, grants, files, tabs and drafts were unchanged. Full quit/reopen restored the receipt and **1 pending · 1 done**; both board tiles still needed attention.
2. Cancel and Escape acknowledged nothing. On the corrected build Escape dismissed only the confirmation; a second Escape closed the inbox.
3. Control Center still opened the read question. Answering Blue produced the real Codex reply **Blue selected**. A second question in the same chat acquired a new unread identity despite the first receipt. The sibling approval and both drafts remained unchanged. The closed count returned to **2 pending · 1 done**.
4. Mark all showed the original three-item wording. Cancel preserved the exact state. Confirmation cleared the displayed pending and Done rows only. Shared attention still contained both unanswered requests; all coworker content was unchanged.
5. Another full restart preserved exact messages, tabs, drafts, settings, grants, file hashes, request identities and receipts. The inbox stayed empty, while the board opened the still-actionable Keep/Skip question and the sibling's unapproved action. Both independent drafts were visibly restored.

New-arrival-during-confirmation, unavailable/partial engine, grouped scheduled totals and stale-callback cases were automated checks, not separate native scenarios.

## Preservation and remaining scope

Recovery copies before installation and after completed QA matched every file byte, mode and symlink, and passed database integrity. Only the two named fixture coworkers were then removed through the authenticated local API. Receipt cascades and foreign keys were verified. A final restart preserved the original **23 chats / 88 messages** exactly, along with workspace name/icon/theme and the `gpt-6.1-sol` default. The single installed app remains on the original board.

C7 remains partial: notifications and coworker notification preferences are still missing. QA also confirmed a pre-existing pending age/order limit: desktop attention uses the local chat timestamp, which is not refreshed for later requests. A later question can therefore display the chat's older age. The follow-up should carry the source message's existing `createdAt` into the pending projection, preserving request identities and avoiding poll-time timestamps. This did not affect read receipts or the native new-request test.

A/B's next prepared assignments are Files previous/next navigation and existing MP4 result cards at base `f8375b7`. C's completed workspace-logo handoff is being reviewed separately and is not included in this installed source.
