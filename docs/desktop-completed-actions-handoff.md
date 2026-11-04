# Desktop Actions inbox — Done section (finished runs / completions)

Follow-up slice to `desktop-actions-inbox-next-handoff.md`: ports the original Rerun *completed
run* items into the Mac Actions inbox. A finished run becomes a genuine "Done" card at the
terminal-event boundary — never derived from `runs.status` and never backfilled from history.

Reference commit `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/notifications/WorkspaceInbox.tsx` — the Done section, `markSeen` on open,
  `markAllSeen` for the Mark-all button, the "Message completed" fallback copy.
- `apps/ui/lib/notifications/unseen-runs.ts` — the fold projection (scheduled runs under their
  slug with a ×count, chat runs under their conversation) that `groupCompletions` mirrors.
- `packages/ui/src/inbox/InboxSurface.tsx` — Done status "Finished" (emerald), `CheckCheckIcon`
  Mark-all in the card header, the original empty state.
- `apps/ui/app/api/_services/notification.service.ts` / `inbox.service.ts` — the done filter and
  the cancelled-discard rule that this slice re-implements at the engine boundary.

## What was added

### Engine (own: completion store + bounded route + terminal hook)

- `apps/engine/src/db/completed-runs.ts` (new)
  Module-owned per-agent system-db table `run_completions` (runId as the stable PK identity) with
  `RUN_COMPLETIONS_DDL`, idempotent `ensureRunCompletions`, `recordRunCompletion`, and
  `listRunCompletions`. The final-answer text is bounded to 2000 characters. The table is lazily
  ensured by the module; root can fold `RUN_COMPLETIONS_DDL` into the central `SYSTEM_DB_MIGRATIONS`
  ladder (`apps/engine/src/db/systemDb.ts`) as a new `version: N` step calling
  `ensureRunCompletions(client)` — until then the lazy ensure covers it.

- `apps/engine/src/runtime/run-events.ts`
  `emitRunTerminal` now records a completion when `desktopApp() && kind === 'done' && !cancelled`.
  This is the one genuine "finished run" boundary: a turn that ends on a pending question/approval
  emits a HITL event, not a terminal, and cancelled/error terminals never record a success. The
  write is best-effort (`.catch(() => {})`), like the notification it sits beside. The cancel route
  re-emits terminals with `cancelled: true`, so Stop never becomes a Done card.

- `apps/engine/src/http/routes/runs.ts` + `apps/engine/src/desktop/policy.ts`
  New bounded read `GET /agents/:id/runs/completions?limit=&before=` (registered before the
  `/:rid` catch-all). `before` is the `(completed_at, id)` cursor the desktop pagination returns;
  ordering is `completed_at DESC, id DESC`. The desktop GET gate regex now allows `/runs/completions`.

### UI client

- `apps/ui/lib/engine/client.ts`
  `engineRunCompletionSchema` / `engineRunCompletionsListSchema` / `EngineRunCompletion` and
  `listAgentCompletions(conn, agentId, { limit, before, signal })`. Deliberately a different read
  than `runs?status=done` (see note in code).

### Desktop (own: contract, server module, routes, hook, component)

- `apps/ui/lib/desktop/completed-actions.ts` (new)
  The contract + pure projection: `CompletionRow`, `boundedMessage` (200-char cap, "Message
  completed" fallback), `groupKeyOf`/`groupCompletions` (agent:source:slug for scheduled/trigger,
  else sessionId; newest first; ×count), `cursorOf`/`parseCursor` (stable `(time, id)` cursor,
  split at the last `__`), `desktopCompletionsSchema`, and `DESKTOP_COMPLETIONS_URL` /
  `DESKTOP_COMPLETIONS_READ_URL`.

- `apps/ui/lib/desktop/server/completed-actions.ts` (new)
  Module-owned desktop schema (`desktop_completions_seen` for seen state, one-row
  `desktop_completions_state(enabled_at)` for the first-enable cutoff) ensured by
  `initializeDesktopCompletions(db)` — root may call it beside the other CREATE TABLE statements in
  `apps/ui/lib/desktop/server/database.ts`; the module also ensures it lazily. `readDesktopCompletions`
  fetches up to 100 completions per current local coworker (4-way concurrency, 2.5 s deadline,
  in-flight dedupe), drops rows before the cutoff and rows whose engine session no longer maps to a
  current local session, filters out previously seen completion IDs, folds, and slices the page.
  `markDesktopCompletionsRead` writes exactly the posted completion IDs (explicit authenticated
  mark-read; a newer arrival's different terminal ID is never cleared).

- `apps/ui/app/api/desktop/completions/route.ts` (GET, bounded + `nextCursor`) and
  `apps/ui/app/api/desktop/completions/read/route.ts` (POST, exact completion IDs).

- `apps/ui/components/desktop/useDesktopCompletions.ts` (new)
  Polls the completion read while the panel is open and the window is visible (same
  `useVisibleInterval` + one-in-flight + abort-on-close pattern as `useDesktopAttention`).
  `markRead(item)` posts the item's exact completion IDs and hides it locally; `markAllRead` posts
  exactly the completion IDs currently displayed. `visibleSessionId` applies the original
  read-on-visible-conversation semantics: a finished run in the conversation on screen is
  acknowledged as it lands (while open + visible). A failed read is never shown as an empty list.

- `apps/ui/components/desktop/DesktopActionsInbox.tsx`
  New `visibleSessionId` prop; a "Done" section under "Needs you" rendered from the completion
  read. `DoneRow` mirrors the original Done row (emerald `ATTENTION_STATUS_META.done` dot, buddy,
  final-answer summary or scheduled slug, "… finished its run", ×count, `shortRelativeTime`,
  explicit Mark-as-read). Opening a done row navigates (`onOpenConversation`) and marks its group
  read (original `openItem → markSeen`). Header shows `· N done`, a Mark-all (`CheckCheckIcon`)
  covers exactly the displayed completion IDs, the pill shows `N pending · M done`, and the empty
  state now reads "When a coworker needs you or finishes a run, it lands here." Completions
  failure/partial reads get their own Retry banners.

- Tests (authored, not run): `apps/ui/lib/desktop/completed-actions.test.ts` (pure fold/bound/
  cursor) and additions to `apps/ui/components/desktop/DesktopActionsInbox.test.tsx` (Done rows,
  per-row and Mark-all mark-read payloads, open→mark, visible-conversation auto-mark, completion
  failure note; existing call-count tests updated for the second endpoint).

## Mounting / integration contract (root)

The widget is already mounted; root now supplies the on-screen conversation so completions read
themselves as they land:

```tsx
<DesktopActionsInbox
    agents={...}                          // optional roster, unchanged
    onOpenConversation={hit => ...}       // unchanged
    visibleSessionId={selectedSessionId}  // NEW: the conversation currently on screen
/>
```

- `visibleSessionId` is optional. When set, finished runs of that conversation are acknowledged
  while the panel is open and the window is visible; a closed panel or hidden window is
  side-effect-free.
- Root may call `initializeDesktopCompletions(db)` from the central desktop database
  initializer; until then the module ensures its two tables lazily on first read/write.
- Engine root may fold `RUN_COMPLETIONS_DDL` into `SYSTEM_DB_MIGRATIONS` as a new step;
  until then `ensureRunCompletions` covers the per-agent system DB lazily.
- No edits to `DesktopApp.tsx` / `DesktopBoard.tsx` / `DesktopConversation.tsx` were made or needed.

## Semantics & limits (deliberate)

- **First-enable cutoff.** `desktop_completions_state.enabled_at` is written once, at first
  initialization. The list covers completions recorded after it; historical `done` rows are never
  backfilled. A new install starts the cutoff at its own first enable.
- **No status/receipt derivation.** Completions come only from the `emitRunTerminal` hook
  (`done` + not cancelled). A stored `status = done` that ended on a pending question/approval
  never becomes a card; Stop/error/HITL never do either.
- **Seen state survives restarts.** It lives in `desktop_completions_seen` (desktop DB), not in
  memory; an acknowledged card never reappears after a relaunch.
- **Mark-read is exact.** The client posts the displayed completion IDs; newer arrivals in the
  same conversation or scheduled task (different terminal identities) are not cleared. A failed
  mark-read rolls back locally and the next read re-shows the row.
- **Bounded reads.** Per-agent window of 100, page ≤ 50 groups, cursor-paginated on terminal
  identity/time; deletion/partial reads are surfaced honestly (`unavailableAgentIds`), and
  completions whose engine session no longer maps to a current local conversation are dropped.
- **Polling only while open + visible.** A closed pill's done count is the last known one until
  reopened. No macOS notifications, no background delivery, no schedules/connectors.
