# E — Shared File rename inside Company Brain
Base/parent: 7080add37a60bd604965649319143b8211818fd9
Base tree: e7db3a3f5df8057ffe86576153a8acff3360481b
Branch: desktop/next-e-brain-file-rename
Worktree: /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-e-brain-file-rename

Original reference c33c020ffb33263ec29de6f76d9b269bca786d90:
apps/ui/components/brain/BrainFiles.tsx BrainFolderView wires inline rename and refresh(path).
apps/ui/components/files/FileList.tsx owns the menu and inline name editor.

Confirmed mounted gap: DesktopBrainFolder used FileList without onRename, although standalone apps/ui/components/desktop/DesktopSharedFiles.tsx already used renameDesktopSharedFile.
Changed:
- apps/ui/components/desktop/brain/files/DesktopBrainFiles.tsx
- apps/ui/components/desktop/brain/pages/DesktopBrainPanel.tsx (folder key follows existing workspace token)
- apps/ui/components/desktop/brain/files/DesktopBrainFiles.rename.test.tsx
- this handoff

Reuses existing authorized renameDesktopSharedFile in apps/ui/lib/desktop/shared-workspace-files.ts and its route. Collision, path and workspace checks stay there. File-only menu and callback validation reject directories. Uses draft write admission/shutdown gate, concurrent guard, abort on navigation/unmount/workspace remount, and exact-folder refresh on acknowledgement. No optimistic path rewrite. Shared tree refresh updates knownFiles and siblings. Brain's existing authorizedSharedFilePath refuses old links after refresh; the existing preview reader safely errors for missing paths. No redirect/reference rewriting or move/delete.

Integration: existing DesktopBrainPanel folder mount passes all current props. Narrow workspace key remount prevents a pending rename from painting into a new workspace. No DesktopApp/central mount change. File preview routing stays with current selection and reads the selected path; old missing paths are not rebound to the renamed file.

Authored offline mounted regression: file menu enabled/directory refused, exact path and AbortSignal forwarded, exact folder refresh, stale page link inert after refresh, collision does not optimistically refresh. Existing standalone rename and route tests remain relevant. Root should add/exercise two-window races, pending rename during workspace switch/quit, and preview missing-file cases using the existing endpoint fixtures.

Root board QA: Brain > Files > nested folder > file menu > Rename, reopen new file and verify preview/siblings; old saved page link must fail safely. Repeat root folder, collision, invalid name, directory menu absent, navigate away while pending, switch workspace, Quit during pending write. Cold restart retains renamed disk path; old references remain unchanged/inert. No directory rename, moving, delete or reference rewriting.
Tests/builds/Mac QA UNRUN. Installed Next docs absent; no new Next API or route introduced. No live accounts, install, VM change, push or PR.
