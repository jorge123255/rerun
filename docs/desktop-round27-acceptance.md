# Rerun desktop integration and Mac acceptance

Verified November 5, 2026. Installed application: `/Users/gszulc/Applications/Rerun Desktop Preview.app`, source `adfb47d1838491f1bb0b38c3f147cb29944b3699`.

**Eight of nine current delivery tasks are accepted. Shared files (D6) is complete as scoped in the original checklist, reducing unfinished capability groups from 26 to 25.** Real MCP OAuth provider sign-in remains unverified. Actual macOS notification banner delivery/click remains a separate C7 acceptance gap; the in-app notification surfaces passed.

The implementation follows original Rerun at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. Root reviewed integration, fixed defects, and performed every automated check, build, installation, live model call and Mac test. Helpers did not execute tests or control the app.

## Signing and saved ChatGPT login

The previous preview used ad-hoc signing. Packaging now uses the existing Apple Development certificate, retains the installed signer and refuses an unavailable signer unless explicitly changed. Credentials remain encrypted; no credentials were cleared or exported and access rules were not weakened.

The app identity and the bundled Codex runner required separate macOS Keychain approvals. After the user approved both, the same-signer update and repeated full quit/reopen checks reached the board without another password prompt. Live Codex requests succeeded before and after restart using the saved account. This establishes continuity for the tested signed build; it does not promise that macOS can never ask again after a future identity or Keychain change.

One post-restart request returned “Selected model is at capacity.” A retry on the same GPT-6.1 Sol model succeeded without changing settings or credentials.

## Native results

- **A — PDF text selection and Find:** on the corrected build, Find highlighted the actual upright text. Copying into Find produced exact `Alpha one`, including its space. Next match opened the rotated/cropped second page and highlighted the rotated word correctly. Zoom reached 125%; the image-only third page rendered. Verified after installation/restart. Partial-word highlights remain proportional within word boxes; no OCR is claimed.
- **B — image model input and mixed attachments:** text followed by an image survived as an unsent draft across restart, preserving order and the thumbnail. Sending that restored draft from the board produced a real Codex answer identifying a red circle on the left, blue square on the right, white background and exact `ORBIT 27` text. It also quoted `The test note says: green notebooks.` The prompt did not supply those answers. After another full restart, the attachments and reply remained visible; a new follow-up in that saved conversation returned the same visual details and note. The image lightbox also opened. Native queue transition and broader media-input formats remain outside this accepted slice.
- **C — original notification surfaces:** the coworker bell retained All activity after restart and counted its scheduled task. The paused `Round27 notification check` routine retained its Notify me override off and was never run. A background completion toast displayed the copy’s real private/shared results. A subsequent error toast appeared on the board; clicking Open conversation opened the exact original QA coworker/shared-file session. This did not answer the separate pending approval. Actual macOS banner/click remains unobserved.
- **D — shared files and private isolation:** native import/preview and Control Center reopening preserved `round27-shared.txt` through restart. Actual `shared_list` and `shared_read` calls returned `SHARED27: the workspace notebook is green.` Two coworkers read that same shared file while their private `round26-fresh.md` contents remained different: original `FRESH AFTER`, copy `SIBLING AFTER`. Both produced successful fresh read-only tool results after full restart, and both replies/receipts were visibly checked in the Mac side panel. The copy had its own conversation. Duplicate intentionally copies authored private files initially; editing the copy afterwards did not change the original. This closes D6’s recorded read/share/isolation scope, not shared write/edit/search, arbitrary media or publication capabilities.
- **H — original skill suggestions:** created `Round27 checklist` using the QA coworker’s original Skills editor. `/round` found it and inserted `/round27-checklist `. The draft, skill lookup and insertion worked again after full restart. Voice notes and coworker delegation mentions remain separate work.
- **E, G and root:** private file writes/edits, description-based creation/placement and Control Center To handle retain their earlier native/restart acceptance. To handle/read receipts do not approve requests.

## Root corrections and automated verification

- `d023a9a`: signed Codex could not read the SDK’s ordinary temporary image directory. Both adapter bundles now forward validated frozen image bytes inline, without broadening filesystem access. The captured `turn/start` regression fails against the previous adapter and passes with the patch. Seven provider/auth tests and engine type checking passed. Account initialization allows two minutes for Keychain approval and gives a specific timeout hint; other requests retain their 30-second deadline.
- `adfb47d`: native Find exposed a displaced PDF highlight because CoreGraphics centered an unscaled page in its larger bitmap. The renderer now maps crop/rotation in PDF points, then scales to bitmap pixels. The regression fails against the previous renderer; all six native renderer checks pass after the correction.
- The broad UI run passed 4,679 tests, with two failures and 39 skips. After the import confinement and notification-expectation fixes, the affected suites passed 110 tests with 19 skips. A later skill harness correction passed its 11 tests and lint. These are broad-run plus focused-fix results, not a claim of one final entirely green broad run.
- The broad engine run passed 3,359 tests with two timeouts. The focused rerun, including both timeout cases and the shared/image cases, passed 67 tests. UI and engine type checks passed. Shell/build checks passed after updating the PDF-text packaging-stage expectation.
- Production packaging, strict signature checks and packaged runtime verification passed, including upright, rotated and scanned PDF fixtures. No product code changed during the final approval/restart acceptance pass.

## Preserved data and remaining limits

The final read-only exact comparison passed: Settings QA retains 21 chats/64 messages and Codex connection check retains 2 chats/24 messages — the original **23 chats and 88 messages are unchanged**. Round26 QA’s separate approval still shows Not now and Approve, both unselected. No action was approved during this pass.

A verified full recovery snapshot was taken before the final live restart. The clearly named Round26 QA and Round26 QA copy fixtures, their separate chats, private notes, saved image attachments, skill, paused routines and shared note are retained. The app is left on the board with Codex connected.

Open acceptance limits: a real MCP OAuth provider sign-in; actual macOS notification banner/click; the other partial capabilities listed in the remaining checklist. No additional authorization is needed to use the already connected chat account.
