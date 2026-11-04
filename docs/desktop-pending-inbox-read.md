# Desktop pending-inbox Mark-as-read

This slice ports the original pending-row "Mark as read" and confirmed "Mark all as read" onto the
Mac Actions inbox's pending section, with durable per-coworker read receipts that never answer,
approve, decline, execute or grant a tool. The shared attention endpoint, the board "Needs you"
wiring, the engine pending cards and the answer/approval receipts are untouched. Source and tests
are described below; the root agent records exact build and native acceptance separately. This
handoff is not an acceptance report.

## Reference commits

- Base (this lane's head): `c6744ef7178b2a59d26a5af3298942b2a6dfc293`, branch `desktop/pending-inbox-read`.
- Original Rerun inbox: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`
  - `apps/ui/components/notifications/WorkspaceInbox.tsx`: pending rows under « Needs you », the
    per-row Mark-as-read (CheckCheck) and the confirmed "Mark all as read" header button with the
    exact copy: "Mark everything as read?" + `${count} item(s) will leave this list. Requests
    still waiting on an answer are cleared too, without being answered.` + confirm label
    "Mark all as read".
  - `apps/ui/app/api/_services/inbox.service.ts`: the web inbox is a read-only projection; only
    `markSessionsHandled` acknowledges, and it never answers a question or approval.
  - `packages/ui/src/inbox/InboxSurface.tsx`: the row/buddy/relative-time presentation and the
    CheckCheck iconography reused by the desktop rows.

No archive or history view was invented: a receipt only hides the pending row from this inbox, and
the chat cards (and the board) keep showing the request until it is answered.

## Read receipts

`apps/ui/lib/desktop/server/pending-inbox-db.ts` owns an isolated schema initializer
(`initializeDesktopPendingInbox`) and `DESKTOP_PENDING_INBOX_SCHEMA` — a single
`desktop_pending_inbox_seen` table keyed on the attention item id with local owner/session foreign
keys (`ON DELETE CASCADE`) and a `kind` check. The item id is the sha256 identity the shared
question/approval resolvers already publish: `[agent.id, session.id, sourceMessageId, toolCallId,
fingerprint]` (approval ids are `'approval'`-prefixed). Because the receipt is keyed on that exact
pending-request identity, a new request in the same chat has a new id and always reappears, and no
receipt is ever written by session alone.

Root wiring (typed): in `apps/ui/lib/desktop/server/database.ts`, inside the existing
`async function initialize(dataRoot: string)` where `initializeDesktopCompletions(client)` is
called, add

```ts
import { initializeDesktopPendingInbox } from './pending-inbox-db'
// ...
await initializeDesktopPendingInbox(client)
```

before the first chat or Actions read. The initializer is idempotent and independent of routes so
startup can activate the table without an import cycle; each server read also lazily ensures it as
a safeguard, so the endpoints work even before the wiring lands.

## API

- `GET /api/desktop/pending-inbox` — `readDesktopPendingInbox`: the unchanged shared
  `readDesktopAttention` projection with the inbox's own receipts subtracted. Same shape as
  `GET /api/desktop/attention` (`items`, `unavailableAgentIds`, `checkedAt`); a partial read still
  names unavailable coworkers and never masquerades as an empty workspace.
- `POST /api/desktop/pending-inbox/read` — `markDesktopPendingInboxRead`: body
  `{ items: [{ id, kind, agentId, sessionId }] }` (max 500, `.strict()`). Each target is
  revalidated against the session's *current* pending request: the server ignores the binding
  claims except for locating the session, re-reads `readDesktopQuestion`/`readDesktopApproval`,
  and stores a receipt only when the recomputed identity equals the published id. Stale, forged,
  wrong-kind, unknown or unreachable targets are returned in `failedIds` and store nothing.
  Retries are idempotent (`ON CONFLICT(item_id) DO NOTHING`) and a final write transaction
  re-checks the live session binding, so a deletion or rebinding during the engine reads cannot
  acknowledge a different chat. The reply is always `{ marked, failedIds }` (200): a partial
  outcome is explicit and the client keeps those rows visible with retry. The scan is bounded to
  four concurrent engine re-reads and one 2.5-second deadline; sessions cut short by the deadline
  are never acknowledged. Both routes use the existing desktop authentication/origin checks, and
  the POST returns 400 on any malformed body.

Nothing here writes `desktop_question_answers`, `desktop_approval_answers` or request rows:
marking read never answers, declines, approves, executes or grants a tool.

## UI

- `apps/ui/lib/desktop/pending-inbox.ts` — client contract: inbox schema, read-target type,
  `{ marked, failedIds }` result schema, URL constants and `readTargetOf(item)`.
- `apps/ui/components/desktop/useDesktopPendingInbox.ts` — new inbox-specific hook. Polls the
  pending inbox while the panel is open and the window is visible (same
  `useVisibleInterval`/in-flight-guard/abort pattern as `useDesktopAttention`). Mark-read is
  explicit and non-optimistic: rows hide only after the server confirms. Failed targets stay keyed
  for `retry` re-post; polling never re-posts a failed mark. Opening a row never acknowledges.
- `apps/ui/components/desktop/DesktopActionsInbox.tsx` — the pending section now uses the new hook.
  Each pending `ActionRow` gained the original hover-checked per-row Mark-as-read button
  (`aria-label="Mark as read"`); the header button covers pending **and** Done through **one**
  `ConfirmDialog` with the original copy and count captured at confirmation opening. The unified
  mark-all posts the captured pending item targets and, through a backward-compatible
  `markAllRead(exact?: string[])` on `useDesktopCompletions`, the captured Done completion ids.
  A later arrival after the dialog opened stays unread. A failed pending mark shows its own Retry
  banner; rows stay visible. `openItem` remains navigation-only (no auto-acknowledgment), and Done
  per-row mark-read and auto-acknowledge-on-visible-conversation are preserved.

## Constraints

- Marking read never answers, declines, approves, executes, or grants a tool.
- Receipts are keyed on the exact pending-request identity (owner + session + question/approval
  source message, tool-call and fingerprint), never on session alone: a new request in the same
  chat reappears.
- Receipts are durable per coworker, survive restart, and cascade with deleted chats/coworkers.
- Mark-all captures only the displayed pending/completion ids at confirmation opening; later
  arrivals remain unread.
- Partial/unknown reads and partial write failures remain visible with explicit Retry; the API
  never reports complete success for a partial mark.
- No automatic pending acknowledgment on ordinary navigation or polling.
- Shared attention, board "Needs you", engine pending cards, answer/approval receipts and send
  gates are unchanged. `useDesktopAttention` is no longer consumed by this inbox but stays for
  other desktop surfaces.

## Changed files

- `apps/ui/lib/desktop/pending-inbox.ts` (new) — client contract and receipt helper.
- `apps/ui/lib/desktop/server/pending-inbox-db.ts` (new) — isolated schema initializer.
- `apps/ui/lib/desktop/server/pending-inbox.ts` (new) — read + revalidating mark-read API.
- `apps/ui/app/api/desktop/pending-inbox/route.ts` (new) — GET.
- `apps/ui/app/api/desktop/pending-inbox/read/route.ts` (new) — POST.
- `apps/ui/components/desktop/useDesktopPendingInbox.ts` (new) — inbox hook.
- `apps/ui/components/desktop/DesktopActionsInbox.tsx` — pending Mark-as-read, unified confirmed
  Mark-all, read-error Retry.
- `apps/ui/components/desktop/useDesktopCompletions.ts` — `markAllRead(exact?)` (backward
  compatible; no-arg behavior unchanged).
- `apps/ui/components/desktop/DesktopActionsInbox.test.tsx` — updated routing
  (`/api/desktop/pending-inbox`), dialog-first Done mark-all, and new pending regressions.
- `apps/ui/app/api/desktop/pending-inbox/route.test.ts` (new) — route-level regressions.

## Authored regression coverage

- Pending row Mark-as-read posts the exact `{ id, kind, agentId, sessionId }` and hides only that
  row; the other row and navigation stay intact.
- Unified confirmed Mark-all captures pending + Done at confirmation opening; a poll-arriving new
  item after the dialog opened stays unread, and the count is not swept upward.
- A new request in the same chat reappears after the earlier one was marked read, and the stale
  receipt cannot block it.
- Pending mark-read failure keeps the row visible with a Retry that re-posts exactly the failed
  targets and recovers; polling never re-posts.
- Opening a pending row navigates and never marks it read.
- Route tests: GET filters receipts; mark-read revalidates and is idempotent across retries;
  never writes answer/approval/request rows; new-request reappearance; stale/forged/unknown
  targets → `failedIds`; unreachable engine read → partial `failedIds` then retry recovery;
  cascade deletes; auth 401/403; malformed/empty bodies → 400; deadline cancels stalled engine
  reads without acknowledging.

All execution, full-suite validation, packaging and native Mac acceptance remain root-owned.

## Proposed verification (root)

1. `pnpm -C apps/ui test DesktopActionsInbox` and `pnpm -C apps/ui test pending-inbox` (component
   + route regressions).
2. Typecheck/lint/build of the UI app with the database wiring applied.
3. Live app: open Actions, mark a pending question read — the row leaves the inbox, the chat card
   still shows the question until answered; answer it from the chat and confirm no inbox receipt
   was needed; ask again in the same chat and confirm the new request reappears unread.
4. Mark all with both pending + Done present, confirm the original dialog copy and count, and
   confirm a request arriving mid-dialog stays unread.
5. Kill the app between a mark and a re-open: receipts persist.
