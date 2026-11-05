# Desktop coworker Skills and proposal review

This document describes the current root-integrated source contract. The Skills panel, chat
proposal review, tool catalog and grant, runner registration, confined publication, and shutdown
hooks are wired. It replaces the earlier lane handoff and its unapplied integration snippets.

**Root automated acceptance: pending. Root packaged Mac and restart acceptance: pending.**
The source and authored regressions below describe intended behavior, not a claim that checks
have passed. Root owns all execution and will record the final source identity and results.

## Original Rerun provenance and design

Original source pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

- `apps/ui/components/agent/skills/AgentPanelSkills.tsx`: shelf, Upload menu, Markdown/folder
  import, New, drill-in, labels, and empty state.
- `apps/ui/components/agent/skills/SkillEditor.tsx`, `SkillFilesSection.tsx`, and
  `SkillFileEditor.tsx`: procedure editor and bundled-file management.
- `apps/ui/components/chat/SkillProposalDock.tsx`, `SkillProposalBlock.tsx`, and
  `BrainProposalBlock.tsx`: proposed-change presentation and dock behavior. The desktop reuses
  the shared `packages/ui/src/chat/SkillProposalBlock.tsx` block.
- `apps/ui/app/api/_actions/agent.actions.ts`, `skill-proposal.actions.ts`, and
  `apps/ui/lib/skills/folder-import.ts`: action and import shapes.
- `apps/engine/src/http/routes/skills.ts`, `skills/loader.ts`, `tools/builtin/skills.ts`,
  `tools/builtin/skill-propose.ts`, and `db/repos/skill-proposals.ts`: skill layout, proposal
  records, and original tool behavior.

The desktop keeps the original shelf/editor and proposal design, with authenticated local
routes and a confined filesystem publisher. Skills is mounted in the coworker detail panel and
navigation rail. Active chat proposals appear in the transcript and dock above the composer;
the Skills panel also provides coworker-wide review. Opening a skill from a proposal resolves
the current coworker and applied slug. No marketplace, global skill store, or archive/history
screen is introduced.

## Integrated tools and permission behavior

`packages/contracts/src/desktop-tool-grants.ts` exposes **Skills** as a supported, explicitly
granted coworker capability. The desktop branch of `apps/engine/src/tools/registry.ts` registers
`desktopSkillTools`; it does not also register the hosted filesystem skill tools.

Supported names: `skill_list`, `skill_read`, `skill_read_file`, `skill_write_file`,
`skill_delete_file`, `skill_create`, `skill_import`, `skill_edit`, `skill_update`, `skill_delete`,
and `skill_propose`. Runner admission and the adapter require an enabled coworker,
`tools.skills !== false`, and `tools.desktopToolGrants.skills === true`. Each callback rechecks
current authority and cancellation. `skill_propose` additionally requires
`selfImprovement.enabled === true`.

Human management of an existing local coworker's skills does not require the model tool grant
and remains available while that coworker is disabled. Deleting coworkers are refused. Human
edits, imports, and accepting a proposal never enable the grant or change `tools.skills`.
Applying an accepted proposal is a separate background job and requires the coworker to remain
enabled and the exact proposal to remain accepted.

`skill_propose` only creates a proposal record; it does not publish a skill or pause the chat.
Acceptance authorizes that one proposal. `publishAuthorizedDesktopSkill` refuses calls without
explicit authorization and uses the same confined publisher as human and model edits.

## One confined publication boundary

`apps/engine/src/desktop/skill-publication.ts` is shared by the UI server store and engine
adapter. Shelf listing, full manifest reads, create/import, edit, delete, archive, and
bundled-file access all use this module. Hosted `skills/loader.ts` remains the hosted path.
Desktop skill bytes do not pass through the generic engine file router.

Skills live under
`<dataRoot>/workspaces/1/engine/agents/<engineAgentId>/skills/<slug>`. Connector ownership is read
from that exact engine coworker's `workspace/.rerun/services.json`, using the confined
`ownersInWorkspace` reader. Only an absent registry means no owners; malformed, linked, or
unreadable ownership data fails closed. The registry must contain a plain `services` record.
Connector-owned skills are read-only in the UI and at the mutation boundary. The desktop never
writes that registry.

- Ancestors are opened without following links and pinned by inode (`/.vol/<dev>/<ino>` on
  Darwin and `/proc/self/fd/<fd>` on Linux). Wrong-owner files, hard links, replaced ancestors,
  absolute/traversal paths, and manifest aliases in bundled-file access are refused.
- A kernel `flock` on the validated **skills-root directory inode** serializes publishers across
  UI and engine processes. Replacing the marker file cannot split that lease. The helper lives
  for the lease lifetime; queued acquisition is bounded and cancellable. There is no timer that
  silently expires an active lease.
- UI roster locking orders local owner mutations; it is not the cross-process publication
  boundary. Current local-to-engine mapping, deleting state, connector ownership, pinned roots,
  lease, and operation-specific authority are checked at their admission/publication boundaries.
- New skills use a hidden sibling and exclusive publication. An existing slug is never removed
  for create/import. Create-only bundled files also refuse an existing name.
- Replacements journal the prior file and draft with exact parent and journal identities.
  Successful replacement retains the displaced prior inode under a reserved backup name.
  Interrupted rollback restores the prior ordinary file and exposes the draft under a visible
  recovery name with a conflict; a third-party winner is preserved. Recovery rechecks connector
  ownership for the recorded skill before touching it.
- Retained versions count against storage limits and are not discarded based on an `lsof`
  result. Explicit whole-skill Delete removes the skill and its retained versions. There is no
  user-facing version-history browser.
- Summary listing returns name/description with `body: ''` and `files: []`; full content is
  fetched for the selected skill. Listing checks cancellation/current authority between entries
  and refuses an oversized index instead of silently returning an empty shelf.

## Authenticated management and editor identity

Routes below are under `/api/desktop/agents/[agentId]/skills`, use `desktopRoute` authentication,
and resolve the local coworker to its current engine identity. The UI service/store files are
`apps/ui/lib/desktop/server/coworker-skills.ts` and `coworker-skill-store.ts`.

| Route | Contract |
| --- | --- |
| `GET /`, `POST /` | Shelf; create/import with original action shape. Existing slug is a conflict. |
| `GET /[slug]` | Return `{ skill }`, including the manifest version `identity`. |
| `PATCH /[slug]` | Strict description/body patch with required `baseIdentity`; stale version is a conflict. |
| `DELETE /[slug]` | Delete the local, unowned skill after current owner admission. |
| `GET /[slug]/file?path=…` | Confined text page with `identity` and truthful `truncated`. |
| `PUT /[slug]/file` | Create-only, or replace with `completeRead: true` and the read's `baseIdentity`. |
| `DELETE /[slug]/file?path=…` | Confined bundled-file deletion; never a `SKILL.md` alias. |
| `GET /[slug]/archive` | Confined archive returned as base64 for the existing download flow. |
| `GET /proposals?sessionId=…` | Optional exact local desktop chat ID; omission requests panel-wide review. |
| `POST /proposals/[proposalId]` | Strict decision (`accept` or `dismiss`) and optional local `sessionId`. |

Editors retain the version they read. A missing identity, partial read, or stale version cannot
be saved over a newer file. Partial UTF-8 and unread bytes count as truncation. Model tools can
intentionally replace a file through their separately gated adapter; the human editor cannot
silently discard an unread tail. Returning from a bundled-file editor refreshes the file list
without discarding the unsaved procedure draft.

JSON mutation bodies are bounded by actual streamed bytes and a 10-second admission deadline,
with request cancellation. Create/import allow the 50 MiB folder budget plus 64 KiB of JSON
overhead; manifest/file edits allow 10 MiB plus 64 KiB; proposal decisions allow 4096 bytes.
Invalid JSON, excessive bytes, timeout, and cancellation are explicit failures. Cleanup does not
await a stalled body cancellation indefinitely. This deadline bounds body admission, not the
full accepted-proposal model job.

## Proposal scope, lifecycle, and publication

Chat review resolves the exact owned local session to its engine session. Every proposal row
must match that engine session; owner proof comes from the authenticated agent-scoped endpoint
and current mapping, not an invented `agentId` field on the row. Decisions first find the
proposal in a verified owned session, then recheck owner/session mapping before the engine
mutation and response. Unknown/foreign chats cannot fall back to another chat.

Panel-wide review scans the newest 100 mapped local sessions. More sessions or unreadable
sessions produce a partial snapshot. Responses have `{ availability, proposals, failedSessions? }`:
`complete` replaces rows, `partial` overlays verified rows, and `unavailable` keeps previous rows.
The UI shows incomplete availability with Retry, not an empty successful read.

The hook is scoped by coworker, local chat, active state, and review mode. Hidden chats do not
poll or admit decisions; late loads, decisions, and editor results cannot update a new owner or
generation. Normal polling is every 10 seconds, temporarily every 1.5 seconds while an accepted
proposal is being written. The panel keeps the accepted row visible while writing; chat releases
the accepted dock row to the transcript. Applied and dismissed rows settle through the original
release behavior. An applied result refreshes the relevant shelf.

The original accepted-proposal job generates the complete procedure using its resolved model.
Desktop edits capture manifest identity before asynchronous drafting and compare it when
publishing. Creates remain exclusive. The job rechecks the exact accepted record, current
enabled coworker, connector ownership, and cancellation, then records `applied` or `failed`.
It holds a coworker lifecycle lease so deletion cannot overtake active publication.

`stopDesktopSkillProposals` is wired into desktop shutdown: close admission, abort active jobs,
and wait up to five seconds for settlement. The apply job also has a ten-minute deadline.
Existing startup reconciliation marks interrupted accepted jobs failed for review/retry; restart
does not silently grant tools or replay publication as if it had succeeded.

## Limits and deliberate scope

- Slugs: lowercase letters, digits, and dashes, at most 64 characters.
- Reference files: at most 200; each file at most 10 MiB; folder storage at most 50 MiB.
  Storage includes active files and retained recovery bytes, with at most 1000 retained entries.
  Oversized retained storage refuses another write while keeping prior bytes.
- Bundled text: 100,000-character page, bounded byte window, and a 10 MiB maximum read window.
  The human editor does not save a truncated page as the complete file.
- Tree traversal: depth at most 32 and bounded entry traversal; bundled route paths at most 4096
  characters. Human mutation manifest identities are at most 512 characters.
- Shelf: at most 1000 root entries, 10 MiB aggregate manifest bytes, and 1 MiB summary strings.
- No marketplace downloads, dependency installation, credential copying, or automatic tool
  enablement. Local desktop skills have no hosted template-content lock; connector ownership
  still makes them read-only. Skill content is displayed as text, never executed by the UI.

## Acceptance to be recorded by root

Authored regressions cover confined owner/path/version handling; native cross-process locking
and queued cancellation; exclusive publication, rollback/recovery, and retained storage;
manifest/file identities and bounded bodies; exact local-chat proposal routing; enabled/grant
and cancellation checks; panel/chat editor generations; and proposal acceptance/shutdown.
They are available for root execution and are not acceptance evidence by themselves.

- Final source/build identity: **pending**.
- Automated checks and exact results: **pending**.
- Packaged Mac board → Skills/chat proposal flow, permission refusals, full-restart persistence,
  and preservation of the original workspace after cleanup: **pending**.
