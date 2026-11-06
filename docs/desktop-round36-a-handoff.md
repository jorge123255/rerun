# Round 36 A — shared-file write, edit, and search

Checklist D6 / E2, the unclaimed shared write, exact edit, and search. Source only. Root owns the barrel, grant catalog, tool registry, route, schema ladder, both binders, every check, and installed Mac acceptance. No test, typecheck, lint, build, install, server, network call, packaging, or native Mac check was run. This is not Mac acceptance. D6 and E2 are not marked complete. The accepted shared reader and the general Files panel were not edited.

Worktree `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round36-shared-file-mutations`, branch `desktop/round36-shared-file-mutations`, base `970415507e28824bb001f46c8537d20fd2636b1c`. Pinned original `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` is an ancestor of that base. Round 35 (`c85204f` on `desktop/round35-company-discovery`) was not amended and that worktree was not touched.

## Commit

Implementation commit: `b37039967b53f50564c2a2ca2c6ee47febba85c1`

That commit is the parent of the one-line recording commit that wrote this SHA. `git rev-parse HEAD` on this branch is the recording commit. `git status --short` was empty before the implementation commit. No push, merge, rebase, or amend.

## Contract

`packages/contracts/src/desktop-shared-file-mutations.ts`. `DESKTOP_SHARED_FILE_MUTATIONS_CONTRACT_VERSION` is `1`. No earlier shared-mutation contract exists on this base. The barrel `packages/contracts/src/index.ts` was not edited. New symbols are imported from `@rerun/contracts` and fail typecheck until root adds the export below and rebuilds `packages/contracts`. Do not replace those imports with a relative path outside the engine `rootDir`.

`workspaceId` is a positive integer at most `1_000_000`, the same bound as `desktopWorkspaceIdSchema` in the canonical workspace contract. This worktree does not contain `packages/contracts/src/desktop-workspaces.ts`. This file does not define a second catalog and does not read `catalog.json`. `LEGACY_DESKTOP_WORKSPACE_ID` is `1`. On this base `DesktopRuntime.workspaceId` is `z.literal(1)` and must not be the only identity.

## Original source mapping

Hosted shared tools are `sharedTools` in `apps/engine/src/tools/builtin/shared.ts`: `makeFsTools({ prefix: 'shared', rootDir: sharedDir() })`. Names preserved: `shared_read`, `shared_write`, `shared_list`, `shared_edit`, `shared_search`. There is no delete.

| Original | This desktop |
| --- | --- |
| `shared_write` overwrites and creates parent directories | `shared_write` creates `.txt` / `.md` only, never overwrites, and may create parents inside the shared root. Cap 256 KiB UTF-8. Message uses the UTF-8 byte length. The original message uses the JavaScript string length. |
| `shared_edit` exact `oldString` / `newString`, `replaceAll` default false | Same match rule, plus required `expectedBytes` and `expectedSha256` of the raw file. A mismatch is a conflict and the file is kept. Identical strings after a matching hash return unchanged and do not write. Newlines and a BOM are not normalized. |
| `shared_search` JavaScript regex, `path:line: content`, snippet 300, default 200 hits, max 1000, skips `node_modules` and `.git` | Same shape and snippet length. Default 50, max 100. Skips `node_modules` and `.git`. Does not use `apps/engine/src/files/store.ts` `searchText` or `writeText` (`writeText` follows symlinks). |
| `shared_read`, `shared_list` | Stay on the accepted reader. This lane does not register them again. |
| No delete, no chmod, no binary write | Still absent. |

Accepted reader, not edited: `apps/engine/src/desktop/shared-file-tools.ts` registers only `shared_read` and `shared_list`. Grant is `sharedFilesRead`, `tools.shared !== false`, and the coworker enabled (`desktopSharedFilesAllowed` in `shared-file-grant.ts`). Root is `resolveEngineSharedDirectory(realpath(dataDir()))`. `docs/desktop-round27-acceptance.md` closes D6 for read, list, and private isolation only, and says that close is not shared write, edit, or search. `apps/engine/src/desktop/shared-file-tools.test.ts` still expects the keys `shared_list` and `shared_read` only. Do not add mutation keys there.

Confinement reused from `apps/engine/src/desktop/shared-workspace-files.ts`, not loosened and not edited: basename `shared`, no symlink parents, uid is `process.getuid()`, `nlink === 1`, `O_NOFOLLOW_ANY` (`0x20000000`) on darwin, path part `/^[^/\\.\0][^/\\\0]{0,240}$/` so dotfiles and `.git` are skipped, text names `/\.(txt|md)$/i`, depth 32 for mutations, path length 4096. `importSharedText` creates parents and never overwrites (409 keeps the existing file, 1 MB cap, stage `.rerun-shared-import-*`, `renameSkillEntry` refuses to replace an arrival so it cannot implement edit). `listSharedDirectory` limit 512. `readSharedText` pages `TEXT_FILE_PAGE_CHARS` (100_000). Mac-only when `getuid` is missing. UI helper `desktopEngineSharedDirectory` hardcodes `workspaces/1/engine/shared` and is not used for other workspaces.

Canonical shared root, read from the integration tree and not copied as a second parser: `{dataRoot}/workspaces/{id}/engine/shared`, matching `engineRootFor` plus `/shared`. `canonicalSharedRoot` and `assertCanonicalSharedRoot` check that shape, basename, uid, and that the path is not a symlink.

Private file receipts (`desktop_private_file_calls`, engine POST to the app) are the pattern. That lane stays separate (`docs/desktop-private-file-write-tools.md`). `privateFileWrite` does not grant shared write. Shared write does not require `filesystem`.

Chat labels already exist in `packages/contracts/src/chat-tool-display.ts` (`Write Shared File`, `Edit Shared File`, `Search Shared Files`) and icons in `apps/ui/lib/tool-meta.ts`. Those files were not edited. `systemPrompt.ts` was not edited.

## Inventory

Owned and committed:

- `packages/contracts/src/desktop-shared-file-mutations.ts`
- `apps/engine/src/desktop/shared-file-mutations/fs.ts`
- `apps/engine/src/desktop/shared-file-mutations/grants.ts`
- `apps/engine/src/desktop/shared-file-mutations/tools.ts`
- `apps/engine/src/desktop/shared-file-mutations/index.ts`
- `apps/engine/src/desktop/shared-file-mutations/fs.test.ts` (unrun)
- `apps/engine/src/desktop/shared-file-mutations/tools.test.ts` (unrun)
- `apps/ui/lib/desktop/server/shared-file-mutations/authority.ts`
- `apps/ui/lib/desktop/server/shared-file-mutations/store.ts`
- `apps/ui/lib/desktop/server/shared-file-mutations/publisher.ts`
- `apps/ui/lib/desktop/server/shared-file-mutations/server.ts`
- `apps/ui/lib/desktop/server/shared-file-mutations/index.ts`
- `apps/ui/lib/desktop/server/shared-file-mutations/publisher.test.ts` (unrun)
- `docs/desktop-round36-a-handoff.md`

Engine fs creates, edits, and searches. Grants read the raw `desktopToolGrants` object: `sharedFilesRead` is search, `sharedFilesWrite` is create and edit. Neither implies the other. `tools.shared === false` or `enabled` false blocks both. UI publisher keeps sqlite receipts. Search stays in the engine and writes no receipt.

Receipt key is `workspace_id + owner + run_id + call_id`. Digest is sha256 of JSON `[workspaceId, engineAgentId, sessionId, runId, tool, arguments]` and does not include the call id. States: `claimed`, `saved`, `unchanged`, `refused`, `uncertain`. Terminal rows are not evicted. The same digest replays the row and does not write. A different digest for the same call throws `Tool call identity was reused`. Conflict, exists, not-found, malformed, outside, symlink, and oversized are stored `refused`. Abort before claim throws and inserts nothing. Abort after claim and before a committed write stores `uncertain`, and replay does not write. If the outcome says `committed: true`, the row is `saved` even when Stop has already aborted. A committed write whose `finish` fails is `uncertain` and is not repeated. Create: if `importSharedText` throws and the destination bytes already match, the result is `saved` and the message still says `Wrote`. A 409 with different bytes is `refused` / `exists`. Abort with no matching bytes is `uncertain`. Import is not called again.

Edit is in place: `O_RDWR` plus `O_NOFOLLOW_ANY` on darwin, otherwise `O_NOFOLLOW`, after a dev/ino/nlink/uid recheck, then fsync and read-back. A crash can tear the file. The receipt stays `uncertain`. This slice has no atomic exchange. If darwin rejects `O_RDWR | O_NOFOLLOW_ANY`, root fixes the flag combination. Do not drop no-follow. `renameSkillEntry` cannot replace an existing file. `acquireSkillLease` error text says “Skills”. `skill-publication-native.ts` was not edited. A `SkillBoundaryError` is not a `SharedMutationError`, so the publisher stores `uncertain`.

Search uses `listSharedDirectory` and `readSharedText` only. A path ending in `.txt` or `.md` searches that file. Other paths are directories. Files `readSharedText` marks truncated are omitted as `too-large` and are not partially matched. Lines longer than 4000 characters are omitted with no hit. Output is `path:line: snippet`. Caps: 200 files, depth 8, pattern 200, snippet 300. `pattern.lastIndex` is reset before each line. An invalid regex throws `SharedMutationError('malformed')` and the tool turns that into `Error`. An empty missing root is no matches. `node_modules` and `.git` are skipped from `.`. A start path that itself contains those names or a dotfile is refused by `partsOf` before any read. Search never opens a path outside the shared root. `listSharedDirectory` skips symlinks, so a symlink is not searched. Edit lstats the symlink and returns `refused` / `symlink` before open.

Mutations POST `http://127.0.0.1:{port}/api/desktop/engine/shared-file-mutations` with bearer `RERUN_API_KEY`, body cap 2 MiB, response cap 16384, redirect `error`, credentials `omit`. Non-success `uncertain` or `refused` is HTTP 409 and the tool throws `result.message`. `saved` and `unchanged` are HTTP 200 and the tool returns `JSON.stringify(result)`. Edit success copy matches the original: `Edited ${path} (${occurrences} replacement(s))`. Unchanged copy: `oldString and newString are identical; nothing to do.` If the workspace port is unbound, execute throws `Shared file workspace authority is unbound.` before fetch or search. Tools may still be registered when the grant is on.

`shared_read` still does not return a hash. A conflict message returns the current byte length and sha256. The first edit cannot run until the caller knows that hash.

## Unrun regressions

Not executed.

`apps/engine/src/desktop/shared-file-mutations/fs.test.ts`

- `a read grant is not a write grant`
- `both coworkers see the shared note and neither search sees a private file` (shared `note.txt`, private `PRIVATE-SENTINEL`, `node_modules`, symlink out of the shared root)
- `create does not overwrite, a bad path writes nothing, and stop writes nothing` (`../outside.txt` writes nothing)
- `edit keeps the file on a hash conflict and preserves newlines` (CRLF kept; symlink edit refused; private file unchanged)

Tests in that file share one temp root and assume declaration order. The symlink used by the edit test is created by the search test.

`apps/engine/src/desktop/shared-file-mutations/tools.test.ts`

- `a read grant registers search and does not register write tools`
- `a write grant registers create and edit and does not register search`
- `neither grant, a disabled coworker, or tools.shared false registers nothing`
- `both grants register search and the two mutation tools`

This file imports `tools.ts`, which imports the new contract symbols. It does not execute search.

`apps/ui/lib/desktop/server/shared-file-mutations/publisher.test.ts`

- `the same tool call publishes once and the replay does not write`
- `a refused conflict replays without another write`
- `a malicious path is stored refused and is not written again`
- `abort after claim and before publication is uncertain and replay does not write`
- `a committed write stays saved when Stop arrives after the bytes are published`
- `a changed body reuses the tool call identity and does not write again`
- `a deleted, disabled, or replaced coworker does not publish`
- `a stale workspace does not publish`
- `a shared root that points at a private folder does not publish`
- `a read grant is not enough to write`
- `abort before the claim writes nothing and stores nothing`

The handler is not imported. `server.ts` imports `server-only`. With no bound authority, `handleDesktopSharedFileMutation` returns 503 `{ status:'refused', code:'workspace_unbound' }`. The publisher WeakMap captures the authority object on the first request. Bind once at startup.

`fs.test.ts` does not import the contract. The other two tests do, through `tools.ts` and `publisher.ts`. Rebuild contracts after the barrel export before typecheck or those tests. Publisher tests must create the real `{dataRoot}/workspaces/1/engine/shared` directory because `assertCanonicalSharedRoot` runs even when io is fake. `/tmp` is a symlink to `/private/tmp`.

## Root fragments (unapplied)

Do not treat an unbound adapter as a finished feature. Until every fragment below is applied, mutation and search execute fail closed. A write grant cannot be persisted through `desktopRerunGrantsSchema` until the id is in the enum, because that schema strips unknown keys. Until the route and table exist, the POST fails and no file is written.

### Barrel

In `packages/contracts/src/index.ts`:

```ts
export * from './desktop-shared-file-mutations.js'
```

### Registry

In `apps/engine/src/tools/registry.ts`, next to the existing shared reader import and spread. Do not remove `desktopSharedFileTools`.

```ts
import { desktopSharedMutationTools } from '../desktop/shared-file-mutations/tools.js'
```

On the `buildTools` object, immediately after `...desktopSharedFileTools(ctx)`:

```ts
...desktopSharedMutationTools(ctx)
```

There is no key collision. The reader keeps `shared_read` and `shared_list`. This spread adds `shared_search` and/or `shared_write` and `shared_edit`.

### Grants

In `packages/contracts/src/desktop-tool-grants.ts`, insert `'sharedFilesWrite'` in `desktopRerunGrantIds` immediately after `'sharedFilesRead'`.

Replace the `sharedFilesRead` catalog row with:

```ts
supported('sharedFilesRead', 'Read shared files', 'Read, list and search text and Markdown files in the workspace shared folder. Every coworker with this permission sees the same shared documents. This does not create or edit.', 'shared_read', 'shared_list', 'shared_search'),
supported('sharedFilesWrite', 'Change shared files', 'Create new text or Markdown files and make exact, conflict-checked edits in the workspace shared folder. Existing names are never replaced. This does not include reading or searching, and Read shared files does not include this.', 'shared_write', 'shared_edit'),
```

In `apps/engine/src/desktop/tool-grants.ts` `hasDesktopToolGrant`, next to the `sharedFilesRead` line:

```ts
if (id === 'sharedFilesWrite') return config.tools.shared !== false
```

In `desktopToolInstruction`, replace the `shared` text so read mentions `shared_search` and does not write, and add write text. `enabled.has('sharedFilesWrite')` works only after the id is in `desktopRerunGrantIds` and `hasDesktopToolGrant` allows it.

```ts
const shared = enabled.has('sharedFilesRead')
    ? ' shared_read, shared_list and shared_search use the workspace shared folder, the same files for every permitted coworker. They do not write, rename or delete. shared_search does not write. Pass a visible relative path. Private Files stay on fs_read and fs_list.'
    : ''
const sharedWrite = enabled.has('sharedFilesWrite')
    ? ' shared_write creates a new .txt or .md file in the workspace shared folder and never replaces an existing name. shared_edit replaces an exact string and requires expectedBytes and expectedSha256 of the current file. A mismatch keeps the file. Report the tool result. A read grant is not a write grant.'
    : ''
```

Interpolate `${sharedWrite}` beside `${shared}`. The catalog description and this instruction are both required. The engine does not use `hasDesktopToolGrant('sharedFilesWrite')` for the live check. `sharedWriteGranted` reads the raw object so a not-yet-enumerated id can still be honored at execution, but the schema will not store it until the enum includes it.

### Route

New file `apps/ui/app/api/desktop/engine/shared-file-mutations/route.ts`. This lane did not create it. Copy the private route shape. The handler is exported from `server.ts`, not from a binding module.

```ts
import { handleDesktopSharedFileMutation } from '@/lib/desktop/server/shared-file-mutations/server'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const POST = handleDesktopSharedFileMutation
```

### Binders

Engine, before tools run:

```ts
bindSharedMutationWorkspace(async () => ({
    workspaceId, // canonical selection, not DesktopRuntime.workspaceId alone
    assertCurrent: async (signal) => {
        signal.throwIfAborted()
        // realpath(resolveEngineSharedDirectory(realpath(dataDir())))
        // must equal realpath(join(dataRoot, 'workspaces', String(workspaceId), 'engine', 'shared'))
    },
}))
```

App, once at startup:

```ts
bindSharedMutationAuthority({
    current: async ({ engineAgentId, workspaceId }, signal) => ({
        workspaceId,
        owner, // local desktop agent id for engineAgentId
        sharedRoot, // canonical shared directory for that workspace
        dataRoot,
        launchNonce,
        state, // 'active' | 'deleted' | 'disabled' | 'replaced'
        writeGrant, // current sharedFilesWrite, tools.shared !== false, enabled
    }),
})
```

`assertCurrent` comes from the canonical workspace selection. Recheck after awaits. A deleted, disabled, or replaced owner, or a changed workspace, root, or launch nonce, fails before a new write. If the call is already claimed, store `uncertain` rather than writing. Do not pass cookies, browser history, or ambient credentials. `assertPermission` for web fetch is not this grant. The publisher rechecks `assertCanonicalSharedRoot`, so a bad authority cannot point the write at a private folder.

### Schema

This module never creates the table. Statements are exported as `DESKTOP_SHARED_FILE_MUTATION_SCHEMA` from `apps/ui/lib/desktop/server/shared-file-mutations/store.ts`. Root appends the step. No Supabase.

```sql
CREATE TABLE IF NOT EXISTS desktop_shared_file_calls (
    workspace_id INTEGER NOT NULL,
    owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    state TEXT NOT NULL,
    result TEXT,
    PRIMARY KEY(workspace_id, owner, run_id, call_id))
```

Recommend the next version **31**, id `shared-file-mutation-receipts`.

Do not reuse 25–30. Read at integration `/Users/gszulc/OpenBot/Shared/rerun-desktop` while this lane was open:

| Version | Id | Where |
| --- | --- | --- |
| 25 | `webhook-human-request-links` | `round34-schema.ts` |
| 26 | `mcp-secret-reference-bindings` | `round34-schema.ts` |
| 27 | `public-company-discovery` | `round35-schema.ts` |
| 28 | `foreman-voice-attempts` | `round35-schema.ts` |
| 29 | `foreman-docs-receipts` | `round35-schema.ts` |
| 30 | `local-workspace-catalog` | `workspaces/schema.ts` (`DESKTOP_LOCAL_WORKSPACES_MIGRATION`) |

This worktree’s `round34-schema.ts` stops at 26. No version above 30 was found in that integration tree. Confirm again before applying 31. If 30 was not applied, do not take 30 for this table. If something higher than 30 landed, use the next free version and keep the id `shared-file-mutation-receipts`.

## Supported, dependent, unsupported

| | Supported in this source | Depends on root | Unsupported |
| --- | --- | --- | --- |
| Create `.txt` / `.md` without overwrite | ✓ | barrel, grant id, registry, route, schema 31, both binders | — |
| Exact edit with expected bytes and sha256 | ✓ | same as create | — |
| Search shared text | ✓ | barrel, `shared_search` on the read grant, registry, engine binder | — |
| Read grant is not a write | ✓ | catalog must not attach write tools to `sharedFilesRead` | — |
| Same-call replay, conflict replay, Stop after a committed write | ✓ | schema and route | — |
| Abort before claim, abort after claim | ✓ | schema and route | — |
| Private files, `node_modules`, `.git`, symlinks, `../` | ✓ | canonical root binder | — |
| `shared_read` / `shared_list` / Files panel | already accepted | leave them | — |
| Panel edit, rename, delete, move | — | — | ✓ |
| Binary, media, chmod | — | — | ✓ |
| Overwrite, hosted `/shared/files` | — | — | ✓ |
| Directory-create tool | — | — | ✓ (create may still make parents inside the shared root) |
| Search of private coworker files | — | — | ✓ |
| Follow symlinks or header redirects | — | — | ✓ |
| Write from a read grant | — | — | ✓ |
| Atomic edit across a crash | — | — | ✓ (torn file stays `uncertain`) |
| Hash from `shared_read` | — | — | ✓ (conflict text returns the current hash) |
| Installed Mac behavior | — | root acceptance | ✓ |

Until root binds both ports, mutation and search throw before they touch a file. Until the grant id is stored, the Tools checkbox cannot persist `sharedFilesWrite`. Until the route and table exist, the POST fails and nothing is written again on its own. That is the honest unbound state, not a default success.

## Limits

`DESKTOP_SHARED_FILE_MUTATION_LIMITS`: max bytes 262144, path 4096, pattern 200, search results default 50 max 100, files 200, search depth 8, line 4000, snippet 300, deadline 30000 ms. Mutation path parts still allow depth 32. Control characters other than tab, LF, and CR are refused.

Edit of a missing parent throws `SharedMutationError` code `outside` (“Folder not found”) and does not create directories. The publisher stores that as `refused`. Direct `editSharedDocument` throws rather than returning `refused`.

A create that finds matching destination bytes after a thrown import reports `saved` with `Wrote …` even when `importSharedText` did not return success. A pre-existing different file is `refused` / `exists` before import.

Reads, history, restart, and panel refresh do not call the publisher and do not mutate files.

No checks were executed. This is not installed Mac acceptance.
