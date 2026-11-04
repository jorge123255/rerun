# Media and Control Center attention — Mac acceptance

Installed source: `b3eee71ad59fca0bda34d83f114b39dfdd3f2f77`, November 4, 2026. Original Rerun reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

One installed app: `/Users/gszulc/Applications/Rerun Desktop Preview.app`. Source edits are on `desktop/m1` in the coding worktree; packaging used the separate clean build worktree. No push was performed. C's workspace-logo upload and D's pending-inbox-read worktrees were untouched and are not part of this acceptance.

## Ports and original design

- **A — MP4 Files previews:** integrated handoff commits `41f0c33` and `72c4dae`. The existing Files panel uses Rerun's editor header and standard video controls. Its authenticated reader confines files to the owning coworker, validates MP4 structure and identity, and limits files to 16 MiB. Back, Close and unmount release playback.
- **B — WAV/MP3 result cards:** integrated `945897b` and `162e37d`. Real `card_file` output uses Rerun's square audio tiles, mixed-file ordering and paged lightbox. Audio loads when opened and plays on user action. Paging/closing stops the departing player. The existing permission and authenticated audio reader remain the boundary.
- **Root — Control Center Needs you:** uses the original `ControlCenterView`, roster order, orange status badges and uncapped Needs you group before Recent. Waiting coworkers are not duplicated below. Command/agent search and coworker drill keep their original scopes. The board and center share a current activity snapshot; selecting a row refreshes and verifies its exact request and owner before opening that pending chat. Read failures stay visible and offer retry.

Original sources reviewed include `ControlCenter.tsx`, `FileDetail.tsx`, `FilePreview.tsx`, `FileCard.tsx`, `AttachmentTile.tsx`, `AttachmentLightbox.tsx`, the original card tool and chat-card contract. Hosted views were reused without introducing a new visual design. Desktop adapters supply local storage and navigation.

## Checks run by root

- Full UI suite: **3,752 passed, 20 existing skips** across 423 passing and 13 skipped files. The installed native rename helper was enabled for this full run.
- Full engine suite: **3,078 passed** across 273 files.
- Both UI and engine type checks passed, as did contracts compilation, production packaging, bundled-runtime verification and installation. The clean build and installed manifest match the source SHA above.
- Focused UI (150) and engine (75) checks also passed; these overlap the full suites and are not additional totals. The new Needs-you tests cover exact pending sessions, resolved/replaced requests, disabled/removed owners, working precedence, partial reads, retry, close/reopen and late callbacks.
- Review helpers only inspected source or authored regressions. Root alone executed every check, build, live Codex request and native Mac action.

## Native board and restart acceptance

Two disposable coworkers held different same-named MP4s, recorded audio and an image. Opening the primary from the board, its real H.264 MP4 displayed moving test-pattern frames, played, sought to 12 seconds and paused. Back returned to Files. A damaged MP4 showed a clear unsupported-file error. The sibling opened its own blue video, and closing during playback returned to its chat without changing its draft.

A real Codex turn produced WAV, MP3 and PNG cards in the requested order plus a pending question. WAV and MP3 both played, sought and paused in the original lightbox. Paging selected the next file without autoplay; the mixed image remained the third entry. A separate real Codex turn created the sibling approval request.

Each coworker then received a separate unsent draft tab. Control Center showed both Needs-you rows before Recent and opened the exact question/approval chat, even when the unrelated draft had been selected. Returning to each draft retained its text. Closing the side panel retained the mounted board.

Root saved exact state and fully quit with both requests pending. On reopening, settings, grants, config, file hashes, sessions, messages, tab layouts/revisions and drafts matched the saved snapshot exactly. Workspace name/icon/theme and provider defaults were unchanged. Both pending rows still navigated to their exact restored requests. The saved MP3 card played again, and the primary MP4 played to eight seconds after restart. Both unrelated drafts remained intact.

Answering Blue resolved only the primary question. Codex replied “Blue selected. No files changed.” The primary moved out of Needs you; the sibling approval remained pending and navigable. Read-only checks confirmed the sibling messages, both drafts, settings, grants and restored file hashes were unchanged.

Replacing only the disposable primary WAV with another inode caused its saved card to show “was renamed or replaced” and refuse playback. The original fixture inode was restored afterward.

## Cleanup and remaining scope

A full, byte-verified recovery copy with database integrity verification was saved before installation and another before cleanup. Only the two named fixture coworkers were removed through the authenticated API after their identities were checked against that backup. Their folders and rows are absent, foreign keys are clean, and a final restart preserves the original **23 chats / 88 messages**, exact identities/content, My workspace appearance and **gpt-6.1-sol** default.

D5, C8 and B5 remain partial; the checklist still has **30 incomplete feature groups**. MP4 preview does not add model video input, recording, imports, conversion or other video formats. Audio cards do not add recording, transcription or model audio input and reference current persistent files rather than frozen copies. C and D still need separate handoff review and acceptance. The existing closed Actions inbox uses a lazy snapshot and its accessibility label says checking until first opened; opening it correctly showed the remaining approval. Its collapsed-label freshness remains a C7 follow-up alongside D's inbox work, not a new regression.

Evidence: `work/media-attention-ui-full.log`, `work/media-attention-engine-full.log`, both typecheck logs, `work/media-attention-install.log`, `work/media-attention-restart.json`, `work/media-attention-completed.json`, and `work/media-attention-completed-recovery/verified-manifest.json`. Native screenshots are exported with the report.
