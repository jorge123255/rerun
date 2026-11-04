# Desktop file delete (lane handoff)

Branch `desktop/file-delete-next`. This file is the lane note. The shared parity checklist was not updated. Mac acceptance was not run.

## What was ported

Rerun’s selected-entry Delete, from the file list context menu at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `FileList.tsx` / `FileGrid.tsx`: menu item **Delete** (`Trash2Icon`, destructive), title `Delete <name>?`, file sentence “The file is deleted from the box. This cannot be undone.”, folder sentence “The folder and everything inside it are deleted from the box. This cannot be undone.”, confirm label **Delete**, cancel label **Cancel**.
- `apps/engine/src/http/routes/files.ts` `DELETE /` and `apps/engine/src/files/store.ts` `remove`. The cloud helper’s `rm(path, { recursive: true, force: true })` is **not** used.
- `AgentPanelFiles.handleDelete` closes an open file when the **basename** matches and can then sit next to sibling navigation (`useSiblingFiles`). The Mac list clears only the exact deleted path, or a path inside a deleted folder. It does not select or preview another file.

The Mac control lives on `DesktopCoworkerFiles`, not on `FileList` / `FileGrid` / `FileDetailActions`. `POST /api/desktop/agents/:agentId/files/delete` with `{ path, identity? }` calls `deleteCoworkerFile`.

## Security

Same confinement as rename: relative path only, parent opened with `openResolved`, mutations through the pinned directory (`/.vol/dev/ino` or `/proc/self/fd`), `assertUnmoved` before and after, roster write queue, coworker-not-deleting guard.

A file is renamed with `apps/desktop/native/rename-entry.c` (exclusive, nofollow, parent and source inode) to `.rerun-delete-<hex>`, then that private name is unlinked only when `lstat` still shows that regular file. A directory is inspected through `O_NOFOLLOW` directory descriptors. Symlinks, special files, and reserved `.rerun-*` recovery names refuse the whole folder before anything is removed. Ordinary files in the folder use the same stage-and-unlink. Empty directories use `rmdir` on the pinned name. There is no recursive `rm` of a workspace path.

The list entry’s `identity` (`dev:ino` of the directory entry, not a symlink target) is sent back. A different inode at that name is left in place.

An interrupted delete writes `.rerun-delete-<hex>.json` in the parent before the first removal. The next list or read of that parent finishes only the journaled inodes. The journal records the workspace inode. Recovery does not resume when the folder is listed under a different coworker workspace. `RERUN_FILE_DELETE_CRASH=staged` throws after the private rename and before the unlink. It is unset in the app. It does not send `SIGKILL`.

## Attachments and the editor

Composer drafts and queued-message payloads are not rewritten. A saved engine attachment snapshot is not updated; this lane does not write chat rows. The deleted path is not replaced with a sibling. A composer that still stores the old path gets a missing-file read, not another file’s bytes. A new file later created at that same path can still be read on send, because the composer stores a path. That module was not changed.

Delete is not in the preview or the editor. Those screens replace the list, so an open edit cannot confirm a delete. Closing a dirty editor still uses the existing discard prompt. A save of a path that was deleted returns the existing not-found conflict and does not create the file.

## Owner checks (not run here)

Disposable fixtures only. Do not point this at a real coworker workspace.

- Confirm and Cancel for a file and for a folder. Cancel must not change the directory.
- Delete one file. The sibling, the other coworker’s same name, and `keep.txt` outside the folder stay. Restart the app and list again.
- Delete a folder of ordinary files. A symlink anywhere inside must fail with the folder unchanged.
- Replace the inode after the list and confirm. The new file stays.
- Set `RERUN_FILE_DELETE_CRASH=staged` for one delete, then list the folder with the variable unset. The private name and the journal should be gone. The sibling should remain.
- With a composer draft and a queued payload pointing at the deleted path, both rows stay byte-for-byte. The path does not become the sibling.

`apps/ui/node_modules/next/dist/docs/` is not installed. The route follows the existing desktop handlers (`dynamic = 'force-dynamic'`, `params` as a Promise, `desktopRoute`). Dependencies were not installed. Tests, typecheck, lint, build, and the Mac UI were not run.

## Limits

- A folder with a symlink, a special file, a reserved recovery name, more than 10,000 entries, or nesting deeper than 64 levels is refused and left unchanged.
- A crash or a new file during a folder delete can leave a partially removed folder. Newer inodes are not deleted. The journal retries only the inodes it recorded.
- After the exclusive rename, unlink of the private name is not atomic with the `lstat` that checks its inode.
- A corrupt `.rerun-delete-*.json` is not deleted. A folder that still contains one cannot be deleted until that journal is recoverable.
- File delete and non-empty folder delete need `RERUN_DESKTOP_RENAME_HELPER`. If it is missing, the route returns 503 and does not stage the entry. An empty folder does not need the helper.
- The native helper was not modified or recompiled.
