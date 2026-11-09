# Next H — saved Foreman answer feedback (source handoff)

This source adds the original thumbs row under saved Foreman assistant answers, backed by a local,
private feedback authority. A vote is accepted only for an assistant reply that is still present in
the exact reopened Foreman chat; live, foreign, stale and deleted replies are refused. There is no
copy, regenerate, dialog, provider call or external send. Codex owns tests, builds, Mac board testing
and cold restart.

## Worktree and base

- Worktree `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-h-foreman-reply-feedback`
  did not exist and was created fresh.
- Branch `desktop/next-h-foreman-reply-feedback`
- Base commit `f44abb53ee5171a42735a0e78f3dc3998a05db0c`
- Base tree `ca61851152b5793d44ef31d5746fe53cd4a54938`
- Clean status at start.

The chosen base is the H answered-question recap commit, because this task says to preserve the
restored question recap. The original comparison pin for the Foreman UI is
`c33c020ffb33263ec29de6f76d9b269bca786d90`.

## Original implementation compared

- `apps/ui/components/foreman/ForemanChatLayer.tsx` — passes `actions` (regenerate + `onRateMessage`
  + `ratingOf`) into each `FloatingMessage`.
- `apps/ui/components/chat/MessageView.tsx` — renders `MessageActions` under a finished assistant
  answer only (`!isActive`, non-empty text) with `FeedbackAction` thumbs (`aria-pressed`, tooltips
  "Good response" / "Bad response").
- `apps/ui/components/foreman/ForemanColumn.tsx` — engine foreground uses
  `useMessageFeedback(sessionId, 'foreman')`.
- `apps/ui/hooks/useMessageFeedback.ts` — reads saved votes, optimistic thumbs, undo, read-back
  reconciliation.
- Mac counterpart: `apps/ui/components/desktop/foreman/*` and the existing local
  `useDesktopReplyFeedback` / `apps/ui/lib/desktop/server/reply-feedback.ts` authority for ordinary
  coworker chats. The ordinary table cannot be reused because the Foreman chat is not a
  `desktop_sessions`/`desktop_agents` row.

## Implemented

- `apps/ui/lib/desktop/server/foreman-feedback.ts` — lane-local table
  `desktop_foreman_feedback(id, workspace_id, chat_id, message_id, rating, updated_at)`, idempotent
  `CREATE TABLE IF NOT EXISTS`, chat ownership check, upsert with stable vote id on an unchanged
  rating, and exact delete.
- `apps/ui/app/api/desktop/foreman/feedback/route.ts` — authenticated local GET/PUT/DELETE:
  - `GET` reads the exact Foreman state and returns only votes whose message is still a saved
    assistant answer with visible text.
  - `PUT` requires the exact workspace/chat, rejects `view.live` with 409, and requires the exact
    `engine-*` assistant message with non-empty saved text.
  - `DELETE` removes one vote by id from the exact workspace/chat.
  - No model call, provider request or transcript content leaves the app.
- `apps/ui/lib/desktop/use-foreman-feedback.ts` — local recovery on open, optimistic up/down,
  same-thumb undo, serialized writes, read-back reconciliation and stale-write rollback.
- `apps/ui/components/desktop/foreman/DesktopForemanAnswerActions.tsx` — the original two
  `MessageAction` thumbs with `aria-pressed`, tooltips and disabled state.
- `DesktopForemanChatLayer.tsx` — optional `answerFeedback` prop; renders the thumbs below a
  restored assistant answer with non-empty text, never while streaming, preserving the history and
  question-recap rendering.
- `DesktopForemanColumn.tsx` — activates the local hook for the exact chat once a saved assistant
  answer exists.

## Persistence and authority

The table is created lazily by the store so this lane does not edit the central database file.
Root may move the same statement into `apps/ui/lib/desktop/server/database.ts`:

```sql
CREATE TABLE IF NOT EXISTS desktop_foreman_feedback (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
    updated_at TEXT NOT NULL,
    UNIQUE (workspace_id, chat_id, message_id)
);
```

Ownership proof: `desktop_foreman_chats` for workspace/chat, then the current `desktopForeman(runtime)`
state for the saved assistant row and its visible text. The route never trusts a client message id
without that lookup. A rating row whose message disappears is filtered out on read and cannot be
written again; an unchanged vote keeps its id so undo targets the same row.

## Changed files

- `apps/ui/lib/desktop/server/foreman-feedback.ts` (new)
- `apps/ui/app/api/desktop/foreman/feedback/route.ts` (new)
- `apps/ui/lib/desktop/use-foreman-feedback.ts` (new)
- `apps/ui/components/desktop/foreman/DesktopForemanAnswerActions.tsx` (new)
- `apps/ui/components/desktop/foreman/DesktopForemanChatLayer.tsx`
- `apps/ui/components/desktop/foreman/DesktopForemanColumn.tsx`
- `apps/ui/app/api/desktop/foreman/feedback/route.test.ts` (new)
- `apps/ui/lib/desktop/use-foreman-feedback.test.tsx` (new)
- `apps/ui/components/desktop/foreman/DesktopForemanAnswerActions.test.tsx` (new)
- `docs/next-h-foreman-reply-feedback-handoff.md` (this note)

## Integration / remaining gates

- The new route and table are self-contained; root should either keep the lazy schema ensure or add
  the SQL above to its central desktop schema and remove the duplicate ensure later.
- Root should confirm the desktop route policy/auth covers the new `/api/desktop/foreman/feedback`
  path; the handler uses the same `desktopRoute` authority as the existing Foreman route.
- No composer, starter pack, question recap, transcript formatter or regenerate path was changed.
- The row is thumbs-only. The original feedback details dialog (category/details) is not included;
  the task asked for the rating to persist and recover, and the local rating alone is stored.
- No external send, provider account, guest state, permission, installed app, credentials, Docker,
  VM/profile or other worktree was touched. No push, PR or merge.

## Verification status

No tests, typecheck, lint, build, packaging, install, live model/API request or Mac board/cold-restart
QA was run by this lane. Authored regressions use offline fetch/store fixtures only. Root/Codex owns
all execution and native acceptance.
