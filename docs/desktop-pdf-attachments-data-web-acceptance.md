# PDF, multiple attachments, data and public-page acceptance

Accepted November 4, 2026. Installed source **c41e83743cb969fc9814a2c64850d04cd762777f**, build **c41e837-desktop-0.1.0**, at `/Users/gszulc/Applications/Rerun Desktop Preview.app`. Coding branch: `desktop/m1`; packaging used the clean detached `codex-login-build` worktree. Root performed every check, build, install, live model call and native/restart action. No push or second preview app.

## Source and design

Original Rerun pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

- A: `6d2e177` / `fe69cc1` PDF confinement and Files integration, followed by root recovery wiring and the macOS renderer replacement. Reuses `FileDetail`, `PanelEditorHeader`, `FilePreview` white frame, `useSiblingFiles` and `AgentPanelFiles` folder behavior. The first iframe candidate `57a3a47` passed DOM tests but displayed `chrome-error://chromewebdata/` and a blank page in the Mac app. It was rejected. Current acceptance is for actual PNG page rendering from CoreGraphics, not that iframe.
- B: `c7db894fee5ae05553dde98006ec13e969bb9e57`, following `ChatComposer`, `ChatAttachments` and `ChatAttachmentChip`; root integrated draft migration, ordered snapshots, queue/receipt/session-transfer handling and picker metadata corrections.
- G: `925dead9ac7e30c41cd0f01bfb723f0b570cb69b`, using original `AgentPanelData`, `SharedDataPanel`, `DataBrowser`, toolbar, List/Gallery/Board views, row editors, saved views, confirmation dialogs and CSV/JSON presentation. Root corrected nested route parameter identity (`2909fda`), Board-to-preview refresh (`996cf17`) and durable selected-view preferences (`3881053` / `106175f`).
- H: `181d467cefcc2adfac0b5f6a40ce80bc3fd81e1a` and `406f35aac90e123021202741cecd790f101e9b6d`, retaining original `tools/builtin/web.ts` arguments, page facts, status caveats and Reading activity while using a bounded desktop transport/parser.

## Automated and packaged verification

- Final UI suite: **4,038 passed, 39 existing skips**, 449 files passed and 14 skipped (`work/native-pdf-ui-final.log`). Final focused PDF suite: 53 passed; included in that total, not additional passes. UI typecheck passed (`work/native-pdf-types-final.log`).
- Engine: **3,208 passed** and typecheck passed (`work/bgh-engine-native-fixes.log`, `work/bgh-engine-types-native-fixes.log`). The final engine tree is exactly `e17381e565ecf69e2eed79df010a64afcfdd01a9`; contracts tree `55e5f740eac146fc1e54e072dfe0d08c51b41cc2` is also unchanged. These are the earlier full engine results on the same source, not a new engine run for the PDF-only change.
- Shell: 16 passed (`work/native-pdf-shell.log`). Native PDF plus layout/provenance: 12 passed (`work/native-pdf-helper-tests.log`), including real colored pixels, rotation/retina geometry, caps, encryption/refusal, parent death and independent ten-second alarm. Installer and native UI dependency checks: 9 passed from the build worktree with its existing packaging dependencies (`work/native-pdf-install-tests-final.log`). The initial coding-worktree installer attempt lacked electron-builder; it was not counted as a product pass.
- Production UI/engine packaging, runtime verification and atomic canonical installation passed (`work/native-pdf-install.log`). The installed manifest and dedicated PDF helper stamp both identify `c41e83743cb969fc9814a2c64850d04cd762777f`. Runtime verification executes the packaged renderer and validates its PNG output.
- Root fixed a native macro collision and TypeScript errors before the final checks; independent source review prompted same-length file-change/link/owner detection and cancellation while awaiting file-read admission.

## Native Mac acceptance

**PDF:** From the board, open Attachment Set QA → Files → pdf-qa → two-pages.pdf. Page one visibly read “RERUN PDF PAGE ONE - 42”; Next page visibly read “RERUN PDF PAGE TWO - 43”. Previous page, 125% zoom and Fit width worked. Next file wrapped to invalid.pdf with a visible unsupported-file error; Right moved to too-large.pdf with the 16 MB refusal. Back returned to the same pdf-qa folder; Done returned to the board/chat with its original two-file draft intact. The other coworker showed only its own files. After a full quit/reopen, the PDF was reopened and page two visibly rendered again. Page/zoom selection intentionally resets when reopening a file; this does not claim saved PDF reading position. Evidence: `work/pdf-native-page-two.png`, `work/pdf-native-after-restart.png`.

**Attachments:** Actual two-file sends returned LANTERN/RIVER and 42. Draft text plus both selected files survived full restarts, and regeneration retained independent original/alternate chats. Native picker checks covered cross-folder metadata, four 32 KiB selections reaching the 128 KiB total, refusing another file, freeing capacity by removal and clearing all. Queued payload/receipt behavior passed automated regressions; a native queued transition was not conclusively captured because the preceding model call finished before submission. Do not present ordinary sends whose text says “queue” as native queue evidence.

**Data:** Actual Codex calls created the two owned QA tables. Original Table search, cell edit 17→18, List/Gallery/Board selection, Board drag Todo→Done, expanded view and CSV/JSON export worked. Native rechecks verified saved-view rename, deletion of Gallery without deleting rows, and immediately correct parent preview after a Board move. Private data remained absent for the second coworker; its separately enabled shared tool read only the shared witness. SQL Stop reaped the worker, and an independent ten-second deadline refused an unbounded read-only query without retry. The shared table’s Delete Cancel preserved data; final confirmed Delete removed only the backed-up QA table.

**View persistence:** Restart board remained selected for private qa_bgh_items, with both cards in Done. Shared qa_bgh_shared_20261104 reopened on All rows rather than its first saved List. Both selections were checked after installation and another full app restart; exact preference rows also matched.

**Web and live replies:** Public example.com fetch returned HTTP 200 and a source link; a loopback URL was refused. On the final installed build after restart, a live side-panel message ran db_query, shared_db_query and web_fetch and returned **43 / 42 / HTTP 200**, without data changes. A fresh two-file message returned **LANTERN, RIVER — 42**. Their exact messages/state survived the next full quit/reopen (`work/native-pdf-final-live-restart.log`).

## Recovery, cleanup and original data

`work/multi-attachments-completed-recovery/verified-manifest.json` records a full-quit recovery copy with matching bytes/modes/links and app-database integrity. After verification, root deleted only Attachment Set QA and Data Scope QA through the authenticated app API, and qa_bgh_shared_20261104 through the original native confirmation. Private preferences cascaded; the removed QA shared preference was cleared through its authenticated API. The two Downloads exports were removed only after exact comparison with evidence copies. No originals were removed.

The final full quit/reopen passed `work/native-pdf-clean-final-restart.log` and `work/native-pdf-original-final-restart.log`: original **Settings QA 21 chats/64 messages**, **Codex connection check 2 chats/24 messages**, original Box geometry/membership, workspace appearance and model defaults all match. No QA coworkers or preferences remain; foreign keys are clean. The final board shows only the original two coworkers and Codex connected with gpt-6.1-sol (`work/native-pdf-clean-final-board.png`).

## Limits and checklist result

- PDF: existing own files ≤16 MiB, inert page images, page count ≤10,000, zoom 50–200%, 8 MiB PNG and 4096-side/8-million-pixel caps, two concurrent renders, 8s parent deadline and 10s native alarm. Native parsing has no hard OS memory quota and may recover some malformed PDFs. No import, text selection/search, embedded links, password entry, print/download/publication, chat cards or model PDF input.
- Attachments: 1–10 own existing txt/md files, 32 KiB each and 128 KiB total; no uploads, clipboard/drop or model media input. C3 remains partial.
- Database tools: independent default-off private/shared grants; isolated bounded workers, ten-second SQL deadline, conservative SQL allowlist and bounded rows/output. The 128 MiB V8 heap is not an OS/native SQLite quota. No external database connectors or table cards. D7’s stated local browse/filter/edit/manage/view scope is complete; table result cards remain C8.
- Web: public HTTP(S) GET, ports 80/443, public-DNS validation and pinned connections, revalidated redirects, no credentials/cookies/proxy/browser fallback, bounded text-only response. No Rerun web search or workspace writeback; E2 remains partial.

This closes **A, B, G and H** in the delivery ledger. Together with prior root Control Center Boxes: **5 of 9 accepted**. Complete D7 reduces the broad catalog from **29 to 28 unfinished capability groups**. D5, C3 and E2 remain partial. C is still working; D/E/F are unaccepted source handoffs with corrections and integration outstanding.
