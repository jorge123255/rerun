# Desktop Actions inbox (pending questions + approvals)

Port of the original Rerun actions-inbox presentation into the Mac app, as a read-only
projection of the shared attention endpoint. Reference commit `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`
(`apps/ui/components/notifications/WorkspaceInbox.tsx`, `InboxDetailCard.tsx`, and
`packages/ui/src/inbox/*` inbox primitives).

## What was added

- `apps/ui/components/desktop/useDesktopAttention.ts`
  Scoped loading/polling hook for `GET /api/desktop/attention`. Follows the existing
  `useBoardActivity` + `useVisibleInterval` pattern: one in-flight read at a time (guard ref),
  `AbortController` per read, no state writes after abort/unmount, retry at the next tick on
  failure, polling stops while the window is hidden. `active` gates polling on the panel being
  open; flipping it off aborts an in-flight read and flipping it on reads immediately. A failed
  read keeps the last good list but sets `status: 'failed'` — a failed read is never shown as an
  empty or fully resolved workspace. Exposes `{ status, items, unavailableAgentIds, checkedAt, retry }`.

- `apps/ui/components/desktop/DesktopActionsInbox.tsx`
  `ChromePill` trigger (bell + count / checking / unavailable) that grows a card: "Actions"
  header with count, partial-unavailable banner from `unavailableAgentIds`, failed-state banner
  with Retry, "Checking for pending actions…" while the first read is out, the original
  "Nothing to handle" empty state for a genuine zero, and one "Needs you" section of rows.
  Rows mirror `@rerun/ui/inbox` `InboxRow` exactly (status dot, `AttentionBuddy`, summary line,
  `agentName · title` subline, `shortRelativeTime`, hover/focus/keyboard activation) minus the
  Mark-as-read button, which this slice must not offer. `kind` maps to the original status meta:
  `question → awaiting_question` (Question, cyan), `approval → awaiting_approval` (Approval, yellow).
  Disabled coworkers carry the shared `DISABLED_AGENT_LABEL` ("Inactive") chip and still open.
  Opening a row calls `onOpenConversation({ id: item.sessionId, agentId, agentName, title })` —
  navigation only, exactly the `DesktopConversationHit` that `DesktopApp` already maps to
  `selectCoworker(hit.agentId, hit.id)`.

- `apps/ui/components/desktop/DesktopActionsInbox.test.tsx`
  Focused regression cases in the `DesktopBoard.test.tsx` style (happy-dom, fetch stub, fake
  timers). Authored, not executed — validation is the integration owner's.

## Mounting (root)

Minimal, self-contained: place the widget anywhere on the board and hand it the existing
conversation opener:

```tsx
<DesktopActionsInbox
    className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40"
    onOpenConversation={hit => onOpenConversation?.(hit)}
/>
```

- The widget manages its own open state; pass `open`/`onOpenChange` to control it.
- Polling runs only while open (and the window is visible). A closed pill shows the last known
  count; the first open triggers an immediate read.
- No edits to `DesktopApp`/`DesktopBoard`/`DesktopWorkspaceMenu` were needed: `DesktopApp` already
  wires `onOpenConversation` to `selectCoworker(agentId, sessionId)`.

## Integration notes

- Consumes the base schema `desktopAttentionSchema` + `DESKTOP_ATTENTION_URL` from
  `apps/ui/lib/desktop/attention.ts`; nothing there was edited. The endpoint route is Root's and
  was not probed.
- This slice performs no accept/approve/decline/mark-handled, grants no tools, and executes no
  actions. Accepted receipts disappearing from the next read remove only those resolved items
  (the list is a pure projection of each read). No system notifications, push/email, or fake
  completed-item history.
- Row summary renders as text; the schema caps it at 280 characters.
- A partial read (`unavailableAgentIds`) shows a banner and still lists the reachable items; it is
  not presented as empty.

## Unverified limitations

- Tests authored but not run; no lint/typecheck/build executed (integration owner runs all
  validation and Mac restart acceptance). Mac acceptance is not claimed.
- The `/api/desktop/attention` contract is assumed exactly as `desktopAttentionSchema`; any
  drift (missing fields, different casing) fails the parse and reads as a failed/retry state.
- Polling stops when the panel is closed, so a closed pill's count is stale until reopened —
  deliberate per the "stop polling when closed/hidden" requirement.
- Row layout intentionally drops the original Mark-as-read affordance (unsupported here); the
  row is otherwise a faithful clone of `InboxRow`.
- Only `question` and `approval` kinds render; unknown kinds parse-fail the read rather than
  rendering a guessed status.
