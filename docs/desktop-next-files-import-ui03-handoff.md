# UI03 — coworker Files multi-file import

Source delivery only. This is not Mac acceptance and not a PASS.

## SHAs

- Base: `8297fe6404caa114dcb0c2cd6006291a8abb2038` (`desktop/finish-cloud-base-20261106-8297fe64`)
- Implementation: `f26e1a4fd724882ffc997465a3921e22a0484069`
- Branch: `desktop/next-files-import-ui03`
- This file is the commit after that implementation. It does not record its own SHA.
- Original, read only: `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (`upstream-review-20261106`)
- Supplement `ab3def9bfcf545cc9548f99c63c2b011ca094023`: not consumed
- Cloud integration `bc-714cd9be-c9ad-5527-b2ed-6e79b2a13a08`: not consumed
- Hook-stop: none. `core.hooksPath` was unset and `.git/hooks` contained only `*.sample`. The implementation commit was created. `--no-verify` was not used.

## Original citations

Read at `2a57fa6dd53311f763bfc9abde85997b7f7e5309`:

- `apps/ui/hooks/useFileUploads.ts` — statuses `queued | uploading | finishing | done | error`; concurrency 3; progress publish at most every 100ms; one request per file; one automatic retry only when the error is not `UploadHttpError` and `attempt === 0`, delayed 1000ms; HTTP refusals stay `error` until manual `retry`; cancel aborts and deletes the job; `clearFinished` drops `done`; oversize uses `MAX_UPLOAD_FILE_BYTES` and does not drop siblings.
- `apps/ui/hooks/usePanelUploads.ts` — directory reload debounced 500ms, and only when the finished file’s directory is the open path.
- `apps/ui/components/ui/file-upload-menu.tsx` — `multiple` file input and a second input with `webkitdirectory`.
- `apps/ui/lib/files/upload.ts` — `UploadEntry`, `webkitRelativePath` as `subDir`, `entriesFromDataTransfer`.
- `apps/ui/lib/files/path-guards.ts` — `invalidName` / `invalidDir` refuse separators and `..`.
- `apps/ui/components/agent/AgentPanelFiles.tsx` — drop calls `uploads.enqueue(entries, currentPath)`; the menu does the same. Chat is a different caller of `useFileUploads` and was not retargeted.
- `apps/ui/components/ui/upload-tray.tsx` — per-file progress, retry, cancel.
- `packages/contracts/src/file.ts` — `MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024`.

The original upload engine has no extension denylist.

Desktop gap on this base (not edited):

- `apps/ui/components/desktop/DesktopCoworkerFiles.tsx` — one input, `accept=".txt,.md,text/plain,text/markdown"`, `importFile` posts a single `File`.
- `apps/ui/app/api/desktop/agents/[agentId]/files/route.ts` — `POST` requires exactly one file and `IMPORT_BYTES` (1 MB), then `importCoworkerFile`.
- `apps/ui/lib/desktop/server/coworker-files.ts` — `IMPORTABLE` is `.txt`/`.md`; `importFile` refuses other names, refuses a leading dot, and publishes with `link(2)`.

## Changed paths

- `apps/engine/src/desktop/files-import/errors.ts`
- `apps/engine/src/desktop/files-import/paths.ts`
- `apps/engine/src/desktop/files-import/publish.ts`
- `apps/engine/src/desktop/files-import/index.ts`
- `apps/engine/src/desktop/files-import/paths.test.ts` (authored, not run)
- `apps/engine/src/desktop/files-import/publish.test.ts` (authored, not run)
- `apps/ui/components/desktop/files-import/paths.ts`
- `apps/ui/components/desktop/files-import/types.ts`
- `apps/ui/components/desktop/files-import/queue.ts`
- `apps/ui/components/desktop/files-import/queue.test.ts` (authored, not run)
- `apps/ui/components/desktop/files-import/entries.ts`
- `apps/ui/components/desktop/files-import/menu.tsx`
- `apps/ui/components/desktop/files-import/tray.tsx`
- `apps/ui/components/desktop/files-import/hook.ts`
- `apps/ui/components/desktop/files-import/surface.tsx`
- `apps/ui/components/desktop/files-import/fragment.ts`
- `apps/ui/components/desktop/files-import/index.ts`
- `docs/desktop-next-files-import-ui03-handoff.md`

Not changed: `coworker-files.ts`, the Files route, `DesktopCoworkerFiles`, `DesktopApp`, `DesktopConversation`, chat composer, `useFileUploads`, contract barrels, grant enums, migration numbering, packaging.

## Behavior and limits

- The new queue accepts many files and a folder (`webkitdirectory` / drop). Paths land under the open folder plus `subDir`.
- Cap is `MAX_UPLOAD_FILE_BYTES` (100 MB), the original upload cap. The mounted one-file route remains 1 MB `.txt`/`.md` until root applies the fragment.
- Concurrency is 3. A dropped writer error (`code: 'dropped'`, or an unknown error) is queued again once, after 1000ms. `http`, `clash`, `reserved`, `executable`, `unsafe_path`, `too_large`, `outside`, `other_user`, `unavailable`, and `unconfirmed` do not auto-retry. Manual `retry` resets the attempt and runs the checks again.
- Cancel removes the job. It is not success and it does not auto-retry. Stop or an unconfirmed link is not success.
- `saved: true` only after `publishFilesImport` confirms the linked inode and size, and the returned path is the requested path. The tray says `Imported` only then. Settlement text says `imported` only when every item is saved.
- A confirmed save in the open directory calls `onFileSaved` once, 500ms after the last such save. Other directories do not.
- Publisher writes into a directory whose basename is `workspace`. It creates that directory only when its parent already exists. It does not create the agent directory. Child directories are created one segment at a time. `EEXIST` does not mark a directory as created. Failure removes only directories this call created.
- Publication is `link(2)` from `.rerun-import-<hex>`, mode `0o644`. An existing name, including a symlink, is left in place (`clash`). Staging is unlinked after the opened handle’s dev/ino matches that name. An identity mismatch after the link rolls the new name back when it is still that inode, then throws `unconfirmed`.
- No archive unpack, no execute, no network, no new listener, no route registration.
- Desktop also refuses launchable names the original uploader would accept: `app`, `bat`, `bash`, `cmd`, `com`, `command`, `csh`, `dll`, `dylib`, `exe`, `fish`, `ksh`, `msi`, `ps1`, `scr`, `sh`, `so`, `zsh`. `.js` and other source names stay importable. Ordinary hidden names such as `.gitignore` and `.cache` stay importable.
- Reserved at every depth, after NFKC lowercasing: a segment starting with `.rerun`, `.rerun-skill`, or `internal.rerun`. That covers `.rerun-import-*`, `.RERUN-skill-*`, and `internal.rerun*`.

## Receipt types

```ts
type FilesImportStatus = 'queued' | 'uploading' | 'finishing' | 'done' | 'error'

type FilesImportItem = {
    id: string
    name: string
    dir: string
    path: string
    size: number
    status: FilesImportStatus
    loaded: number
    progress: number
    etaMs: number | null
    error: string | null
    saved: boolean
    code: FilesImportCode | null
}

type FilesImportBatchReceipt = {
    items: FilesImportItem[]
    savedCount: number
    failedCount: number
    active: boolean
}

type FilesImportPublication = { saved: true; path: string; bytes: number }
```

`FilesImportPublication` is returned only for a confirmed link. Refusals throw `FilesImportError` (`status`, `code`, `kind`). `kind` is `unconfirmed` or `aborted` for those two codes, otherwise `http`.

## Root fragment

Apply in `DesktopCoworkerFiles`. Do not point the chat composer, `QuestionForm`, or `useFileUploads` at this queue. Leave `importCoworkerFile` and the one-file `POST` in place until this mount replaces the button.

```tsx
const imports = useFilesImportQueue({
    rootDir: currentPath,
    disabled: pending || importing || loading || busy || !!error,
    write,
    onRejected: message => setNotice({ ok: false, folder: currentPath, text: message }),
    onFileSaved: () => { void reload() },
})

// Replace the accept=".txt,.md" input and the Import file button:
<FilesImportMenu onPick={imports.enqueueEntries} disabled={pending || importing || loading || busy || !!error} />

// On the panel container:
onDragOver={imports.onDragOver}
onDragLeave={imports.onDragLeave}
onDrop={imports.onDrop}
// When imports.dragOver, show: Drop files or folders to import

<FilesImportTray items={imports.items} onCancel={imports.cancel} onRetry={imports.retry} onDismiss={imports.dismiss} />
```

`write` is injected from the server. The client bundle must not import `publishFilesImport` (it uses `node:fs`). No route was added.

```ts
import { publishFilesImport } from '../../../../apps/engine/src/desktop/files-import/index.ts'
import { filesImportWriter } from '@/components/desktop/files-import/fragment'

const write = filesImportWriter(
    (workspaceRoot, request) => publishFilesImport(workspaceRoot, request.path, request.bytes, request.signal, request.onProgress),
    workspaceRoot,
)
```

`workspaceRoot` is the canonical `…/agents/<engineAgentId>/workspace` for the open coworker. Rebuild `write` when that root changes. `filesImportWriter` is the binder in `fragment.ts`.

Unsafe paths throw before a write, from both `admitFilesImportPath` (client) and `filesImportParts` (publisher):

- `Path escapes the root: …` (`unsafe_path`, 400) for absolute paths, `..`, empty segments, separators, NUL, and controls.
- `That path is reserved.` (`reserved`, 400).
- `That file type can’t be imported.` (`executable`, 415).
- `This file is larger than the 100 MB upload limit.` (`too_large`, 413). The queue reports the original oversize sentence and does not enqueue those siblings’ names into the writer.
- `This folder already has a file named “<name>”. The existing file was kept; rename yours and import it again.` (`clash`, 409).
- `That path is outside this coworker’s workspace.` (`outside`, 400).
- `This file belongs to another user. It was left unopened.` (`other_user`, 403).
- `The file import result could not be confirmed. Check Files before retrying.` (`unconfirmed`, 500).
- `Import cancelled.` (`aborted`). The queue deletes the job.

## Authored unrun regressions

Not executed. No test runner, typecheck, lint, or fixture was started.

- `apps/ui/components/desktop/files-import/queue.test.ts` — sibling HTTP failure stays failed while the other file is saved; folder path `docs/sub/a.txt`; oversize sibling is not read; `.gitignore` is saved and `.rerun` / `.RERUN-skill` / `internal.rerun*` are not written; `..`, absolute, `.exe`, and `Foo.app` are refused while `script.js` is saved; a dropped error retries once then stays `dropped`; clash and unconfirmed do not auto-retry; manual retry records progress and `saved`; cancel removes the in-flight job and the queued sibling without a second call; reload predicate requires `saved` in the open directory.
- `apps/engine/src/desktop/files-import/paths.test.ts` — the same path rules, plus the 100 MB numeric cap without allocating the buffer.
- `apps/engine/src/desktop/files-import/publish.test.ts` — nested bytes, mode without an execute bit, no leftover `.rerun-import-*`, missing `workspace` created only under an existing parent, clash keeps bytes including a symlink name, a directory symlink does not receive the file, unsafe paths create no directory, a pre-aborted signal writes nothing. The temp parent must be `realpath(tmpdir())` because `/var` is a symlink on this Mac.

## Checks not run

Tests, typecheck, lint, build, install, formatters, fixtures, UI, browser, native app, live DB, Keychain, listeners, accounts, permission prompts, restart, guest, Docker, microphone, network. No push, no PR.

## Risks

- The panel still imports one `.txt`/`.md` until root mounts the fragment and supplies `workspaceRoot`.
- The client path copy and the engine path copy can drift. The publisher checks again.
- A cancel that loses the race after `link(2)` can leave the file while the tray drops the job. If the signal is already aborted inside the publisher after the link, it tries to unlink that inode and does not return `saved`.
- An inode mismatch after the link is `unconfirmed` and is not auto-retried. No regression forces that mismatch.
- The other-user uid branch is implemented and not exercised.
- `.sh` and the other launchable extensions above are refused. The original web uploader would enqueue them.
- There is no HTTP route for this publisher. A browser `fetch` of the existing `POST` still hits the 1 MB text importer.

## Status

- New, in this commit’s parent: queue, menu, tray, drop hook, and the confined publisher.
- Already present and left mounted: single-file `.txt`/`.md` import.
- READY for root to apply the fragment.
- GATED on that mount and on a server-side `workspaceRoot`. Central Files route auth stays with cloud714.
- WAITING on the integration owner for tests, typecheck, lint, build, and Mac QA.
- Not installed acceptance. No PASS.
