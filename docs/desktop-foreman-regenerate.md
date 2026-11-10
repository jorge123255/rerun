# Saved Foreman answer regeneration — gate and blocker

Lane H (`desktop/next-h-foreman-regenerate`). Source only: no regenerate authority was added,
because none that keeps the original answer exists on this base. This note records the upstream
semantics, the refusal gate that was implemented, and the exact prerequisite that blocks the rest.

## Pins

- Fork finish base **7080add37a60bd604965649319143b8211818fd9**, tree
  **e7db3a3f5df8057ffe86576153a8acff3360481b** (the Mac-tested PR #22 merge), verified clean in a
  new worktree.
- Original Rerun dev **c33c020ffb33263ec29de6f76d9b269bca786d90**.

## Upstream persistence semantics

- Web UI: `apps/ui/components/foreman/ForemanColumn.tsx:304` hands `useForemanChat.regenerate` to the
  answer row; `useForemanChat.regenerate` (`:384`) calls `engineChat.regenerate({ messageId })`.
- Engine regeneration is a **fork**, not an in-place replacement:
  `apps/engine/src/db/repos/regenerations.ts` `forkReply` writes a new session with
  `origin_session_id = source.id`, copies the prefix up to the user turn, and starts a new run. The
  original session and answer are untouched; `desktop_regenerations` (engine system DB) records
  `request_id → source session/message → new session/run`.
- The desktop **coworker** chat already uses that: `DesktopConversation` maps the AI-SDK
  `regenerate-message` trigger to `regenerateMessageId`, `apps/ui/app/api/desktop/chat/route.ts`
  accepts it for an exact `engine-…` id, `startDesktopChat` forwards it, and
  `apps/ui/lib/desktop/server/store.ts` (`regenerationRequestId`) dedupes it per source/message.
- The desktop **Foreman** has no equivalent. Its chat runs through
  `apps/engine/src/desktop/foreman/routes.ts` and the `apps/ui/lib/desktop/foreman-client` action
  set (send, stop, answer question, plan decision, build action); there is no regenerate action,
  the engine foreman route has no `regenerateMessageId`, and the Mac keeps one engine conversation
  per foreman chat with no alternate-session surface beside it. `useForemanChat.regenerate` therefore
  has nowhere to land on the Mac.

## What this lane adds

`apps/ui/lib/desktop/foreman-client/regenerate.ts` — the gate only:

```ts
checkForemanRegenerate(input): { ok: true; messageId } | { ok: false; reason }
```

It refuses, in this order:

1. `no-durable-alternate` — until a durable replacement or a reachable alternate is proven;
2. `foreign-chat` — view or reply from another workspace/chat, or no view yet;
3. `not-engine-reply` — not an `engine-…` assistant reply with text;
4. `active-turn` — any live run;
5. `active-build` — a `reserved`/`running` build;
6. `pending-question` — an unanswered Foreman question;
7. `pending-approval` — a blocked view or a `pending` plan decision;
8. `stale-reply` — the row's revision differs from the revision on screen;
9. `no-preceding-turn` — no saved user turn to ask again.

`FOREMAN_REGENERATE_REFUSAL` carries the sentence the row would show for each refusal; the
`no-durable-alternate` one says the new answer must be kept beside the original.

## What was not done, and why

- No regenerate button was added: with `durableAlternate: false` the gate refuses, and wiring a
  button to a refusal is a dead control. The answer row keeps exactly what PR #22 accepted —
  thumbs only — so the saved answer, its rating and the restored recap are untouched.
- No engine action, route, contract or migration was added: regenerating the Foreman needs the
  engine to fork the **foreman** session and the Mac to adopt that fork while the original stays
  reachable. Both are central to root's foreman registry/mounts.

## Missing prerequisite (root)

Either of these unblocks the lane:

1. **Fork + alternate view.** An engine foreman action that regenerates through `forkReply` for the
   bound foreman chat, a Mac action to start it with an exact `engine-…` id and a stable request id,
   and a way to reach the original answer again (an alternate/thread entry beside the chat, or a
   session switch). Then `durableAlternate` becomes provable and the gate opens.
2. **In-place durable replacement.** A foreman contract where the engine replaces the exact saved
   reply under a revision check and keeps the previous reply recoverable; the Mac then has a
   replacement, not only a fork.

Until one exists, the product decision is to keep regeneration off for the Foreman; the coworker
chat keeps its existing forked regeneration.

## Focused regressions authored (unrun)

`regenerate.test.ts` — the allowed case; every refusal in the order above (durable alternate, live
turn, running build, pending question, blocked/pending decision, stale revision, foreign chat,
non-engine or empty reply, missing question); and the refusal copy for the un-proven alternate.

## Acceptance scenario once the prerequisite lands

From the restored Foreman transcript after a cold restart, regenerate one saved answer: exactly one
new run starts, the original answer stays readable, the new answer is reachable after another
restart, Stop still cancels the new run, the thumbs and recaps of the original are unchanged, and
regenerating while a run/build/question is pending is refused with the sentence in
`FOREMAN_REGENERATE_REFUSAL`.
