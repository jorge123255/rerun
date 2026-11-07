# Mac preview build and native acceptance

Integration owner: Codex. Date: November 6, 2026 (America/Chicago).

## Identity and isolation

- Tested and installed source: `0bddbc5cd689a8d62bfbe6d6d3a82f42281f2c62`.
- Build ID: `0bddbc5c-desktop-0.1.0`.
- App: `~/Applications/Rerun Desktop Preview.app`, Apple-silicon macOS.
- Fork development branch: `desktop/macos-preview`.
- This source includes the committed `desktop/m1` checkpoint through `208038f5`
  and the reviewed PR4 repairs. PR4 itself and the fork's default branch are
  separate source states.

All checks, builds, signing, app interactions and provider calls are performed by
the integration owner. Helpers review source or author changes only.

The production entry point still uses the normal installed preview profile;
passing a different app path or `--user-data-dir` is not an isolation guarantee.
For this explicitly authorized update, the app was fully quit, its previous
bundle and profile privately backed up, and the existing **Round35 isolated QA**
workspace selected before the cold launch. It has its own database, engine root
and preexisting Codex login. A new disposable coworker was used for chat checks.
No original-workspace chat or credential was copied into the QA workspace.

Build dependencies and output were prepared in a clean detached worktree, with
test/cache evidence outside tracked source. The build environment omitted
provider, cloud and GitHub credentials. The existing preview signing certificate
was retained. The installer checks the exact clean source commit, requires the
app to be quit, verifies the shell/UI/engine/manifest source receipts, and swaps
only the canonical installed app. Local packaging explicitly uses
`electron-builder --publish never`.

## Issues found and repaired

- Runtime verification previously accepted some broken or escaping symbolic
  links. It now requires every staged link to resolve inside the resource tree.
- Packaged-layout fixtures were missing the now-required Claude runtime paths
  and a valid installation identity. The fixtures now reflect that contract.
- Production Next.js typechecking exposed launcher environment typing and a
  React test-global type error. Both were fixed; the production build then passed.
- Native workspace 2 exposed invalid attachment/voice ownership checks. Each
  workspace database keeps its local workspace row `1`; comparing that value to
  the external runtime workspace ID rejected valid chats and disabled Send.
  The checks now use the correct local identity, retaining authenticated runtime,
  agent/engine, deletion, tab and session ownership checks. Two regressions
  failed on the prior source and passed after the correction.
- Reopening a previously exported coworker incorrectly marked its retained
  archive stale. The server intentionally returns `reused: true` for the same
  validated owner/source/options. The UI now accepts that review while retaining
  its owner/source/options/package checks, explicit approval and export digest,
  archive hash and size checks. Both new witnesses failed before the fix.

## Source and packaging checks

| Check | Result |
| --- | --- |
| Runtime link/package/provenance slice before the workspace correction | 22 tests passed |
| Claude/auth/MCP production environment slice | 25 tests passed |
| Saved tool-card regression slice | 2 tests passed |
| Attachment/voice ownership and service slice on final candidate | 38 tests passed in 4 files |
| Actual packaging entry command-capture checks | 4 tests passed; directory and DMG dispatch both disable publishing |
| Repeated archive review, UI flow, dialog and server slice | 24 tests passed in 5 files; lint zero errors, 4 existing warnings |
| Final focused lint and workspace UI typecheck | Passed |
| Full production renderer build, production typecheck, engine build and bundled runtime verification | Passed on final candidate `0bddbc5c` |
| Exact-source installation and strict deep code-signature verification | Passed; signing certificate matches the previous installed app |

The test slices overlap historical suites; their counts are not added to those
suite totals. The previous full UI and engine results in the development tracker
remain tied to their original source snapshot. Three nested macOS worker tests
and one protected common-Git metadata case from that older validation environment
were not rerun or waived by this native exercise.

## Native results

**PASS for this bounded installed-app workflow.** All interactions below used the
Mac app's board and side panel through native Computer Use. Read-only database
and file comparisons corroborated the visible results; they did not substitute
for sending messages in the actual app.

| Native check | Result |
| --- | --- |
| Cold launch and account continuity | Correct `0bddbc5c` runtime; isolated workspace selected; Codex connected without a new sign-in or password prompt |
| Board to side-panel chat | Board stays visible; a changed board zoom is retained when closing the panel |
| Actual provider reply on final build | `BUILD-CHECK: 42`; saved run provider `codex`, model `gpt-6.1-sol`, status `done` |
| Two independent saved chat drafts | First marker and full-editor second draft stay with their own tabs and replies, including after full quit/reopen |
| Model/reasoning persistence | GPT-6.1 Sol workspace default and its default Low reasoning shown before and after restart; no model or permission change made |
| Fresh reply after full quit/reopen | `RESTART-CHECK: 49`; saved run provider `codex`, model `gpt-6.1-sol`, status `done` |
| Retained local archive review/export | Exact same archive reused after the fix, with explicit review on the corrected build; no false stale warning, upload or public share |
| Cancelled import | No coworker added |
| Successful import and Done | One fresh tile appears without reload; original selected chat, reply, draft and board camera remain intact |
| Imported owner after restart | Copy remains disabled with zero chats, cleared connection/provider/model bindings, no MCP servers and all 26 tool flags off |
| Original workspace restoration | My workspace restored; board responsive and Codex connected |

The initial `MAC-CHECK: 45` reply and full-editor exercise were performed on
`8407a1ff` while diagnosing native issues; those saved replies/drafts were then
visibly verified on `0bddbc5c` after update and full restart. A third chat held
the final-build and post-restart arithmetic requests, leaving both draft markers
unsent. The final-build run IDs are `4003025d-a7c8-8d65-ab99-aad548091c35`
and `8t45afifd8l1nvqnp1opg`.

Original-workspace preservation passed against the private pre-update backup:
eight app tables (including 8 coworkers, 73 desktop chats, 17 drafts and 2 Boxes),
nine engine databases (328 messages, 74 engine sessions including the managed
Foreman, and 169 runs), all 49 protected Markdown files and all eight user
coworker configuration files. Comparisons used existing-column semantic rows
and file hashes, not raw database-byte equality across migrations. The only
managed configuration change was Foreman gaining explicit `false` defaults for
`foremanAgentFilesRead` and `foremanAgentFilesWrite`; no existing setting changed
and no access was granted. The QA coworker's instructions/configuration hashes
were also unchanged across restart.

Disposable fixtures remain only in the isolated QA workspace: the new test
coworker, its three chats/two unsent drafts, one local archive and its disabled
fresh copy. Existing QA coworkers were not modified. The private rollback data,
credentials and raw history are not part of the published source or report.

## Repeating the check

1. Pin and review the intended source. Build from its own clean worktree; keep
   caches and private rollback data outside the source tree.
2. Fully quit Rerun and preserve the installed bundle/profile privately. Use an
   existing isolated workspace with its own authorized login and a disposable
   coworker. Do not treat an alternate app path as a temporary profile.
3. Run `node scripts/desktop/install.mjs --commit FULL_40_CHARACTER_SHA` with the
   stable preview identity. Check the manifest/source receipts and verify the
   strict code signature and unchanged signing certificate before opening it.
4. From the board, open the disposable coworker, send a real Codex message,
   switch chats, preserve distinct drafts, and close back to the same board
   position. Check the actual saved run's provider/model, not only its label.
5. Fully quit and reopen; repeat the saved chat, draft, selected model and fresh
   reply checks. Keep any permission changes limited to specifically approved
   QA owners.
6. Restore the original selected workspace and compare its saved semantic rows
   and protected file bytes against the private backup. Publish only a redacted
   result, source and documentation; never upload the backup or credentials.

This exercise does not establish full feature parity, clean-machine installation,
Intel/universal compatibility, notarization or release readiness. The disabled
and unmounted features in the development tracker remain separate work.
