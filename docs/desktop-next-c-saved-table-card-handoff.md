# C — Saved table card authenticated navigation fixture
Branch: desktop/next-c-saved-table-card
Worktree: /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-c-saved-table-card
Coordination base/parent: 89ec2070571c7d0d588e8e10d3e1a860681d05a5
Base tree: 487a0d7194a6dd0375c543e9b68f8136508d4bb8
Explicit dependency: draft PR #25; remote finish is still merged PR24 d518abdbfd38985ab4c185950c22e36b1b90a269, verified with git ls-remote.
Exact base commit/tree and clean status verified before edits.

## Prior delta preserved
/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-c-saved-image-card remains clean at 556423120791f2080b5180d3bb605dd7d4e521cf, tree 1be849ba8a23a7d8213e9cc3eb41f09e23785d82.
Exact PR24 delta:
- apps/ui/app/api/desktop/agents/[agentId]/files/image/route.test.ts: +31/-0.
- apps/ui/components/desktop/DesktopAssistantReply.test.tsx: +23/-0.
- docs/desktop-next-c-saved-image-card-handoff.md: +21/-0.
All three files are byte-identical in the PR25 coordination pin. No old work was copied/cherry-picked; saved-image Mac acceptance is the user's reported result, not re-tested here.

## Existing mounted path / original comparison
Original c33c020ffb33263ec29de6f76d9b269bca786d90 apps/ui/components/chat/MessageView.tsx card_table output-available parses tableCardSchema and renders TableCard; invalid output remains a tool step.
Mac:
- lib/chat/engine-history.ts publicDesktopHistory strips tool input/private/forged owner metadata.
- lib/desktop/table-card.ts desktopTableCardOf revalidates saved table payload, bounds and safe media; stored scope is a label, not an owner.
- DesktopAssistantReply.tsx -> DesktopTableResult -> DesktopTableCard.
- DesktopTableCard.openTarget resolves the saved view NAME only on deliberate Open via desktopViewActions(bound scope), then pins the returned view ID.
- DesktopTableResult/ DesktopCoworkerData keep the trusted conversation owner and pass requireInitialView to actual DataBrowser. Missing table/view refuses rather than selecting another tab.
- desktopDataSource -> actual /api/desktop/agents/[agentId]/data routes -> desktopRoute/authenticateDesktopRequest -> desktopDataTarget roster mapping -> one canonical engine-agent data base.
- Export uses the same bound owner route. Private preview/download rights were not broadened; shared navigation remains separate.

No production gap was demonstrated by executed evidence. Added only:
apps/ui/components/desktop/DesktopAssistantReply.saved-table-navigation.test.tsx and this handoff.

## Mounted fixture, unrun
Mounts actual saved-history projection, assistant presenter, table card/result, CoworkerData and DataBrowser. Browser transport dispatches to real authenticated data and preferred-view routes; only runtime context and a disposable loopback engine data server are synthetic. Real app SQLite roster maps trusted local owner to engine-original. Fixture never starts outside root test execution.
Assertions:
- exact saved frozen row displays after serialize/remount with zero data fetch until Open;
- Open displays the original owner's live table row with exact resolved view active; surrounding draft remains;
- app database close/reopen + component remount preserves navigation;
- removed view/table refuses without another dialog/fallback;
- forged payload ownership is stripped; raw foreign engine target is not a local roster owner and gets 404 before engine access;
- export bytes come only through original owner; every engine request is GET to that owner's data base;
- no card_table/tool/generation POST; only an existing owner-scoped preferred-view PUT is permitted if the mounted browser emits it.
The engine supplies synthetic table/view/row DTOs; this is not engine table persistence or actual process restart proof. Saved contract names a view; it resolves to a current view ID on explicit Open. No immutable view-revision contract was invented.

## Prerequisites and repeatable board-to-restart
No production mount/migration needed beyond PR25's existing table-history/data navigation paths. Root runs the new mounted fixture plus DesktopAssistantReply.tables.integration, DesktopTableResult, table-card, DataBrowser lifecycle and authenticated coworker-data suites.
1. Disposable original coworker: private notes table, Saved notes view, one known row. Save card_table reply; record local owner/session/table/view.
2. Reopen saved chat: frozen card row visible; no tool invocation. Open database: original owner's exact notes/Saved notes; draft stays.
3. Export through that same panel and compare owner-scoped bytes.
4. Cold restart, reopen same saved reply and repeat. Remove saved view, then table in separate disposable cases: explicit unavailable state, no fallback or tool rerun.
5. Try forged/foreign target evidence: do not read another coworker's table or reuse its export/preview rights.
All tests/builds/Mac board/cold-restart QA UNRUN. Installed Next docs absent; no Next API introduced. No installed-app/profile/account/VM/permission changes, push, PR, merge, publication or installation.
