# Round 29 — C review and video-card acceptance

Verified November 5, 2026. Installed source **9f473255bf3a4bda17e3b7c0b68e1e01b7ea12cb**, build `9f47325-desktop-0.1.0`, in the single canonical `/Users/gszulc/Applications/Rerun Desktop Preview.app`. The existing Apple Development signing identity was preserved; update and full restart showed no Keychain prompt.

## C’s completed handoff

Reviewed exact `b5fc632e15311db78c876ea8fe8168391fb2a729`, integrated as `9542900`, corrected by root in `70d7bb2`. Fixed the syntax error, unsafe watch filtering, missing current authority/drive lease checks, socket shutdown, cancellation cleanup, input packet ordering, Stop error handling, stale lease reconnect, manual Done and durable hand-back waiting, and invisible Take control overlay. Root authored/executed regression checks; read-only helpers reviewed source only. C’s own worktree was preserved.

The viewer **is not enabled or accepted as a working E3 feature yet**. Its engine routes/bridge and dialog remain unmounted until A’s isolated Linux runtime and B’s tool/request authority are integrated. Root must verify the actual read-only VNC endpoint, screenshot delivery to Codex, permissions, takeover/Done/Skip, shutdown and profile/request persistence. No host desktop fallback or new browser permissions were enabled. See `desktop-round29-viewer.md` for the corrected integration contract.

## Root’s next slice — accepted

WebM, MOV and M4V results now work in chat alongside MP4, using Rerun’s original album, captions, inline video controls and paged lightbox. Engine/result parsing and MIME admission now match the already accepted Files reader. The 16 MiB individual video limit, 24 MiB combined image/video budget, current owner/file identity checks, all-or-nothing admission and cleanup remain intact.

Original source `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`: `apps/ui/lib/files/preview.ts`, chat `FileCard.tsx`, `MediaAlbum.tsx`, `ChatVideoTile.tsx` and `AttachmentLightbox.tsx`; engine `tools/builtin/cards.ts`. No new visual layout was introduced.

## Root verification

- **102 distinct UI/reader/route checks and 34 engine checks passed** in the final focused run. This includes 12 viewer transport/authority checks, six client lifecycle checks and two dialog Done/receipt checks. The component followup reran 13 of those checks after lint/lifecycle cleanup; it is not added again to the unique total.
- Initial video failures were obsolete MOV refusal and description assertions plus an incorrect album button label in the new test. They were corrected and the affected suites passed. Both type checks and focused lint passed. Four pre-existing optional-chain lint errors in the touched video tests were also corrected.
- Production UI/engine compilation, packaged runtime verification, signing and exact-commit install passed. Full recovery backups were taken only after Quit and verified by file/hash manifest and SQLite integrity.
- Native board → Round26 QA copy → new chat → live GPT-6.1 Sol produced a real card_file result containing `round28.webm`, `round28.mov`, `round28.m4v`, then `VIDEO29 READY.` The original three-video album was visually inspected beside the board. WebM played inline; MOV/M4V played in the paged lightbox. Playback changed Play → Pause → Play; MOV/M4V scrubbers reached 0:02.
- After full Quit/reopen, the same conversation, reply and cards returned. All three saved videos were opened and played through again; every scrubber reached 0:02. Previous/Next selected the expected filenames and indices. Closing returned to the same chat and then the board, with Codex connected.
- Exact saved-state comparison passed for all nine QA-copy chats / 38 messages, tool results, runs, configuration, Brain pages/revisions/proposals, local MCP receipts and native-file review state. Both the audio and video card receipts still match their persistent file identities and byte sizes. Earlier attachment-only chats/queue receipts are unchanged. Original coworkers retain **23 chats / 88 messages** exactly.

Evidence: task `work/round29-c-video-*` and `work/round29-video-*` logs/snapshots; backups `round29-before-c-video-update` and `round29-video-before-restart`. The app is left open on the board. No other agent worktree was edited.

## Checklist status

Two root slices are accepted this round: M4A/Ogg/FLAC audio cards, then WebM/MOV/M4V video cards. C’s handoff is reviewed and corrected but awaits combined E3 runtime acceptance. A/B and D–H remain outside this delivery. **24 capability groups remain**; C8 still has child runs, additional result formats and request presentations, while E3/E4 remain open.
