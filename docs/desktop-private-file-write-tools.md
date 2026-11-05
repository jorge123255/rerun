# E2 private fs_write / fs_edit source handoff

Prepared base: `b428751d716efdb3c928c124921502d2a5e4e6c1`. This worktree only: `private-file-write-tools`, branch `desktop/private-file-write-tools`. No other lanes or central files were edited. Source only; root integration and acceptance pending.

## Original references

Read with git show at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:
- `apps/engine/src/tools/builtin/filesystem.ts:1`: fs-prefixed coworker workspace tools.
- `apps/engine/src/tools/builtin/fsTools.ts:26`: fs_write(path,content).
- `apps/engine/src/tools/builtin/fsTools.ts:43`: fs_edit(path,oldString,newString,replaceAll), exact matching, unique-by-default, replacement count and language.

`fsTools.ts` is under builtin, not directly tools. Current Mac storage reference: `apps/ui/lib/desktop/server/coworker-files.ts` readCoworkerFile/importCoworkerFile/saveCoworkerFile, pinned directories, no-replace links, journal/backup conflict recovery, hash and inode identity. Installed Next route-handler guide read at the supplied codex-login-build path. No dependencies added.

## Changed files and interfaces

- `apps/ui/lib/desktop/server/private-file-tools/semantics.ts`: privateTextPath, boundedPrivateText, editPrivateText, PRIVATE_TEXT_BYTES.
- `apps/ui/lib/desktop/server/private-file-tools/publication.ts`: privateFileCall strict schema, PrivateFileCall, PrivateFileAuthority, privateFileReceiptSchema, privateFilePublisher.
- `apps/ui/lib/desktop/server/private-file-tools/bridge.ts`: privateFileToolDefinitions, privateFilePublicationApi.
- `apps/ui/lib/desktop/server/private-file-tools/semantics.test.ts`: authored literal-match, empty/missing/ambiguous search, path and text-bound regressions.
- `apps/ui/lib/desktop/server/private-file-tools/publication.test.ts`: authored receipt/restart replay, changed call refusal, truncated read, unknown acknowledgement, authority checkpoint and create/import contract regressions.
- `apps/ui/lib/desktop/server/coworker-files.ts`: narrowly optional PrivateToolPublication hooks and existing-directory-only create; canonical visible path refusal for tool calls; fresh authorization before create publication, edit displacement/link/commit. Existing human UI signatures remain compatible. Backup inode is checked as well as hash.
- This document.

## Semantics and Mac differences

Tool names/argument shapes match Rerun. fs_write creates only a visible .txt/.md in an existing private directory, including an already-existing workspace root. It never replaces a name, creates a directory or follows a tool-selected symlink. Text and resulting complete edited documents are limited to 256 KiB of valid UTF-8, with binary/control content refused. This is a deliberate narrower Mac grant than upstream's directory-creating/replacing write. Visible relative path components only; no hidden files/directories, traversal, absolute paths or shared Files. D's shared file tools are separate.

fs_edit reads the complete bounded document, requires hash and dev:inode, rejects truncated/noneditable reads, rejects empty/unmatched searches and multiple matches without explicit replaceAll. Replacement strings are literal (including $ tokens), and unchanged matching text returns unchanged rather than claiming a save. The existing save mechanism rechecks the opened hash/inode against disk, preserves external versions and publishes through its journal/backup protocol. Native Codex sandbox writes remain discarded; no shell writeback, binary, delete, chmod, directory creation or access beyond private visible Files is added.

The publisher returns saved only after the filesystem mechanism returns and a durable saved receipt is written, followed by current authorization. Errors after a durable claim return unknown, with instructions to inspect Files and no claim that a file was saved. This conservative category includes known refusals encountered inside publication as well as lost acknowledgement; it never implies a successful save or permits automatic repetition. Errors before claim return a refusal through the bridge. Receipts store owner/run/call, an exact request digest and the small result, not document contents. Same call/digest replays a recorded result across a service restart; a different request under the same ID refuses. Claimed receipts without saved results never relaunch. There is no filesystem/SQLite distributed transaction: a crash after save but before recording acknowledgement stays unknown. Root must reconcile manually; do not reset the claim automatically. Receipt success records what this call published; it does not promise the file has not subsequently changed.

## Required root wiring before activation

Root owns default-off grant/contracts, registry/system prompt, HTTP policy, callback registration, schema/bootstrap and receipt retention. Do not activate without all of these:

1. Add an explicit privateFileWrite boolean grant, default false, to root's grant contract/UI/catalog. Do not reuse read Files, shared Files, arbitrary filesystem or shell grants. Offer fs_write/fs_edit only to the granted current coworker run. Describe creation and exact edits in the current private Files panel; no alternate temporary-editor UI.
2. Register privateFileReceiptSchema as a new additive numbered central desktop database migration for existing and new databases. Keep receipts across app restarts and unknown acknowledgements. Do not expose this table to coworker data tools or prune receipts for runs that might still retry.
3. Construct ONE authoritative private publisher in the supervised UI process. The callback must validate the exact engine agent, session and run against current engine/local owner metadata; resolve one current local owner; reject deleting/reassigned/disabled coworkers, ended/aborted runs and absent current privateFileWrite grant. Read current authority each invocation, with the supplied AbortSignal. Never accept owner/dataRoot/run authority from model arguments. Ensure Quit and Stop abort this run's signal and close new admission before engine teardown. Root transitions must make revocation visible before publication guards can return.

```ts
import {privateFilePublisher, privateFileReceiptSchema} from '@/lib/desktop/server/private-file-tools/publication'
import {privateFilePublicationApi, privateFileToolDefinitions} from '@/lib/desktop/server/private-file-tools/bridge'
// In central additive migration: await db.executeMultiple(privateFileReceiptSchema)
const publishPrivateFile = privateFilePublisher(db, async (call, signal) => {
  const current = await authorizeExactCurrentPrivateFileRun(call, signal)
  // REQUIRED root function: current owner + exact session/run + enabled + default-off grant.
  // Must throw for stopped/unknown/deleting/reassigned/disabled/revoked authority.
  return {owner:current.desktopAgentId, runtime:current.runtime}
})
const privateFileApi = privateFilePublicationApi(publishPrivateFile)
```

4. Root registers only POST `/api/desktop/engine/private-file-tools` through an engine-authenticated callback route. It calls privateFileApi(request), which preserves authenticateDesktopEngineRequest and bounds the JSON body to 2 MiB/30 seconds. This is distinct from human Files CRUD endpoints. Do not expose a generic filesystem path route. Root's engine policy must permit only that callback path/method for its exact local authenticated engine. API errors and unknown receipts must remain truthful tool results, not fabricated saved messages.
5. Root's real runner registers privateFileToolDefinitions on its dynamic tool surface, checking collisions and removing any unrestricted native tool with those names. For each exact tool-call ID, send only the validated tool arguments plus engineAgentId/sessionId/runId/toolCallId/tool. Attach the real run/call Stop signal to the authenticated local request and retain the same identity/digest after unknown acknowledgement. Deliver the returned structured result to the same tool call ID, set isError for refused/unknown results, then resume the same run. Do not mint another ID to bypass a claim. A locally bounded caller timeout does not prove a publication failed: query/retry that exact call through the same authority.

```ts
for (const definition of privateFileToolDefinitions) {
  registerDynamicTool(definition.name, definition.description, definition.inputSchema,
    (args, callSignal, toolCallId) => invokeAuthenticatedPrivateFileBridge({
      engineAgentId, sessionId, runId, toolCallId, tool:definition.name, arguments:args,
    }, AbortSignal.any([runSignal,callSignal])))
}
```

The root functions shown above are integration contracts, not lane exports. Root must preserve current private path mapping and single-owner publication; no independent engine filesystem writer is approved. Existing roster/save serialization remains authoritative across human and tool publication. A stalled local storage operation cannot safely be labelled failed or retried under a new identity. The publication guard prevents delayed preparation from publishing after current authority refuses; a Stop arriving after an OS publication may still leave a saved file, represented by its durable receipt or unknown status.

No central activation, checklist or acceptance changes were made. Root alone runs regressions, type checks/lint/build, native conflict/cancellation/restart validation and packaging. Required integration cases include outside same-byte inode replacement, concurrent outside edits during each publication phase, grant revoke/disable/delete/Stop/Quit, create collision, missing directory, exact receipt replay after restart and durable unknown acknowledgement. **Checks and Mac acceptance were not run by me.** No live files/data/credentials, app control, network/model calls, installs, preview, push or merge.
