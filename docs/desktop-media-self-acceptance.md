# Audio previews, image result cards and own-instruction controls

Installed source: `7a70fbd578da229416950eea02670feb76873ace`, accepted November 4, 2026.
Original Rerun reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

## Integrated handoffs

- A: `3c36794`, existing own WAV/MP3 Files previews using the original FilePreview audio controls and FileDetail header. Reads are authenticated, confined to the selected coworker and bounded to 16 MiB; playback is user-started and stops on leaving the preview.
- B: `9ac2102` (including `f45b88d` and `692d218`), static image `card_file` results using original albums, captions, mixed file tiles and paged lightbox. The existing image reader validates current bytes when opened. Cards record owner-relative paths and image identities, not frozen images. No model vision or image creation is added.
- D: `2687b48`, original Improve itself master with separate opt-in Edit own instructions and Change reply length permissions. Only `soul_update` and `verbosity_set` are exposed, with execution-time permission checks; tool installation and MCP registration remain unavailable. Missing grants default off. The shared master also pauses learning without erasing the saved Learn from replies preference, matching the original behavior.

C's workspace-logo lane was still working when the user reported these three complete. Its worktree and changes are excluded from this release. All four original lane worktrees are preserved. Root retains the optional Files/Tools `dialogControl` integration for the previously accepted Control Center shortcuts.

## Integration review and corrections

Root and read-only source reviewers compared the handoffs with the pinned original implementation. Only root ran tests, builds, installation, live Codex requests and native app QA. Helpers authored focused regression cases without executing them.

- Both self tools now hold the agent lock across their latest permission/abort check, write and reload. A queued call cannot write after an earlier master or individual-grant revocation. Four regressions cover those cases.
- WAV parsing skips bounded unknown chunks, including valid `_PMX` metadata. ID3 parsing rejects reserved flags and invalid revisions and validates a declared v2.4 footer against its header. The body size excludes the footer, as specified in [ID3v2.4](https://id3.org/id3v2.4.0-structure); v2.3 has no footer flag ([ID3v2.3](https://id3.org/id3v2.3.0)).
- Native Codex QA exposed an older `desktopCardsNote` that still restricted cards to text/Markdown despite the updated tool. Root updated the model-facing instructions to static albums and mixed cards while retaining persistent-workspace, grant and size boundaries, and added a regression against the full assembled prompt.
- Text-file lightbox failures retain their generic message rather than displaying raw filesystem error details. Image-specific unavailable states remain visible.
- Added component coverage for delayed owner/page changes, URL cleanup, six-image paging, mixed text/images and the actual 24 MiB thumbnail budget. Updated existing abort-signal and display-label fixtures, the result-file permission description, and nested switch description IDs.

## Automated verification

The complete UI suite passed **3,677 tests, with 20 existing skips** (418 passed files, 13 skipped) on `1cee538`. The final `a95f079` changes only permission wording and a route comment; contracts were rebuilt and all 14 affected Tools/image-route checks passed afterward. The full engine suite initially passed 3,075 tests on `a95f079`, then passed **3,076 tests** in 273 files on final `7a70fbd` after the native-discovered prompt correction. UI code is unchanged by that engine-only correction. UI and engine type checks passed; production packaging also performs its own compilation and runtime verification.

An initial simultaneous full-suite run saturated workers and timed out: 22 UI and two engine cases failed. Both complete suites then passed with four workers per suite, without widening test timeouts or changing implementation to accommodate those failures. These are overlapping runs, not additional unique test totals. The initial source-worktree contracts build lacked its local dependency link; successful checks and packaging use the existing clean build worktree's dependencies.

## Native acceptance

Root used two disposable coworkers, Media and self QA and Media sibling QA, opened from the board in the single installed Rerun Desktop Preview. Their existing files included six static images, separate Markdown notes and 24-second WAV/MP3 fixtures. No file-write or native-command grant was enabled.

- **Files playback:** WAV and MP3 opened with the original header and audio controls. Playback progressed visibly, pause and seeking worked, and leaving the preview closed its player. Both formats played again after restart. This verifies playback progress and controls, not a claim about physical speaker output.
- **Live image cards:** the first Codex attempt exposed the stale text-only prompt described above. After installing the correction, the same conversation produced a six-image album and a separate mixed Markdown/image card through genuine `card_file` calls. The album showed the original four-image grid and +2 overlay; the lightbox reached images five and six and wrapped to the first image. The mixed card opened the primary note and its orange image. The saved album reopened after restart. Replacing the primary image with a new inode after the restart check caused the saved card to show the explicit renamed/replaced warning; the next unchanged image still opened.
- **Own instructions and reply length:** both new grants began off. With only the primary coworker's grants enabled, genuine `soul_update` and `verbosity_set` calls saved the requested MEDIA-READY instructions and Concise reply length. The original Edit coworker dialog showed both values. Turning Improve itself off removed both tools; a follow-up request could not change either value or bypass the restriction. Nested preferences remained saved. The sibling retained its original instructions, Normal length and disabled individual grants.
- **Isolation and restart:** the sibling opened its own SIBLING MEDIA 19 note and cyan image, while the primary retained PRIMARY MEDIA 73 and its separate chat. A full quit/reopen exactly preserved the captured settings, effective permissions, config/file hashes, chats, replies, tabs and unsent draft. Native checks then reopened the saved album, settings, disabled master and both audio formats. The deliberate image replacement happened after this exact snapshot comparison.

Production packaging, runtime verification and installation succeeded from the clean build worktree at the installed source above. The installed manifest and build checkout agree. The app remains open on the board with Codex connected and the original gpt-6.1-sol default.

## Cleanup and evidence

Root quit the app and made a byte-verified recovery copy of the completed QA workspace, including a database integrity check. Only the two named temporary coworkers were then removed through the authenticated local API, with identity checks against that recovery copy. After another full quit/reopen, their folders and database rows were gone and foreign keys were clean. The original Settings QA and Codex connection check retain exactly **23 chats and 88 messages**, including unchanged identities and message contents. My workspace, its original icon/theme and provider defaults are unchanged.

Local evidence is retained in the task workspace under `work/`: `abd-new-full-ui-bounded.log`, `abd-new-copy-check.log`, `abd-media-prompt-engine.log`, `abd-new-ui-types-final.log`, `abd-new-engine-types-final.log`, `abd-media-prompt-install.log`, the exact before/after snapshot `abd-media-restart.json`, and the verified `abd-media-completed-recovery/` copy. Native screenshots are saved in `outputs/Rerun image album.png` and `outputs/Rerun audio after restart.png`.

This accepts the A/B/D slices, not full D5/C8/E7 parity. More preview formats, table/other result cards and tool installation/MCP/self-improvement capabilities remain on the checklist. C's local workspace-logo upload is still working and is not part of this acceptance.
