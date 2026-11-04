# Desktop file delete (lane handoff)

Original lane: `desktop/file-delete-next`. Integration review adds the deletion recovery and directory guards described below. The integration owner runs all checks and Mac acceptance; this source handoff does not claim those results.

## What was ported

Rerun’s selected-entry Delete, from the file list context menu at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `FileList.tsx` / `FileGrid.tsx`: menu item **Delete** (`Trash2Icon`, destructive), title `Delete <name>?`, file sentence “The file is deleted from the box. This cannot be undone.”, folder sentence “The folder and everything inside it are deleted from the box. This cannot be undone.”, confirm label **Delete**, cancel label **Cancel**.
- `apps/engine/src/http/routes/files.ts` `DELETE /` and `apps/engine/src/files/store.ts` `remove`. The cloud helper’s `rm(path, { recursive: true, force: true })` is **not** used.
- `AgentPanelFiles.handleDelete` closes an open file when the **basename** matches and can then sit next to sibling navigation (`useSiblingFiles`). The Mac list clears only the exact deleted path, or a path inside a deleted folder. It does not select or preview another file.

The Mac control lives on `DesktopCoworkerFiles`, not on `FileList` / `FileGrid` / `FileDetailActions`. `POST /api/desktop/agents/:agentId/files/delete` with `{ path, identity? }` calls `deleteCoworkerFile`.

## Security

Same confinement as rename: relative path only, parent opened with `openResolved`, mutations through the pinned directory (`/.vol/dev/ino` or `/proc/self/fd`), roster write queue, coworker-not-deleting guard. Every opened recursive directory receives its own canonical-path, inode and workspace-identity guard composed with its ancestor guards. Traversal, staging, recovery, unlink and directory removal repeat those checks. Moving a nested open directory into another workspace therefore stops further mutations through its descriptor.

A file is renamed with `apps/desktop/native/rename-entry.c` (exclusive, nofollow, parent and source inode) to `.rerun-delete-<hex>`, then that private name is unlinked only when `lstat` still shows the expected regular file. A directory is inspected through `O_NOFOLLOW` directory descriptors. Symlinks, special files, and reserved `.rerun-*` recovery names refuse the whole folder before anything is removed. Ordinary files in the folder use the same stage-and-unlink. Empty directories also move exclusively to a journaled private name; removal checks that moved directory's identity and emptiness before `rmdir`. A newer empty directory at the public name is preserved. There is no recursive `rm` of a workspace path.

The list entry’s `identity` (`dev:ino` of the directory entry, not a symlink target) is sent back. A different inode at that name is left in place.

The selected-entry journal records the original tree and workspace identity before removal. Each native staging move has a separate version-2 `.rerun-delete-<hex>.json` sidecar in its immediate parent. It records the exact private name, expected inode, parent and workspace identities, and a preallocated visible recovery name. The sidecar and its parent directory are synced before the move. These immutable names also cover recovery moves without needing to rewrite a journal in place.

An `ESTALE` helper error can still leave a replacement inode at the private destination. The caller inspects that exact recorded name even when the helper fails. A newer staged file or directory is restored to its public name if free, or exclusively moved to `delete-recovery-<hex>` with its file extension; neither move replaces an arriving entry. The request reports the conflict and visible location. If ownership is lost or recovery cannot finish, staged data and its intent remain. An identity mismatch never permits deleting the sidecar while a private entry remains. Recovery under another coworker's workspace refuses the recorded workspace identity.

The next list or read resumes expected staged entries, subject to the same guards. Unknown private staging names from an older or incomplete journal are retained instead of guessed from inode alone. `RERUN_FILE_DELETE_CRASH=staged` throws after a private rename and before unlink or `rmdir`. It is unset in the app and does not send `SIGKILL`.

## Attachments and the editor

Composer drafts and queued-message payloads are not rewritten. A saved engine attachment snapshot is not updated; this lane does not write chat rows. The deleted path is not replaced with a sibling. A composer that still stores the old path gets a missing-file read, not another file’s bytes. A new file later created at that same path can still be read on send, because the composer stores a path. That module was not changed.

Delete is not in the preview or the editor. Those screens replace the list, so an open edit cannot confirm a delete. Closing a dirty editor still uses the existing discard prompt. A save of a path that was deleted returns the existing not-found conflict and does not create the file.

## Owner checks (not run here)

Disposable fixtures only. Do not point this at a real coworker workspace.

- Confirm and Cancel for a file and for a folder. Cancel must not change the directory.
- Delete one file. The sibling, the other coworker’s same name, and `keep.txt` outside the folder stay. Restart the app and list again.
- Delete a folder of ordinary files. A symlink anywhere inside must fail with the folder unchanged.
- Replace the inode after the list and confirm. The new file stays.
- Model a helper `ESTALE` after a replacement actually moved to the private name and another file occupied the original name. Both arrivals and the original held bytes stay; the staged replacement becomes a visible recovery file, including after reopening the database.
- Move an opened nested folder into another coworker's workspace during interrupted-delete recovery. Neither the old parent's listing nor the new owner's listing removes its remaining bytes.
- Replace an empty directory immediately before its native staging rename. The replacement and the held original directory both stay.
- Set `RERUN_FILE_DELETE_CRASH=staged` for one delete, then list the folder with the variable unset. The private name and the journal should be gone. The sibling should remain.
- With a composer draft and a queued payload pointing at the deleted path, both rows stay byte-for-byte. The path does not become the sibling.

The route follows the existing desktop handlers (`dynamic = 'force-dynamic'`, `params` as a Promise, `desktopRoute`). The integration owner runs tests, typecheck, build and Mac UI checks; source helpers do not execute them or install dependencies.

## Limits

- A folder with a symlink, a special file, a reserved recovery name, more than 10,000 entries, or nesting deeper than 64 levels is refused and left unchanged.
- A crash or a new file during a folder delete can leave a partially removed folder. Newer inodes are not deleted. The journal retries only the inodes it recorded.
- After the exclusive rename, unlink or `rmdir` of the private name is not atomic with its preceding identity and ownership checks. The public-name replacement window is closed by staging; this is not an inode-conditional unlink syscall.
- A corrupt `.rerun-delete-*.json` is not deleted. A folder that still contains one cannot be deleted until that journal is recoverable.
- All new file and folder deletes, including empty folders, need `RERUN_DESKTOP_RENAME_HELPER`. If it is missing, the route returns 503 before creating a deletion journal or staging the selected entry.
- The native helper was not modified or recompiled.
