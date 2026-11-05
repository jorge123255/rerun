# Rerun Mac handoff review — November 4, 2026

All eight handoffs are integrated in `desktop/m1`; external agent worktrees are preserved.
Original Rerun source/design pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.
Installed canonical source: `742d089bcd3b1383f862d4e5cf5301540d71e75d` at
`/Users/gszulc/Applications/Rerun Desktop Preview.app`. Packaging, runtime receipts and strict
local signature verification passed. No dependency upgrades, push or second preview app.

**Final native/restart acceptance and cleanup are complete for the delivered slices below.**
After the user approved Keychain, root verified the exact saved state before making changes.
The final skill decision/reply survived another full quit/reopen. Recovery-backed cleanup and
a final clean-workspace restart preserved the original **2 coworkers / 23 chats / 88 messages**.
E6 Skills and E8 Routines are now checked: **26 capability groups remain unfinished**.
C7 notifications remains partial because the OS banner/click was not observed.

## Handoffs and native evidence

| Lane | Integrated handoff | Native evidence and remaining work |
| --- | --- | --- |
| A — PDF cards | `4ca41a20617f7de8d259a7aeb09655ad1fae3f91` | Real Codex PDF/text cards, two pages, zoom and mixed attachment navigation passed. Reopened PDF page 2 and mixed text attachment from saved history after restart at `464332f`. |
| B — Uploads | `5c2665698902622be6b92e4cc739e22f065b3d3e` | Native picker upload, real HARBOR 25 reply and restart passed. Sibling Markdown attachment/draft restored unchanged. Drop/paste and uncertain-upload recovery have automated coverage; native queue transition remains unobserved. |
| C — Notifications | `b4444f3735b56e36a183d93220152c3fe5135ed8` | Preferences, request age, Actions navigation, pending restart and Blue/Amber answers passed. Signed Electron delivery receipts now report shown. An actual macOS banner and its click were not observed; C7 stays partial. |
| D — Skills | `d1c158585fc628d7542cadc6bedc3542abb62512` | Native author/edit/import, bundled file editing, grant-off refusal, actual skill_read/skill_read_file reply 42 and Codex-generated proposal acceptance passed. Skills bytes/proposals survived restart. Restored chat showed Remembered → View for the accepted skill; the other chat showed its own proposal. Clicking **No** persisted the dismissal without creating a skill. Actual Read Skill returned 63 after restart; rejection and reply survived another restart. E6 accepted. |
| E — Routines | `32dd3efb5d244b879e842632eccc097e93e2bf97` | Real manual, due one-shot and automatic recurring replies passed. Native edit/pause/timezone, next/last result, original Scheduled run/View prompt, immediate result title, disabled/grant refusal and no duplicate after restart passed. Final exact restart comparison and original scheduled prompt/result navigation passed. All three paused routines stayed paused and no occurrence was duplicated. E8 accepted. |
| F — MCP | `5c825c4bcf6a14285be4a4f90d7de9ffdb830283` | Anonymous public DeepWiki connection, three-tool discovery and actual replies before/after restart passed. Native Disconnect cleared the list; revoking MCP produced real MCP OFF; sibling had no servers. OAuth, local subprocesses and legacy SSE remain outside this slice. Untracked alternate adapter excluded. |
| G — Table cards | `75beb31d5a06d0b97ee6e75469b150d12c8942c6` | Private frozen 17/live 99 passed after restart. Renaming its saved view showed an explicit unavailable-view message without leaving chat. Shared frozen 73/live 74 opened the exact Shared database Table view. After full restart the shared card still showed 73 and opened its exact Table view with 74. |
| H — Website logos | `3ff13530145e0a936ea7fec2acd628a70de333c3` | Native github.com preview, Cancel and Save passed. Exact local WebP bytes, identity and workspace name survived two restarts. Cleanup restored the original no-icon selection and removed the QA image bytes; final restart verified both. |

## Root fixes

Skills now uses one native directory lock across UI and engine, exclusive publication,
version checks, preserved displaced files and interrupted-save recovery. Truncated editor
saves cannot destroy unread tails; case-insensitive manifest aliases cannot bypass the
procedure editor. Ownership/grants/cancellation are rechecked after waiting. Proposal
decisions prove the exact coworker/chat, and never enable tools. Shelf errors offer Retry
and keep prior rows. File, tree, index, registry and request bodies have actual-byte bounds.
Original YAML parsing, Skills editors and proposal blocks are reused.

Native checks exposed three further defects: missing desktop proposal review routes, a race
that could merge into an already decided proposal, and Codex structured-generation schema
reads denied by the Mac runner. Root added narrowly scoped routes, conditional proposal
updates, and literal read-only access to one validated SDK schema file. Native Seatbelt checks
still deny schema writes and sibling reads. Restored history also lost the proposal source
marker; the final build retains only validated status/ID presentation data, strips private
instructions, and supports both saved and live tool-message shapes.

Other corrections include routine message rendering and immediate chat titles/list refresh;
truthful Not run yet state; website-logo stale-result/save ordering; bounded image fetching;
local ad-hoc signing with strict signature verification; and a 30-second cooldown after an
OS notification refusal. Shared-code import/type fixes and a production bundling correction
were made after root checks exposed them. No dependencies were updated and no code was pushed.

## Root checks

- UI: **489 files passed / 14 skipped; 4,366 tests passed / 39 skipped** at `922164f`.
- Engine: **301 files / 3,285 tests passed** at `0a74b58`, with four workers. The initial
  unbounded run hit four unrelated timeouts; all affected focused cases and this complete
  bounded rerun passed. Engine typecheck passed; later commits do not change engine code.
- Final proposal/history UI regressions: **75 passed in 3 files**, plus UI typecheck at
  `742d089`. A test/source type mismatch found by typecheck was fixed before this pass.
- Routine error/permission UI regressions: **7 passed in 4 files** at `464332f`.
- Native Codex launcher/Seatbelt regressions: **22 passed** at `464332f`. These use a
  disposable probe and no live account access.
- Shell and native file helper: **26 passed**. Skills native directory lock, marker replacement,
  queued cancellation and recovery also ran on this Mac as part of engine checks.
- UI and engine type checks, production UI/engine build and runtime staging/verification
  passed at `7e8270b`. Emitted engine imports are JavaScript; the UI bundles shared source.
- Isolated staged runtime smoke passed with the actual bundled Node, UI, engine and native
  helper: Skills create/read/edit/delete, stale-version 409, manifest-alias refusal, archive,
  sibling isolation and service restart. It used a fresh temporary workspace and no model
  request, external connection or installed-app data. This does not replace native window QA.
- Website-logo focused checks: **95 passed**, included in later full UI totals.

Root alone executed checks, builds, installation and live app actions. Logs are in the
coordinator task's `work/handoffs-*` files. Source checks are distinct from native acceptance.

## Restart, cleanup and original workspace

The final installed build passed exact saved-state comparison before mutation:
`work/handoffs-integration-before-final-build.json`,
`work/handoffs-extra-before-final-build.json` and the recorded logo hash. Root then rejected
only QA Rejection Check, used the approved QA Answer Check through real Codex for **63**,
and rechecked shared-card and routine navigation in the native window.

A further full quit/reopen matched `work/handoffs-integration-completed.json` and
`work/handoffs-extra-completed.json` exactly: Skills bytes, applied/dismissed proposals,
routines and occurrence records, nine QA chats/40 messages, both drafts, tool grants, files,
private/shared databases, saved views, board and notification preferences. Native chat still
showed **Not remembered** and **63**. The other chat retained its unrelated unsent draft.

Root created and hash-verified the complete recovery copy at
`work/handoffs-integration-completed-recovery/verified-manifest.json`. Cleanup removed only
Handoff Integration QA and Handoff Sibling QA, their shared table/view/preference, and the QA
website logo; original notification settings were restored. The shared table API retains
ownership metadata, so while fully quit root removed only the exact backed-up QA receipt
inside a transaction that required the complete original shared schema/rows to match before
commit. The pre-existing unrelated ownership row was preserved.

Final full restart checks passed:
`work/handoffs-clean-after-final-restart.log` and
`work/handoffs-original-after-final-restart.log`. Original workspace/provider defaults,
Box geometry/membership, shared database and all **23 chats / 88 messages** are unchanged.
No QA coworkers, shared table, logo selection or logo bytes remain. The native board shows
only My workspace, Settings QA and Codex connection check, with Codex connected.

## Remaining scope

**26 unfinished groups**, down from 28 by closing E6 and E8. Other delivered slices reduce
partial scope without closing their broader groups:

- C7: Electron shown receipts and restored preferences are verified; an actual OS banner and
  click were not observed. Original in-app toasts, tile bell and task Notify me editing remain.
- C3: local text picker upload/send/draft/restart passed; drop/paste, uncertain receipt and
  queue handling have automated coverage. Native queued transition was not observed. Model
  media input remains.
- C8/D5: PDF and private/shared table cards are verified; broader media/PDF interactions,
  child runs and other request presentations remain.
- E5: anonymous HTTPS MCP discovery, invocation, disconnect, revocation and owner isolation
  passed natively. Bearer handling has automated coverage; OAuth, stdio and legacy SSE remain.
- B5: website logos and Skills/Routines/MCP navigation are available. Apps, Triggers, Setup,
  To handle and other contextual actions remain.

Routines run only while the app is open, with one due occurrence after sleep/reopen rather
than interval-by-interval catch-up. Cron/ISO and timezone replace hosted natural-language
parsing; model-side schedule tools are outside this slice. Skill use requires its explicit
coworker grant; approving a proposal never enables other tools. Connector-owned skills remain
read-only; no marketplace/dependency installer is included.
