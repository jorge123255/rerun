# Round36 integration, repairs and Mac acceptance

Installed runtime: `34c9cf39a2240e2b6122e8414ebb4f9f74b61697`, on `desktop/m1`. Source is integrated and the delivered native/restart slices below pass. Root ran every executed check and owns the installed acceptance. The nine received author tips are retained in `desktop-round36-received.md`; RD37 author worktrees were not changed.

## Result and scope

Round36 adds permission-controlled shared-file creation/edit/search; a scoped, opt-in local MCP endpoint; reviewed offline coworker export/import; and the original Servers interface backed by the actual local identity. Root composed the contracts, routes, native bridges, runtime ownership and migrations, then repaired source, production-build and native-QA findings directly.

Original source/design references are pinned to public Rerun `2a57fa6dd53311f763bfc9abde85997b7f7e5309`, with the original handoff mappings at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. The Mac keeps the original board/menu/Share/Servers/API-key layout and option ordering. Offline portable files replace hosted links because no public sharing host is configured. No remote machine was paired or public service activated.

## Repairs

- Bound shared mutations and external MCP tools to the current workspace, coworker and admitted run; added the separate default-off shared-write grant and durable effect receipts. Complete-read identities prevent stale file edits and preserve conflict recovery.
- Bound the external MCP management UI, internal engine-to-UI dispatch, principal projection, current permission rechecks and opt-in listener lifecycle. Preserved operation custody through dispatch, receipt persistence and bounded shutdown/retry.
- Reused canonical capture, portable archive and fresh-template installation authorities for coworker Share. Added authenticated ingestion, bounded native file handles, exact review/digest binding, durable replay/recovery, import reservation and bounded preview retention.
- Preserved actual workspace identity, including workspace 2. A database's internal workspace row1 is not substituted for its runtime owner.
- Repaired cold reader initialization and recovery discovery after app-origin changes; fixed Control Center API-key availability and notification search keyword regressions.
- Repaired production imports using the repository's existing explicit TypeScript source imports and rewritten emitted JavaScript. Removed an alternate alias prototype; no second build pipeline was introduced.
- Native Share review caught internal workspace backups/locks before any export. A follow-up review caught native skill-edit backups even with Files off. Capture prunes both before traversal/read/budget; snapshot and import/install independently reject reserved metadata, including nested aliases. Ordinary hidden user assets remain supported.
- Native import succeeded but Done left the board roster stale. The final repair starts a workspace-owned refresh after an exact acknowledgement, preserves it through dialog close, and refreshes agents/placement without opening a chat, moving the camera or flushing a draft. Stale owners are ignored. Recovery cannot repeat installation because a refresh failed.
- Hid the false "earlier uncertain import" notice during the current known in-flight request. Future API-key expiration now uses the existing exact date formatter.

Key repair commits: `72b1d4c`, `e1069b33`, `af1e8358`, `e4360c50`, `129b9943`, `d3f5a135`, `3d29043b`, `6f6ad959`, `34c9cf39`.

## Checks executed by root

Counts below overlap. They are not added into an inflated total.

| Check | Recorded result |
|---|---|
| Native shell, including remote tests | 96 passed; native source unchanged by later UI/privacy repairs |
| Engine full run at `3d29043` | 438 files: 437 passed/1 failed;4200 cases: 4199 passed/1 timeout |
| Sole engine failure, complete file rerun | Existing database-worker budget timeout; entire `data-tools.test.ts` reran alone, 10/10 passed with default timeout. The original full invocation is not called green. |
| UI full integration run | 871 files: 854 passed/2 failed/15 skipped;6559 cases: 6509 passed/2 failed/48 skipped |
| Both UI full-run failures repaired | Notification search keywords;13 related files/162 cases passed. The original full invocation is not called green. |
| Final workspace/skill privacy regression subset | 5 files/45 cases passed, including a real retained skill-edit backup, Files-off archive and forged import refusal |
| Affected UI privacy/template subset | 16 files/71 cases passed |
| Final import-refresh/launcher/share/key subset | 7 files/43 cases passed |
| Surrounding App/creation/interactions/templates | 4 files/16 cases passed |
| Contracts and engine/UI type checks | Passed; production build repeats current engine/UI compilation/type checks |
| Final affected UI lint | 0 errors,17 warnings |
| Packaging/signing/installation | Passed exact-head production build, runtime/helper checks, stable signing and atomic canonical installation; normal reopen needed no Keychain prompt. |

Earlier focused engine/UI authority, shutdown, portable import, shared-file conflict, ownership, launcher recovery and remote-custody checks also passed. Their counts overlap the recorded suites above.

## Native and saved-state evidence

- Board-to-side-panel Codex `gpt-6.1-sol` replied **RD36: 45**. The board remained visible and closing returned to it.
- With the explicitly approved temporary grant, Codex ran `shared_write → shared_read → shared_search → shared_edit → shared_read` on a new QA note. Exact final bytes are `RD36_SHARED_BETA` followed by a newline:17 bytes; SHA-256 `3e902decf6b8b3d028fc69413a5f453fc19c0ab542c085efa7ffae522609f9f6`. Both mutation receipts are saved. The grant was restored off.
- After restart, with write access off, Codex read the same note and hash, then replied **RD36 FINAL: 46**. Saved tool cards, prior replies and tabs persisted.
- API-key/MCP native UI preserved the read-only key across restart, while the listener restarted off. A reviewed local client passed real JSON-RPC initialize/tools-list/tools-call with 19 read-only tools in workspace 2. Invalid key returned 401;cross-site Origin 403;mutation was refused. It saw the isolated workspace, not the original roster.
- Native Revoke completed and the same saved client key then returned 401. The listener was turned off, both temporary keys are revoked, and the client exited with no retained secret. No full key was logged.
- The corrected native Share preview showed 28 workspace files and 32 archive members, with internal metadata excluded. The downloaded archive is 124371 bytes,SHA-256 `ce0a86eb00de28e1acda1f15881b8097dbf9fe75aaa43a0b6efedfa9e0467675`. Every member's size and digest was verified. Provider/model/connection bindings are cleared, every tool is false, and MCP server configuration is empty.
- Native Import Cancel left workspace 2 with no coworker. Review/Add created one disabled coworker with 0 sessions/0 messages; 31 non-config members match the archive exactly. The original workspace and source files were unchanged. Reimport after restart recovered the same ID with no duplicate. A distinct minimal four-member share created a second copy; Done immediately showed both disabled tiles without reload, camera movement or automatic chat navigation. Native Share preview-import and downloaded-file import both passed. A stale Computer Use screenshot caused one accidental Enable on the disposable first copy; it was restored to disabled, with all permissions still false and no chat/session created.
- Servers showed **This Mac / Connected** from the actual workspace 2 identity. No address/key was submitted and no remote pairing occurred.
- The stable signed build reopened without another Keychain/password prompt. Original23 chats/88 messages, protected unsent draft and original board/workspace/provider state remain preserved. All49 original Markdown files, the new shared QA note and the imported content are separately checked; the pre-final backup contains64 Markdown files. The final full Quit/reopen preserved both disabled copies with empty histories, all 70 current Markdown files, the original saved state and the C35 intake/plan receipt. The listener remained off with no active test key. The original board then produced a fresh **RD36 VERIFIED: 47** reply on this exact build; the saved execution is done, provider Codex, model `gpt-6.1-sol`. Rerun is left on the original board with Codex connected.

## Remaining scope

- W4: read-only external-client scope/lifecycle is accepted; broader write/send scopes have executed source/fixture coverage, not a live external mutation acceptance claim.
- D9: offline file/skill/instruction sharing is the delivered slice. Memories and private-database transfer remain disabled with accurate reasons. Hosted links/public file publishing need a real host. Native local-share withdrawal is not claimed by this run; its source behavior is covered by focused checks.
- W1: local workspaces and the local Servers projection work. Remote activation still lacks the complete gateway/durable root transition authority and a compatible supplied host; source UI/IPC is not remote connection acceptance.
- E11: optional automatic inference remains outside the C35 manual-intake acceptance. RD37 owns the next company-profile work.
- Live transcription, embeddings, Claude subscription and real OAuth/SSE/provider-specific flows remain configuration/user/root-acceptance gates where recorded. Existing implementations must not be assigned again as new missing code.

The historical checklist remains 35 rows: 14 checked and 21 unchecked whole groups. RD36 expands accepted slices of already checked D6 and partial E2/B5/D9/W1/W4; it does not justify falsely closing a broad group. I's audit is a source-time snapshot: its old five-read C checkpoint, C35 pending state and unbound Round36 P0.1–P0.4 are superseded. Its approximate package arithmetic is not a replacement checkbox count.

## Next allocation and publication

The user requested one master agent for all remaining phases. Its isolated source worktree is `round38-master-completion`, based on `6f6ad959`. The complete prompt covers RD38–RD42 for local completion/readiness and conditional RD43–RD45 for remote, hosting/collaboration and mobile/distribution. A 3–5 phase estimate is a planning range, not a release promise.

All executed checks and Mac acceptance remain with root. GitHub work uses one small draft PR per coherent package only after root reviews the exact intended head and approves publication. No automatic merge, public release or deployment is authorized. No push or PR was performed during this integration.
