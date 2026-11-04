# Workspace logo upload — Mac acceptance

Accepted November 4, 2026. Installed source: `b85926cb37135ffbb0ed6b28795bf7c111f15ad4`, at `/Users/gszulc/Applications/Rerun Desktop Preview.app`. Coding branch: `desktop/m1`; packaging used the clean detached `codex-login-build` worktree. C's clean handoff `8f031fec3e31fca6ed82bb20bfd1cef3e1a4226e` was integrated as `1385329`; its original worktree remains untouched.

## Original design and local implementation

Original Rerun reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. The port follows `WorkspaceSettingsDialog.tsx`, the original `FileDropzone`, `workspace.actions.ts` and `lib/images/upload.ts`: logo preview and upload badge, original illustration grid, Cancel, and one Save for name and logo. The original board and chat stay mounted behind the dialog.

Static PNG, JPEG and WebP uploads are limited to 8 MiB, 8192 pixels per edge and 16,777,216 pixels total. The original rotate/resize-inside/WebP pipeline stores a raster no larger than 256 pixels. SQLite commits name, opaque upload identity and bytes together. Replacements remove old bytes; name-only saves retain the exact image. The existing illustration selection migrates without loss. Uploaded bytes require the local authenticated session and are never addressed by a caller-supplied filesystem path.

Root completed bootstrap/menu wiring, exact multipart field and actual-stream bounds, decode-before-write behavior, rollback and orphan cleanup, nullable descriptor compatibility, and preview URL ownership across replacements and unmount. Focused regressions cover these boundaries and the real App's preserved chat/draft.

## Packaging defect found through native QA

The first installed build rejected a valid PNG with a generic request error. The saved workspace and chat remained unchanged. Root reproduced the failure through the packaged UI's Sharp alias: Next's traced dependency tree omitted its matching libvips dylib and the native addon's adjacent dependency link.

The corrected staging copies the UI's installed Sharp runtime closure, reconstructs its contained relative links and records exact versions/aliases. Verification now performs an actual PNG decode, rotation, resize and WebP conversion through the Next alias using the bundled Node runtime. It rejects version mismatches and escaping links. The corrected build passed this probe before installation and then passed the actual Mac upload.

## Root-run checks

- Full UI suite: **3,828 passed, 20 existing skipped** (427 passing files; 13 skipped).
- UI typecheck, production build, runtime verification and exact-source single-app installation: passed.
- **12 packaging checks passed**, including four new native dependency graph regressions. Five installer cases initially could not resolve electron-builder in the coding checkout; the complete 12-case run passed in the dependency-equipped build worktree.
- The focused 62 UI cases are included in the full suite, not an additional total. The final packaging-only change did not change UI source; its graph tests and actual runtime conversion were run separately.
- Engine source was unchanged; its suite was not rerun for this slice. Packaging compiled the engine.

## Native board and restart acceptance

Only root operated the app and ran checks. A disposable `Logo settings QA` coworker was opened from the board, and a live Codex message produced **73**. Its unsent draft was **Keep this logo draft**.

1. A red 512×512 PNG and `Logo QA Studio` saved together. The workspace pill updated immediately; one 256×256 WebP was stored. The open chat, reply and draft remained intact.
2. Choosing a blue JPEG and another name, then Cancel, preserved the exact saved name, image identity/bytes, coworker settings, grants, messages, tabs and draft.
3. A damaged PNG and an 8 MiB+1 image were refused in the Mac dialog. Their changed names were not committed. Exact saved snapshots remained unchanged.
4. A name-only save to `Logo QA Renamed` preserved the existing image identity/bytes. Replacing it with the 512×128 JPEG stored one 256×64 WebP; the retired upload URL returned 404.
5. Full quit/reopen preserved the name, image bytes, settings, grants, messages, tabs and draft exactly. Opening the coworker from the board visibly restored **73** and the draft beside the blue workspace logo.
6. Choosing an original built-in illustration replaced the upload and left no stored upload bytes. Another full restart preserved that selection and all chat state.

Native upload acceptance used PNG/JPEG through the macOS file chooser. WebP input and drag-and-drop were not separately exercised in the native app. Chooser/drop callback lifetimes, malformed payloads, missing/understated body lengths and transaction failures have automated coverage.

## Preservation and remaining scope

Recovery copies before installation and after QA matched every workspace file byte, mode and symlink and passed database integrity. After the completed recovery copy, root restored the exact original `My workspace` name/default icon through the local settings API and removed only the named QA coworker. A final restart and identity/content comparison confirmed the original **23 chats / 88 messages**, system theme and `gpt-6.1-sol`/Medium default were unchanged. No uploaded bytes or foreign-key errors remain. The single installed app is open on the original board.

B5 remains partial for other contextual actions, unsupported panels, boxes and website logos. The checklist remains **30 feature groups**. A/B's prepared next assignments are Files previous/next navigation and existing MP4 result cards, respectively. D's pending-read and root's live collapsed-count work remain installed from the preceding accepted release.
