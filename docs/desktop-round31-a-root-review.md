# Agent A round31 — root review and source verification

Author handoff: **5847b73a9f415cd2657d210fb8824d9ddba14435**, initially clean branch `desktop/round31-coworker-calls` in `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round31-coworker-calls`. Root preserved that checkout and imported the handoff as **84042ef** in the coding worktree. The repairs below belong to root commit **126064c**; no correction prompt was returned to the external agent. A final custody check found additional uncommitted source edits in the author worktree, including `setup-admission.ts`. Root did not make or integrate those edits; they are outside this tested version and await a committed handoff.

**Source verified, not installed or Mac accepted.** Persistent coworker calls remain unavailable until the original call UI/mentions, explicit allowed-target Settings and central startup/registry callbacks are integrated. The installed Mac preview remains **aa35cc8**, which passed round30 native/full-restart acceptance. Do not decrease the checklist count for A yet.

## Root repairs

- Bound each Stop intent durably to the exact parent conversation, call, revision and request UUID before effects. Ownership is checked before saved receipt replay. Same-process duplicate Stops share one result; conflicting request IDs cannot cancel a second child. Pending Stop survives database reopen. No inferred cancellation of whichever run happens to occupy a child chat.
- Added per-app launch and engine epoch fencing. Delayed old inserts, claims, patches and adoption cannot revive old work or roll back an adopted launch. Terminal waiting-for-human records survive a new epoch.
- Required current target preparation before any child session and again at each awaited launch boundary: exact local/engine identity, enabled/deleting state, caller grant and allowed target, existing setup admission, and the strict desktop model resolver. No setup-session bypass or fallback to a different provider/model.
- Awaited all headless admission callbacks. Added a pre-provider run-created hook that persists the exact child run before work/nested calls. Failure paths cancel and drain the known run; progress updates are serialized and caught. A real terminal outcome can be recorded while Stop is pending.
- Added a private request fingerprint so a replay cannot change the target/message/context/wait mode under the same invocation. Concurrent and durable mismatches refuse; stored wait semantics remain authoritative.
- Preserved the called coworker's per-run self-improvement restriction when Codex refreshes its on-disk configuration, without changing saved preferences.
- Added a trusted pending-tool identity to actual engine settlement. The call's read projection compares that exact ID against current question/approval/takeover/app-request state. Answered or replaced requests do not leave an old call waiting. A terminal waiting turn never stops a later run in the same chat. The app-request projection reads existing source/receipts without creating a request card.

The original Rerun call-agent/sub-run/headless design remains the reference. These are local ownership, persistence and lifecycle repairs, not a replacement call engine or new visual design. Private fingerprints, engine IDs and pending tool IDs do not enter the public call snapshot.

## Root-run checks

| Check | Result |
| --- | --- |
| Coworker-call and runtime engine suites | **44 files / 406 tests passed** (`work/round31-a-engine-tests.log`). Includes real Codex-loop configuration-refresh regression with a mocked provider and awaited headless launch cases. No live provider calls. |
| Final call routes/authority/database/projection plus setup and service-request suites | **6 files / 62 tests passed** (`work/round31-a-final-ui-tests.log`). Covers concurrent Stops, wrong-parent receipt replay, database reopen, pending resolution, generation fences and read-only projection. |
| Engine and UI type checks | Passed (`work/round31-a-engine-types-final.log`, `work/round31-a-final-ui-types.log`). Engine resolves the freshly built coding-checkout contracts, without modifying the accepted build worktree's dependency artifacts. |
| UI lint | Zero errors; an unused test-only import was removed after the first final pass. |
| Diff and author custody | Whitespace check passed. A was clean when its committed handoff was captured; later uncommitted author edits are preserved and excluded. |

Counts overlap earlier targeted runs; do not sum them. Tests used disposable local fixtures. A's new runtime was not bound to the live Mac workspace, no capability was enabled, and no additional app build was installed for this source-only stage.

## Remaining root integration before Mac acceptance

Exported contracts are now available. Startup/database/engine-callback mounts, explicit default-off grant plus allowed-target Settings, B's original call cards/exact target navigation, C's durable mention integration and central lifecycle cleanup still need integration and board/live-Codex/full-restart acceptance together. The detailed callback requirements are in `apps/engine/src/desktop/coworker-calls/INTEGRATION.md`. Original handoff instructions are historical where this repair record supersedes them.

A’s expanded full-list prompt is the assignment reference; receiving the handoff does not mean redispatching it or resetting its worktree. Root owns the remaining integration and every repair/check.

## Final A handoff review during combined integration

Reviewed committed author handoff **0f35194779e43ce786053cdcde2ba21df78136c9** without cherry-picking over the stronger root admission, awaited launch, exact Stop and epoch controls. Its setup gate and request fingerprint are covered by the existing root implementation. Its bounded partial-result retention for a failed dispatched call was reported to root for the engine integration; it is not claimed complete by this HTTP review.

The combined integration adds recovery of a missing local chat link for a terminal call, including a call interrupted by restart. Recovery reads the existing engine session and requires its exact target, source and caller-origin identities. It rechecks the stored call and local coworker under the roster lock, reuses any already-created local chat, and records only that local link. Retired epochs remain unable to change execution state. Recovery never starts a session or run, resolves a model, or changes setup.

Two integration defects were repaired in the HTTP layer: the normal engine patch path correctly refuses retired epochs, so link recovery now uses a narrowly constrained metadata update; and recovery previously incremented the call revision while Stop was validating it, so recovery now runs only on terminal list reads, never inside Stop. Live queued/running calls remain owned by the engine adoption path. Adoption also rechecks the epoch and exact stored session after its asynchronous engine read.

Authored HTTP regressions cover database reopen and new epoch, lost link acknowledgement, exact source/origin checks, read failure and retry, owner remap/deletion, changed call session, Stop with a missing link, and the adoption epoch race. These new tests have **not been run by the review helper**. Root must execute them with the combined suites and retain the separate Mac/full-restart acceptance gate. Earlier counts above describe the earlier source checkpoint, not this final combined version.
