# B — Combined portable Share round-trip acceptance source
Base/parent d518abdbfd38985ab4c185950c22e36b1b90a269; tree 94f7b0220733175e86c022befcd592752303be82.
Branch desktop/next-b-portable-share-roundtrip.
Worktree /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-b-portable-share-roundtrip.
Exact clean pins verified before editing.

Changed apps/ui/lib/desktop/server/coworker-share/binding.test.ts only, plus this handoff. Added one combined disposable scenario to the existing canonical binding fixture; no production mismatch was demonstrated by executed evidence and no production code changed.

Mounted path: components/desktop/coworker-share/DesktopCoworkerShareDialog.tsx -> useDesktopCoworkerShareFlow/client -> existing coworker-share route/service/binding. DesktopCoworkerImportDialog.tsx -> existing inspect/import flow. Both render DesktopCoworkerManifestReview and published memory/database section previews; sections.ts keeps opt-ins false until selected and requires capture/validation/install authority.
Original comparison c33c020ffb33263ec29de6f76d9b269bca786d90: apps/ui/components/agent/share/ShareAgentDialog.tsx options/confirmation count memories, database and files independently; dialogs/ImportAgentDialog.tsx is the original hosted/import source flow. The Mac continues its existing local portable dialogs; hosted links remain separate.

Capture/install: server/coworker-share/binding.ts, memories.ts, database.ts -> engine coworker-share-memory capture/restore and coworker-share-database logical capture/restore -> existing template commitInstalled before roster publication. ReadPortableArchive verifies the reviewed members; install keeps destination disabled and independent. Hosted links/Direct Duplicate were not changed.

Single fixture source contents:
- one canonical memory/note.md with exact serialized note bytes;
- private notes row id 1, title “Exact portable café row”;
- saved _rerun_views entry portable-view, “Portable review”, position 2, layout table;
- allowed workspace/notes.txt exact bytes “A portable note.”;
- synthetic credential sentinel in source .env and reserved _rerun_internal table.
Review assertions: memory count=1 with exact serialized byte count; private table count=1/viewCount=1; allowed file count=1 with exact bytes. All-off review has no selected memory/database/file members and retains explicit exclusion categories. Opted-in export manifest equals review; every decoded archive member length equals reviewed bytes; sentinel and raw data/agent.db/.env paths are absent.
After import and SQLite/binding reopen, exact request recovers the same result, one independent destination stays disabled; note and file bytes are exact; private row and saved view content/order are exact; internal table/credential and source connection/grants stay out.
The test uses the canonical services and the same DTOs the mounted dialogs consume. It does not mount both dialogs in that Node integration test; existing ShareDialog/ImportDialog mounted suites cover those controls. Combined installed result is an assertion, not an observed PASS, because execution remains root-owned.

Root one manual mounted scenario:
1. In a disposable source create precisely the contents above. Open Share through the existing coworker menu. Confirm all optional sections are initially off and source credentials/grants/history are excluded.
2. Review all-off once; optional members must be absent. Then opt in memories/database/files and review: 1 note, 1 private table, 1 saved view, 1 allowed file; inspect canonical bytes/counts and credential exclusions before export.
3. Export local archive, open the existing Import dialog, inspect the same manifest/digest and exclusions, import once. No hosted publication.
4. Cold restart. Open the single fresh disabled copy; compare notes/file exact bytes, SQL row and saved view, verify new identity/default-off grants/no source connection or sentinel. Retry original receipt and confirm no second coworker.
Run appended binding case plus existing mounted dialogs, memory/database capture/restore, portable lifecycle/recovery suites. Existing binding fixture is Darwin-only and uses the established rename-helper test support; no helper/install/build executed by this lane. All tests/builds/Mac QA UNRUN. No live accounts, publication, push, installation or native changes.
