# Foreman coworker file adapter

Source only. Not validated. No tests, typecheck, lint, build, or app run were executed for this change. Nothing here is a PASS or a runtime acceptance.

## Base and tip

- Base: `8297fe6404caa114dcb0c2cd6006291a8abb2038` on `desktop/finish-cloud-base-20261106-8297fe64`.
- Branch: `cursor/foreman-agent-files-c094`, created from that exact commit. The previous checkout was not reset, rebased, amended, or force-updated.
- Tip: the HEAD of `cursor/foreman-agent-files-c094` after this handoff commit. Embedding that SHA in this file would change the commit that produces it, so the pull request body records `git rev-parse HEAD`.

## What this is

Foreman can receive five coworker file tools, and only those five: `agent_files_read`, `agent_files_list`, `agent_files_search`, `agent_files_write`, `agent_files_edit`.

They are not the hosted `agentFilesTools()` mount. That mount writes through `workspaceDir` and does not use Mac grants or the text receipt. `apps/engine/src/tools/registry.ts` is unchanged. Desktop Foreman still returns from `desktopForemanTools` before that hosted mount.

Read, list, and search require `desktopToolGrants.foremanAgentFilesRead === true`. Write and edit require `desktopToolGrants.foremanAgentFilesWrite === true`. Any other value, including a missing key, is off. The two gates do not imply each other.

`agentConfigSchema` drops grant ids that are not in `desktopRerunGrantIds`. Those ids were not added here, so a saved config cannot turn the gates on until root appends them. The adapter still treats a missing key as off.

Granted reads show visible files in that coworker’s workspace, including documents saved earlier. They do not include chats, memories, credential stores, or hidden internal trees. The tool descriptions say this.

## Path ownership

New:

- `packages/contracts/src/desktop-foreman-agent-files.ts` — grant ids, tool names, copy, path and text rules, input schemas, catalog rows. Not exported from the contracts barrel.
- `apps/engine/src/desktop/foreman-agent-files/contract.ts` — runtime copy of that module, because this change does not rebuild `@rerun/contracts`.
- `apps/engine/src/desktop/foreman-agent-files/policy.ts` — target resolution and workspace containment.
- `apps/engine/src/desktop/foreman-agent-files/read.ts` — read, list, and search through `openWithoutLinks`.
- `apps/engine/src/desktop/foreman-agent-files/publish.ts` — one loopback post of a text write or edit.
- `apps/engine/src/desktop/foreman-agent-files/tools.ts` — registration and execute-time admission.
- `apps/engine/src/desktop/foreman-agent-files/root-fragment.ts` — ids and catalog rows for root.
- `apps/engine/src/desktop/foreman-agent-files/foreman-agent-files.test.ts` — authored, not run.
- `apps/ui/lib/desktop/server/foreman-agent-files/contract.ts` — same runtime copy for the app process.
- `apps/ui/lib/desktop/server/foreman-agent-files/publish.ts` — Mac receipt publication and Foreman admission.
- `apps/ui/lib/desktop/server/foreman-agent-files/publish.test.ts` — authored, not run.
- `apps/ui/app/api/desktop/internal/foreman-agent-files/route.ts` — new route. It does not edit an existing router.
- `docs/desktop-finish-foreman-agent-files-handoff.md` — this file.

Narrow edits of existing Foreman files:

- `apps/engine/src/desktop/foreman/binding.ts` — `Object.assign` the file tools before `registerDesktopForemanTools`. With both grants absent, the tool set is unchanged.
- `apps/engine/src/desktop/foreman/tool-identity.ts` — the five names, so a desktop provider does not drop them when they are registered.

Not edited: `apps/engine/src/tools/registry.ts`, `packages/contracts/src/desktop-tool-grants.ts`, `packages/contracts/src/index.ts`, migrations, central routers, DesktopApp, Conversation, native writeback, shared-file code, Brain tools, and team-read schema.

## Root binding

In `packages/contracts/src/desktop-tool-grants.ts`, append to `desktopRerunGrantIds`:

```ts
'foremanAgentFilesRead',
'foremanAgentFilesWrite',
```

Spread `foremanAgentFileCatalogEntries` from `packages/contracts/src/desktop-foreman-agent-files.ts` into `desktopRerunToolCatalog`. Labels are “Read other coworkers’ files” and “Edit other coworkers’ files”.

In `packages/contracts/src/index.ts`, add:

```ts
export * from './desktop-foreman-agent-files.js'
```

Then rebuild contracts. Until that export and rebuild exist, the engine and UI use their local copies. Those copies must stay identical to the contracts module.

No `registry.ts` line is required. `desktopForemanTools` already returns before hosted `agentFilesTools()`, and `binding.ts` adds these tools only for the Foreman agent.

## Admission and file rules

- Caller is the Foreman agent (`foreman`), enabled, with a running run in the current session. The grant is read again at execute from the Foreman config.
- The coworker argument is an id or a unique name in this engine’s index. Zero matches, more than one name match, a name ending in ` delegate`, and the Foreman id are refusals. The raw string is not a path.
- Writes also require one `desktop_agents` row with `workspace_id = 1` for that engine id, not present in `desktop_deletions`. The Foreman run is loaded from `GET /agents/foreman/runs/:id`, which the Foreman guard already allows. The run’s session must match. `authorizeRun(..., 'privateFileWrite')` is not used, because that requires the run to belong to the target coworker.
- Another workspace is not in this engine index or in `workspace_id = 1`. It gets the same “not in this workspace” refusal.
- Paths are relative. Empty segments, `..`, a leading dot, `node_modules`, and `.rerun*` / `.rerun-skill*` segments are refusals. `openWithoutLinks` does not follow symlinks. The workspace directory must be the real path under this data directory; a symlinked workspace is a refusal.
- Ordinary dotfiles stay hidden, which is the existing visible-path rule. They are not newly exposed.
- A refusal throws. It is not an empty list, “No matches.”, or a saved result.
- Reads are UTF-8 text up to 32 KiB. NUL and non-UTF-8 throw. Search skips non-text and oversized files inside a directory that itself opened. A directory that cannot be opened throws.
- Writes accept `.txt` and `.md` only, UTF-8, up to 256 KiB, and are checked before the receipt publisher. Other types throw “Nothing was saved.” An existing path is not overwritten. A missing edit target is refused before the publisher claims the call.
- The publisher is the existing `privateFilePublisher`. Its digest is the hash of the target id, Foreman session, Foreman run, `fs_write` or `fs_edit`, and the arguments. The engine API key is not part of that hash. The same call returns the stored result. A different body with the same call id conflicts. `unknown` or a stopped call is not posted again.
- The loopback client posts once to `http://127.0.0.1` with `redirect: 'error'`. It does not print the key, the data directory, or a credential store.

## Authored tests, not run

`apps/engine/src/desktop/foreman-agent-files/foreman-agent-files.test.ts`

- missing, false, and absent grants register no file tools; read and write grants register different names; a non-Foreman agent gets none
- read descriptions include the historical-document sentence
- ambiguous names, unknown coworkers, delegates, the Foreman id, and `../` are refusals
- dot paths, `.rerun*`, `.rerun-skill*`, absolute paths, and `node_modules` are refusals
- a denied coworker throws and does not call the read port
- a grant revoked at execute, or a run that is not `running`, does not read or publish
- non-text and NUL content throw before `publish`; a thrown unknown result is not followed by a second publish
- the publish body uses the target id, Foreman session and run, and `fs_write` / `fs_edit`, and has no authorization field

`apps/ui/lib/desktop/server/foreman-agent-files/publish.test.ts`

- a browser session cookie is unauthorized and does not import
- a non-text or hidden path is refused before the engine is asked and before import
- an engine id with no workspace row, a missing write grant, and an existing file do not import
- a missing edit is refused and does not save; a create imports once and the same call replays without a second import
- the same call id with different text is refused without a second import; a failed engine read is one wave of authority fetches and does not import

## Checks not run

Not run, on purpose: unit tests, typecheck, lint, build, dependency install, formatters, UI, native, browser, database, Keychain, provider probes, account flows, network activation, listeners, permission prompts, process restart, guest Docker, signing, certificates, entitlements, and update feeds. No live user files or accounts were opened. No merge, deploy, or release.

If a later hook requires one of those checks, stop and report it. Do not pass `--no-verify`.

## Security limitations

- The gates cannot be saved until root adds the two grant ids. Until then the tools stay unregistered. That is fail-closed, not a turned-on default.
- The contracts module is not on the package barrel, and contracts were not rebuilt. The engine and UI copies can drift if only one is edited.
- Brain write, delete, proposals, and decide are unchanged. This does not add other Foreman tools, Apps install, or review bypass.
- A missing parent directory on create can still reach the existing publisher, which may claim the call and then report `unknown`. That call is not retried. The file is not reported as saved.
- Search and list omit hidden names. A directory whose visible names are only symlinks or unopenable entries can list as empty. Asking to read the symlink path itself is a refusal, not the link target.
- The receipt’s existing staging files inside the canonical publisher are unchanged. This adapter does not add a new `.rerun*` alias.
- Writes depend on the new internal route being the one the desktop app serves. The route was not started here.
