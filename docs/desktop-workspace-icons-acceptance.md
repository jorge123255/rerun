# Workspace illustrations: Mac acceptance

Root accepted the installed Mac source `6fdf5f060b68a0c2d432c77f68c794d0abf8177f` on November 4,
2026. This includes the previously accepted A/B/D source `50e0abd`; its detailed evidence is in
`desktop-files-done-acceptance.md`. Only root executed tests, packaging, installation and native QA.

## Source and design

C's clean handoff `5a639cd4e519cc154f8c060dc95bafff9d4407ea` was cherry-picked into the coding
worktree after it became available. C's external worktree was preserved. The 50 catalog entries,
order, filenames, descriptions, colors and forms match original Rerun
`a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. All 50 local WebP assets have complete RIFF/WebP
containers. Native inspection displayed the full original grid and selected check badge.

The dialog follows `WorkspaceSettingsDialog`, uses the shared dialog/input/footer components,
and supplies the bundled illustration to the original workspace pill. Uploads and website logos
remain outside this port. Root connected bootstrap/menu/App state and replaced the initial two
writes with one atomic name/icon transaction. Failed saves cannot leave an unintended rename.
Save participates in the existing quit barrier; stale requests cannot modify a reopened form.

## Root verification

- Focused API, component and actual-App integration: **23 passed**.
- Full UI at the installed source: **3,620 passed, 20 existing skips**, 411 passed files and
  13 skipped files. Focused cases are included, not added again.
- UI typecheck and production packaging/runtime verification passed at the installed source.
- Engine source did not change after A/B/D's **3,063 passed** run. It compiled again during
  packaging; no second engine test run is claimed for this UI/workspace-only slice.

An initial integration test reopened the menu before Radix finished deferred close-focus
restoration. The fixture now waits for both full dialog removal and focus return. The native
Cancel/reopen path below also passed. The description uses the shared accessible DialogDescription.

## Native board and restart acceptance

1. Created one disposable coworker without seeded chats or replies. Opened it from the board and
   sent “What is 17 plus 25? Reply with just the number.” Signed-in Codex (`gpt-6.1-sol`) replied
   **42** in the side panel. Left the unsent text **Keep this workspace draft** in its composer.
2. Opened Workspace settings from the board menu. Changed name and illustration, cancelled,
   and reopened. Neither change persisted; the board, reply and unsent draft remained.
3. Expanded all 50 illustrations, selected **Emerald-green glass knot**, entered **Workspace
   design QA**, and saved. The pill icon and board label updated together while the chat and
   unsent draft stayed available.
4. Fully quit and restarted. Compared exact saved workspace name/icon, chat and message
   identities/content, tabs, drafts and completion rows against the pre-restart snapshot: unchanged.
   Reopened the coworker from the board and saw 42 and the exact saved draft. Closing returned
   to the board. Actions showed Nothing to handle, retaining the visible-chat read receipt.
5. Reopened the picker and confirmed the selected green illustration. Saved only the original
   name, **My workspace**; the chosen icon remained unchanged. Restored the original default
   icon through the atomic settings endpoint, then fully quit.
6. Created a byte-verified full workspace recovery copy while quit, restarted again, then used the native
   exact-name confirmation to delete only the disposable coworker. Its folder was absent and
   foreign-key checks passed. The original name, icon, provider/model/reasoning defaults and
   all original **23 chats / 88 messages**, including exact identities and contents, were preserved.

The single installed app is `/Users/gszulc/Applications/Rerun Desktop Preview.app`; no additional
preview was published. The coding branch is `desktop/m1`; the clean `codex-login-build` worktree
produced the app. No remote push was performed.
