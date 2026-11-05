# Desktop `/skill` composer suggestions — source handoff

Source handoff for lane C4. This slice ports the original hosted `/skill` suggestion menu into the
Mac board-chat composer (`DesktopConversation`) as an isolated adapter: a per-coworker shelf read,
the original menu/insertion/keyboard behavior, and focused regressions. Root owns the composer
wiring, draft/history parsing and system-prompt integration; the exact additive fragments are below.

Base `b428751d716efdb3c928c124921502d2a5e4e6c1`; branch `desktop/skill-mentions`.

## What this slice owns

- `apps/ui/lib/desktop/use-desktop-skill-suggestions.ts` — the desktop skill-suggestion
  hook/adapter. Reads the authenticated per-coworker Skills shelf, aborts stale reads, and
  distinguishes `idle | loading | ready | empty | error | unavailable`.
- `apps/ui/lib/desktop/coworker-skills.ts` — one additive change: `listCoworkerSkills(agentId)`
  now takes an optional `{ signal }` so the hook can abort stale reads. Existing callers pass one
  argument and are unaffected.
- `apps/ui/components/desktop/DesktopSkillMentions.tsx` — the isolated autocomplete wrapper. It
  reuses the hosted `useMentionAutocomplete` with an empty agent list, so `/slug` rows come from
  the current coworker's shelf while `@` finds nothing and never opens a menu (coworker delegation
  is not surfaced as a working mention). Exposes `inputRef`, `menu`, `tokens`, composed
  `textareaProps`, `status`, `skills`, `error`, `retry`.
- `apps/ui/lib/desktop/use-desktop-skill-suggestions.test.tsx` and
  `apps/ui/components/desktop/DesktopSkillMentions.test.tsx` — focused authored regressions.
- `docs/desktop-skill-mentions.md` — this document.

Nothing else was changed. The hosted `MentionAutocomplete.tsx` and `composer-links.ts` are
unchanged in the current tree (byte-identical to the pinned originals) and are reused as-is.

## Original sources read (pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`)

- `apps/ui/components/chat/MentionAutocomplete.tsx` — the full suggestion hook (`useMentionAutocomplete`),
  `mentionTokensOf`, the `MentionMenu` (labels, `absolute bottom-full` field anchor, scroll-into-view
  nudging, `aria-selected` rows), trigger detection `(^|\s)([@/])([\w-]*)$`, and insertion syntax:
  picking writes `/<slug> ` (trailing space) at the trigger start, moves the caret past the inserted
  token, and hands the new text back through `onValueChange` because writing `el.value` directly
  fires no React change event.
- `apps/ui/lib/chat/composer-links.ts` — `ComposerMention`, `tokenRanges`, `tokenizeComposer`,
  `remarkMentions`, `COMPOSER_MENTION_TAG` — the token/history path the desktop can reuse for
  rendering and parsing a sent `/slug`.
- `apps/ui/components/chat/AgentChat.tsx` — the original wiring: `useMentionAutocomplete(agents,
  skills, syncMentionTarget)`, `textareaProps` spread onto the composer with the pattern
  "mention handler first, then if `!e.defaultPrevented` do the send/link work", and the menu
  rendered against the chat root at the textarea's top.

## Desktop differences (documented, not redesigned)

- **Shelf source.** The hosted chat passed skills in as props. The desktop hook reads the
  authenticated per-coworker shelf itself: `listCoworkerSkills(agentId)` →
  `GET /api/desktop/agents/:agentId/skills` → `apps/ui/lib/desktop/server/coworker-skills.ts` →
  `apps/engine/src/desktop/skill-publication.ts` (`listPublishedSkills`). This is the same shelf
  the Skills panel shows, scoped to the one coworker by the route. The shelf is read once per
  owner; `/query` filtering is local (the original filtered props the same way).
- **Stale-read abort.** The hook aborts the in-flight shelf read when the owner changes, the hook
  closes (unmount), enablement changes, or a retry supersedes it, and it also discards any
  response whose owner no longer matches — a late answer can never surface another coworker's
  list. A failed refresh keeps the last good shelf and reports the failure (`error` for an
  answered route error, `unavailable` for a network/engine refusal), matching the desktop polling
  hooks' "keep previous rows" behavior.
- **Textarea ref.** The desktop composer uses the shared `Textarea` (`@rerun/ui/forms`), a plain
  function component. React 19 passes `ref` as a prop, and the component spreads `{...props}` onto
  the inner `<textarea>`, so `ref={api.inputRef}` reaches the element with no shared-package
  change. Verified against `packages/ui/src/forms/textarea.tsx` and the repo's React `19.2.4`.
- **IME guard.** The hosted Enter handling picks when the menu is open; the desktop composer's
  Enter-send submits. The wrapper adds one guard: a composing Enter (`nativeEvent.isComposing`)
  neither picks nor sends, so IME confirmation can never send a draft accidentally. All other
  keyboard behavior is the original's.
- **Menu anchor.** The menu is the original `absolute bottom-full left-0 right-0 z-50` element;
  root renders `{api.menu}` inside the composer's existing `relative` form so it floats above the
  field, like the hosted composer anchored it above its textarea.

## Root wiring — exact additive fragments (`DesktopConversation.tsx`)

Root owns `DesktopConversation`; only the following additive edits are needed. The `Textarea`'s
`id`, `rows`, `className`, `maxLength`, `disabled`, `readOnly`, `placeholder` and `value` stay
exactly as they are.

1. Import (next to the other desktop components):

```tsx
import { DesktopSkillMentions } from './DesktopSkillMentions'
```

2. Wrap the composer `<form>` (line ~935) with the render prop. `setInput` is the existing state
   updater that also persists the durable draft:

```tsx
<DesktopSkillMentions agentId={agent.id} onTextChange={setInput}>
    {api => (
        <form ref={composerForm} onSubmit={submit} hidden={!!pendingRequest} className={cn('relative min-w-0 flex-col rounded-xl border border-input bg-muted/40 focus-within:border-ring', pendingRequest ? 'hidden' : 'flex')}>
            {/* …existing upload chips, hidden file input, label — unchanged… */}
            <Textarea
                id={composerId}
                ref={api.inputRef}
                rows={2}
                className="min-h-12 w-full resize-none rounded-none border-0 bg-transparent px-2.5 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
                maxLength={20_000}
                disabled={inactive || !draft.loaded || !!draft.error || draft.quitting}
                readOnly={!!regenerationSource || !!attachmentPaths.length && status === 'submitted'}
                placeholder="Send a message…"
                value={input}
                onChange={api.textareaProps.onChange}
                onSelect={api.textareaProps.onSelect}
                onKeyDown={api.textareaProps.onKeyDown}
            />
            {api.menu}
            {/* …existing footer row (model selector, attachments, send) — unchanged… */}
        </form>
    )}
</DesktopSkillMentions>
```

Notes on the fragment:

- `onChange={api.textareaProps.onChange}` replaces `onChange={event => setInput(event.target.value)}`.
  The composed handler runs the mention trigger detection first, then calls `setInput` with the new
  text — the same draft persistence, plus the menu.
- `onKeyDown={api.textareaProps.onKeyDown}` replaces the current Enter-send handler. It keeps the
  exact send behavior (Enter without Shift → `preventDefault` + `requestSubmit`) but only after the
  mention handler, which calls `preventDefault` when the menu is open — so Enter picks an active
  suggestion before it can send. The composing guard sits in front of both.
- `ref={api.inputRef}` is how the hook reaches the textarea when a picked `/slug` is inserted
  (writes `el.value`, repositions the caret, then hands the text to `setInput`).
- `{api.menu}` is the original menu node; render it anywhere inside the form (after the Textarea).
- Nothing else in the form changes; the image-upload helpers (lane B) are untouched.

3. Optional — sent-message tokenization (root's history parsing). `api.tokens` is the
   `ComposerMention[]` for the current owner's shelf. The hosted paths in
   `apps/ui/lib/chat/composer-links.ts` are unchanged and reusable: `tokenRanges(text, links,
   api.tokens)` for the composer mirror, and `remarkMentions({ mentions: api.tokens })` when a
   transcript renders sent text as mention chips (`COMPOSER_MENTION_TAG`). Desktop user bubbles
   currently render plain text; rendering `/slug` as a chip there is a root-owned choice, not
   required for this slice.

## Prompt/render resolution path — how `/slug` becomes a real `skill_read`

After a restart, the path a user can verify end to end:

1. **Composer inserts text only.** The menu shows rows from
   `GET /api/desktop/agents/:agentId/skills`, which the server answers from the engine's
   `listPublishedSkills(skillsDir(agentId))` (`apps/engine/src/desktop/skill-publication.ts`). A
   picked row writes `/<slug> ` into the draft — plain durable text, saved by the existing draft
   pipeline, so it survives restart and queue/regenerate. Picking never toggles the `skills`
   grant, `tools.skills`, or any tool: a selected token is text, not permission.
2. **Send.** `submit` → `sendMessage({ text })` → `DefaultChatTransport` →
   `POST /api/desktop/chat` (`apps/ui/app/api/desktop/chat/route.ts`) →
   `startDesktopChat(runtime, input)` (`apps/ui/lib/desktop/server/engine.ts`) with the draft text
   including `/slug`.
3. **Prompt.** The engine builds the session prompt in
   `apps/engine/src/agents/systemPrompt.ts`. For a desktop agent, the skills section is on iff the
   explicit grant is on — `skillsOn = desktop ? hasDesktopToolGrant(agent.config, 'skills') : cfg.skills`
   (line ~272) — and the volatile `skills` section reads
   `'Use skill_list to see your saved procedures, then skill_read for the one this task needs.'`
   (line ~320). The grant comes from `packages/contracts/src/desktop-tool-grants.ts` (`skills`),
   the same supported entry the Tools panel writes.
4. **Tool use.** The model sees `/slug` in the user text and calls `skill_read` — registered only
   in the desktop tool branch of `apps/engine/src/tools/registry.ts` (`desktopSkillTools`), defined
   in `apps/engine/src/desktop/skill-tools.ts`. Every call rechecks
   `requireDesktopToolGrant(ctx, 'skills')` and reads the confined per-coworker folder via
   `readPublishedSkill(skillsDir(id), slug, …)`, so only the granted coworker's own published
   skills are ever readable — the exact list the composer menu offered.
5. **Verify after restart.** With the coworker's `skills` grant enabled in Tools, send
   `Use the /<slug> procedure.` from the board chat; the reply's tool steps (DesktopToolStep) show
   `skill_read` with that slug and the skill's body, or the engine refuses truthfully when the
   grant was removed. `skill_list` returns the same published shelf, so a listing in the reply
   cross-checks the menu against the engine.

## Behavior port notes

- Menu labels, selection labels, insertion syntax and cursor placement are the original's:
  name, `/slug`, description rows under a `Skills` header; picking inserts `/slug ` and parks the
  caret after it; the draft keeps the inserted text (durable, not a transient token).
- Enter selects the highlighted row while the menu is open (before any send); Escape dismisses;
  ArrowUp/ArrowDown cycle; hovering moves the highlight; clicking picks. `@` produces no rows and
  no menu.
- The `/query` filters locally over the current owner's shelf, exactly like the original filtered
  its `skills` prop. Empty, error and unavailable shelf states are exposed on the wrapper
  (`status`, `error`, `retry`) for root to surface if it wants; the menu itself opens only when
  there are rows, matching the original.

## Authored regressions

- Hook (`use-desktop-skill-suggestions.test.tsx`): owner-scoped load and mapping; empty shelf;
  answered error + retry recovery; network refusal → `unavailable`; owner switch aborts the
  pending read and never applies the old owner's list; unmount aborts; failed refresh keeps the
  last good shelf; disable clears without a read.
- Wrapper (`DesktopSkillMentions.test.tsx`): `/` opens the original menu with name/slug/description
  labels; query filtering; `@` stays closed (no coworker mentions); ArrowDown + Enter picks the
  highlighted row and does **not** submit; Escape dismisses and keeps the draft; composing Enter
  neither picks nor sends; plain Enter still submits; owner switch surfaces only that owner's
  skills; `tokens` hold only the current owner's `/slug` mentions; typing through the composed
  handlers updates the draft text; shelf failures surface as `unavailable`/`error`.

## Constraints honored

- `/skill` only: coworker delegation never appears as a working mention (`@` has zero agents), and
  no `callAgent`/delegation code was added.
- A selected token is text, not permission: nothing in this slice enables the `skills` grant,
  `tools.skills`, or any tool.
- The authenticated per-coworker shelf and the accepted Skills backend are reused unchanged; the
  hosted `MentionAutocomplete` and `composer-links` are untouched.
- Lane B's image-upload files were not edited; this slice's hook/menu is independent of uploads.
- No voice recording, file mentions, hosted behavior changes, or packaging/startup changes.

## Limitations and acceptance boundary

- Only root runs tests, type checks, lint, builds, packaging, installs and Mac/restart checks;
  nothing here was executed. The authored regressions are source, not acceptance evidence.
- Root must apply the two fragments above (import + form wrap) for the menu to appear; the slice
  ships the adapter, not the wired composer.
- The shelf read returns the full `EngineSkillWithSource` list (the menu maps slug/name/description
  only); no lighter summaries endpoint is introduced, keeping the menu on the same authenticated
  shelf the Skills panel uses.
- Desktop user bubbles render sent text as plain text today; mention-chip rendering of `/slug` in
  the transcript is a root-owned follow-up (`remarkMentions`/`COMPOSER_MENTION_TAG` are available
  unchanged).
