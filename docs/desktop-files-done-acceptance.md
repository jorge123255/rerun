# File previews, file cards and completed replies — Mac acceptance

Accepted on November 4, 2026 in installed source `50e0abde355514267b4952d3c42ad6f4f72e1a93`.
Coding remains on `desktop/m1`; packaging used the clean `codex-login-build` worktree and replaced
the single `~/Applications/Rerun Desktop Preview.app`. Root performed every test and app action.

## Integrated handoffs and original design

- A: `06f74a2`, static raster previews in coworker Files. Reuses original `FileDetail`,
  `PanelEditorHeader` and `FilePreview` layout.
- B: `c30f55d` through `198e704`, opt-in `card_file` results. Reuses original `AttachmentTile`,
  file-card grouping and paged text-preview layout.
- D: `74c65a1`, the Actions inbox Done section. Follows original `WorkspaceInbox`,
  `unseen-runs` grouping and `InboxSurface` status styling.

All comparisons use original Rerun commit `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

## Review corrections

Root integration bounded individual image frames and rejected animation containers, including
oversized inner GIF/WebP frames. File-card guidance now distinguishes persistent Files from
Codex's disposable native-edit folder; a card is a current path reference, not a byte snapshot.

Done now pages terminal rows before grouping, uses opaque identities bound to the coworker and
engine session, and validates exact acknowledgments against actual engine completion records.
Startup establishes the first-enable cutoff. Desktop settlement awaits completion persistence;
failed writes are logged and release waiters without inventing a successful receipt.

Read-on-visible requires a freshly loaded transcript, known question/approval state and an active,
focused, unobscured chat. Stale roster/callback reads, failed acknowledgment retries and older-page
navigation have regression coverage. The board, chat tabs and Done navigation share the same local
conversation identity.

Packaging initially rejected source/test files traced by dynamic image paths. Runtime path joins
now use the existing Turbopack tracing annotations. Runtime path checks are unchanged, and the
packaging check remains enabled. Image Response/BigInt types and the login test's quoted bundled
Node launcher were also corrected before acceptance.

## Automated verification

- UI: **3,597 passed, 20 existing skips** across 408 passed and 13 skipped files.
- Engine: **3,063 passed** across 272 files.
- UI and engine type checks passed; contracts built; production packaging and runtime verification
  passed, including native dependencies and absence of source/test fixtures or escaping symlinks.
- UI full run was at `d652c25`; engine full run was at `6a48951`. Later changes through the
  installed `50e0abd` only annotate runtime path tracing and were checked by the production build,
  unchanged packaging guards and native acceptance below.

Focused checks are included in the suite totals, not added to them. Coverage includes image
format/frame/path ownership failures, file-card grant isolation and saved rendering, raw paging
past over 100 seen rows, tied IDs across coworkers, exact mark-read ownership, delayed refreshed
history, stale actions, failure rollback and actual run-settlement persistence/failure recovery.

## Native Mac acceptance

Two disposable coworkers were created with separate existing files. No chat or completion was
seeded: all eight test messages came from actual signed-in Codex interactions (`gpt-6.1-sol`).

1. From the board, opened Files, viewed a valid PNG in the original preview frame, returned to the
   list, checked a rejected image and reopened text containing `FILES_OWNER_42`.
2. Enabled Show result files for that coworker. Sent a real `card_file` request in the side panel,
   closed to the board while it worked, and received a Done row with “Files are ready.” Opening
   that row reopened the exact chat. Both file tiles read the correct text; paging worked.
3. Created a real `ask_user` question and a separate sibling arithmetic reply of **63**. The board
   showed Needs you separately from Done. The stored question-ending run was `done`, but correctly
   produced no completion record.
4. Fully quit and restarted. The first read receipt stayed cleared; the sibling remained unread;
   the pending question survived. Exact chat identities, messages, tabs, drafts, eight file hashes,
   completion records and seen receipts matched the pre-restart snapshot.
5. Opened the sibling Done row, then the owner's saved cards and image from the board. The card
   still showed `FILES_OWNER_42`. Answered the restored question with Ready. Codex replied
   “Ready confirmed.” It was acknowledged while visible with the inbox closed.
6. Fully quit and restarted again. The inbox showed Nothing to handle. All three completion
   records and their three read receipts, eight messages and file hashes matched exactly.

Native coverage here is PNG and text/Markdown cards; other allowed raster structures and failure
paths are automated coverage. This does not claim animation, image chat input, table cards or
generated-file publication.

## Cleanup and preserved state

Before updating, and again before deleting fixtures, root made a byte-verified full workspace
recovery copy. Native exact-name confirmation deleted only the two disposable coworkers.
Their engine folders and owned database rows, including completion receipts, were removed;
foreign-key checks passed. The original **23 chats and 88 messages** retained every identity and
exact message content. Original provider/model/reasoning defaults were unchanged.

Scope remains partial: static PNG/JPEG/WebP/single-frame GIF; existing `.txt`/`.md` card files;
unread completions recorded after first enable. Historical notification backfill, animation,
PDF/audio/video previews, table cards and native notifications remain checklist work.
