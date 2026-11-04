# Next desktop port round — November 4, 2026

Source base for the four external lanes: `22a40524067ec8f36267a802e35ad5ca63dcad47`. This contains the accepted draft release plus the shared attention response schema. Original Rerun reference remains `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

| Owner | Slice | Worktree / branch |
| --- | --- | --- |
| A | D5: original Files Delete flow with confined paths and confirmation | `rerun-desktop-worktrees/file-delete-next` · `desktop/file-delete-next` |
| B | C8: original live context-compaction presentation; no invented history metrics | `rerun-desktop-worktrees/compaction-next` · `desktop/compaction-next` |
| C | B5: original Control Center for available local actions | `rerun-desktop-worktrees/control-center-next` · `desktop/control-center-next` |
| D | C7: original Actions inbox for pending questions and approvals | `rerun-desktop-worktrees/actions-inbox-next` · `desktop/actions-inbox-next` |
| Integration owner | B3: waiting-for-you board tile, exact pending-chat navigation and shared read-only attention projection | coding worktree `rerun-desktop` · `desktop/m1` |

All paths are under `/Users/gszulc/OpenBot/Shared/`. The four worktrees are prepared; prompts are supplied to the user for dispatch. That does not imply the external agents have started or completed their changes.

Only the integration owner runs tests, lint/type checks, builds, installation, live model requests and native app testing. C may resume coding; its prior stop on app/data manipulation remains in effect. No lane changes real workspace data or credentials, creates another app installation, pushes, or merges.

Root owns DesktopApp/DesktopBoard/global shortcut mounting this round. C and D export components and typed callbacks with integration notes rather than modifying the app shell independently. D consumes `lib/desktop/attention.ts` and GET `/api/desktop/attention`; root owns the authenticated read-only aggregation route. Opening an inbox item does not answer, accept, dismiss, execute or grant anything. Unknown or partial reads remain distinct from an empty list.

A follows original Files behavior, B reuses CompactionStep/CompactionBlock, C reuses ControlCenterView, D follows WorkspaceInbox and the shared inbox primitives, and root reuses the original waiting tile. The engine compaction checkpoint lacks persisted display counts, so B must state its live-only history limitation. Full parity groups remain open until all their remaining slices are installed and accepted.

## Integration status after root acceptance

B3 is installed from `0f2034adf6d15c067522c347a8142363262acbd5`; `e5853b5152dc6e14415f135353d1eba373c22b28` changes only a test fixture. Root passed 3,381 UI cases (31 skipped), production build/type checks, real Codex board/question/approval checks, pending and resolved restarts, draft isolation and original-data preservation. The two disposable coworkers were removed after a byte-verified recovery copy.

A and C remain at the prepared source base at this snapshot; no completion is claimed. B delivered `574d5a039afa2d3a136d1883bc29b2e2417ba4bf`, and D delivered `72518735cc7e45cc226449bed5131cd4ee8be38a`. Both are source-only and unintegrated. Read-only review found the following required follow-ups; all execution and Mac acceptance remain root's responsibility.

- B: stopping or losing a stream must not turn an unconfirmed running compaction into a confirmed error. Suppress the unfinished row or use neutral interruption wording, keeping explicit engine errors distinct.
- D: stabilize the polling callback to prevent a fetch/render loop; distinguish initial/partial-empty reads from confirmed zero pending; offer retry for partial failures; restore pill focus only for explicit close/Escape. During mounting, root must guard navigation against removed coworkers and stale item identities. Opening an item remains navigation only.

The separate follow-up prompts preserve each lane's worktree and forbid tests, app/data changes, builds, installation and publication. No B/D code from this round is included in the installed app yet.
