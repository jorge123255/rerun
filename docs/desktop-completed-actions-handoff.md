# Desktop Actions inbox — Done section

This slice ports genuine completed-run items into the Mac Actions inbox. It does not infer a
completion from `runs.status`, invent results from model prose, or backfill historical runs.
Source and tests are described below; the root agent records exact build and native acceptance
separately. This handoff is not an acceptance report.

## Original Rerun references

Reference commit: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

- `apps/ui/components/notifications/WorkspaceInbox.tsx`: Done rows, mark-seen on opening a group,
  explicit mark-read and Mark-all, and “Message completed” fallback.
- `apps/ui/lib/notifications/unseen-runs.ts`: chat groups by conversation and scheduled groups
  by owner/source/slug, newest summary and ×count.
- `apps/ui/stores/unseen-runs.store.ts` and `components/chat/AgentChat.tsx`: opening a chat reads
  its results, and a result arriving in the focused visible conversation is read as it lands,
  independently of whether the inbox panel is open.
- `packages/ui/src/inbox/InboxSurface.tsx`: emerald Finished status, buddy, relative time,
  CheckCheck Mark-all icon and original empty-state design.
- `apps/ui/app/api/_services/notification.service.ts`: genuine terminal completion and cancelled
  discard semantics.

## Engine capture and reads

`apps/engine/src/db/completed-runs.ts` owns the per-agent `run_completions` table and idempotent
`ensureRunCompletions`. `recordRunCompletion` stores terminal identity, owner/session, trigger,
timestamp and a final-answer summary bounded to 2000 characters. The first record for a run ID
wins. Run IDs are unique inside each coworker database, not assumed globally unique.

`runtime/run-events.ts` captures only desktop `done` terminals without `cancelled`. Pending
questions/approvals use the existing HITL event path; Stop and error terminals never become Done
cards. The local completion write is awaited and retains an agent-work lease until SQLite
finishes. Desktop settlement releases its session claim and waiters after terminal persistence.
A failed write is logged and cannot strand Stop; a disk failure does not promise a Done card.
Hosted settlement behavior is retained.

`GET /agents/:id/runs/completions` supports two bounded query modes:

- `limit` and `before`: descending terminal time/ID. `before` is validated JSON containing
  `completedAt`, `id` and optional `inclusiveId`, used to retain equal-ID ties across owners.
- `ids`: a JSON array of at most 100 exact terminal IDs for acknowledgment validation. It cannot
  be combined with `before`. Malformed filters return 400.

The desktop policy permits this existing completion route. `lib/engine/client.ts` exposes its
typed schema and `listAgentCompletions(conn, agentId, { limit, before, ids, signal })`.

## Desktop persistence and API

`lib/desktop/server/completed-actions-db.ts` is a lightweight initializer with no database/route
import cycle. `database.ts` calls `initializeDesktopCompletions(db)` during startup, before the
first chat or Actions read. The one-time `desktop_completions_state.enabled_at` cutoff therefore
does not hide results merely because Actions was opened for the first time later. Lazy ensure
remains an idempotent safeguard. Historical `done` rows are never backfilled.

`desktop_completions_seen` stores opaque completion identities with local owner/session foreign
keys, so deleting a chat or coworker removes its acknowledgment records. Each identity binds the
local owner, engine owner, engine session and terminal ID. Equal run IDs in two coworkers do not
share acknowledgment state.

`GET /api/desktop/completions` returns
`{items, unavailableAgentIds, enabledAt, nextCursor, checkedAt}`. The default page consumes 20 raw
terminal rows, with a maximum of 50. Filtering and grouping happen **after** that raw boundary.
Acknowledged, unmapped or pre-cutoff rows still advance the cursor. A page can therefore contain
no displayed rows and a non-null `nextCursor`; older unread rows remain reachable even behind
more than 100 acknowledged rows. Interleaved groups cannot advance past an unreturned chat.

The opaque versioned cursor includes terminal time, terminal ID and local owner. IDs containing
underscores round-trip without delimiter splitting. Each owner contributes at most page-size
plus one engine rows, using four concurrent reads and one 2.5-second deadline. Final ownership,
engine binding, deletion state and exact local session mapping are read in one database snapshot.
Failures name unavailable owners rather than inventing an empty workspace.

`POST /api/desktop/completions/read` accepts only `{completionIds: string[]}` (maximum 500).
Every identity is checked against genuine engine completion rows through bounded exact-ID
lookups. A final write transaction rechecks local ownership, engine/session binding and deletion
state. Only those validated IDs are acknowledged; retries are idempotent and a newer arrival in
the same chat remains unread. Arbitrary, future, foreign or stale identities cannot create seen
receipts. Both endpoints use the existing desktop authentication/origin checks.

## UI and integration

`lib/desktop/completed-actions.ts` contains the shared projection, schema, owner-bound identities
and cursor helpers. `DesktopActionsInbox` reuses the original Done row styling under Needs you:
emerald status/buddy, bounded final-answer summary, relative time, grouped count and explicit
mark-read. Opening a Done row navigates to its exact coworker/chat and acknowledges the displayed
group. Pending questions and approvals still require their existing chat cards.

`useDesktopCompletions` polls while the inbox is open **or** a readable conversation is visible.
Load more explicitly traverses older raw pages, including empty visible pages with a cursor.
Groups merge by stable group ID and exact completion IDs; counts/session IDs are deduplicated and
the newest summary/target wins. The client bounds retained results to 200 terminal identities
and ten pages, with an explicit window-limit state. Counts describe the loaded window.

`markRead` and `markAllRead` submit only displayed identities. Acknowledgment failure stays
visible with explicit retry instead of immediately reposting in a loop. A stale read cannot
reintroduce IDs already acknowledged locally. Read and partial-failure states remain explicit.

The actual readable saved conversation flows through
`DesktopConversation → DesktopChatTabs → DesktopApp → DesktopBoard → DesktopActionsInbox` as
`visibleSessionId`. Requested navigation IDs are not treated as proof that a transcript rendered.
Loading, generating, hidden tabs, settings, dialogs and quit flow do not establish readable chat
visibility. Automatic acknowledgment additionally requires a visible, focused app and no covering
dialog. It works with the inbox closed. A mixed-session group remains for explicit acknowledgment
instead of clearing unseen members when only one member is on screen.

With neither surface active, the pill retains the last known count. No native notifications,
background delivery, schedules or connectors are introduced.

## Authored regression coverage

- Pure fold, summary bounds, opaque identity isolation and cursor round-trip.
- Desktop API default limits, interleaved raw pagination, more than 100 seen rows, same terminal
  IDs across owners, restart/idempotent acknowledgment, auth, forged IDs, deletion/rebinding,
  disabled owners, cleanup, partial failures and shared deadline/concurrency limits.
- Actual engine DB persistence/reopen, first-write idempotency, metadata, ownership, bounded text,
  strict/inclusive tied cursors and exact-ID lookup; engine HTTP filter validation.
- Awaited terminal write, surfaced persistence failure, skipped Stop/error/hosted capture.
- Hook/component rows, exact mark-read, paging, visibility/lifecycle and failure behavior.

All execution, full-suite validation, packaging and native Mac acceptance remain root-owned.
