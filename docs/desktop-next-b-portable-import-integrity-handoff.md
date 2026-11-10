# B — Portable import receipt integrity
Branch: desktop/next-b-portable-import-integrity
Worktree: /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-b-portable-import-integrity
Coordination base/parent: 89ec2070571c7d0d588e8e10d3e1a860681d05a5
Base tree: 487a0d7194a6dd0375c543e9b68f8136508d4bb8
Explicit dependency: draft PR #25. This is NOT based on the merged finish branch.
Verified local commit/tree and clean status before edits. git ls-remote confirmed remote desktop/finish-cloud-base-20261106-8297fe64 at PR24 d518abdbfd38985ab4c185950c22e36b1b90a269.

## Prior worktree delta before carry-forward
Preserved /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-b-portable-share-roundtrip clean at da3e28d1aa0c45b772b27b4b473fe5441c7215bc, tree cf3b17be85a6b49dfb0d122ff5d29f3f6517f82a.
Exact delta from its PR24 parent:
- apps/ui/lib/desktop/server/coworker-share/binding.test.ts: +65/-0.
- docs/desktop-next-b-portable-share-roundtrip-handoff.md: +29/-0.
Both files are byte-identical at the PR25 coordination pin. No cherry-pick/replay/copy of old work. Codex owns execution of that combined memories/table/view/file Mac round trip.

## Original and current trace
Original Rerun dev c33c020ffb33263ec29de6f76d9b269bca786d90: apps/ui/components/agent/share/ShareAgentDialog.tsx options and explicit data confirmation respect canManage and separate memories/database/files opt-ins; original hosted Create link remains separate.
Current mounted local path: DesktopCoworkerShareDialog/useDesktopCoworkerShareFlow -> reviewed manifest/digest -> existing service.export; DesktopCoworkerImportDialog and import inspection -> exact snapshot/expectedDigest/targetWorkspaceId/requestId -> service.import -> store.reserveImport -> canonical install/recoverImport -> settleImport. Existing authenticated route/binding owns workspace admission; no route or permission system added.

## Concrete branch-order defect / change
In server/coworker-share/service.ts the completed-import return preceded the reservation.requestId equality check. Thus after original request A completed, a different request B for that snapshot/workspace could receive A's successful importedAgentId receipt. The destination was not duplicated, but successful receipt identity was false.
Moved the existing request identity guard BEFORE the completed return. A different request continues to return the existing safe uncertain/recoverable result, both before and after completion. Only the exact original request can acknowledge/recover success. Same workspace and expected reviewed digest are still checked before reservation. No import retry is dispatched for an alias. Existing Direct Duplicate/hosted sharing behavior is untouched.
This is source-traced branch-order evidence and an authored parent-negative-control regression, NOT an executed reproduction or PASS claim.

Changed paths:
- apps/ui/lib/desktop/server/coworker-share/service.ts (one reordered guard).
- apps/ui/lib/desktop/server/coworker-share/service.test.ts.
- apps/ui/lib/desktop/server/coworker-share/binding.test.ts.
- this handoff.

Authored unrun cases:
1. Service-level completed alias returns uncertain; exact request recovers identical receipt with one install.
2. Real canonical binding fixture loses acknowledgement after installation, rejects wrong digest/workspace, reopens SQLite/binding and recovers original request. Alias after completion stays uncertain; exactly one disabled destination and one canonical install request remain.
3. Alter archive_blob after inspection while keeping reviewed digest: existing archive verification rejects before import reservation/install.
Existing digest/archive checks were not changed. Existing canonical binding fixture remains Darwin-only with its established helper support; nothing was built/run by this lane.

## Mount prerequisites and board-to-restart
No migration, new mount or new sensitive option. Depends on PR25's existing inspected archive + canonical memory/database/file restore paths. Integrate only after reviewing the exact PR25-based tip; no main/finish branch integration here.
Root runs authored service/binding fixtures and parent negative control. Manual disposable scenario:
1. Existing Share -> review/export local portable file. Existing Import -> inspect exact digest; record original request ID via existing attempt/receipt evidence.
2. Lose the import response after canonical installation. Reopen/restart and retry the SAME workspace/digest/request. It must recover the same disabled destination.
3. A new request ID must not claim that completed receipt or create a second copy. Changed digest/workspace must refuse.
4. In a separate disposable case alter archive bytes after inspection; old review cannot import them. Reinspect explicit new content before any new operation.
5. Verify destination remains disabled/default-off, source unchanged, and existing attempts retain original identity. Combined section-fidelity acceptance stays with Codex.
All tests/typecheck/builds/native board/cold-restart QA UNRUN. Installed Next docs absent; no Next API added. No actual profile/account/VM/app change, push, PR, merge, publication or installation.
