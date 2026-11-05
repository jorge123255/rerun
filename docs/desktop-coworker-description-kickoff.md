# Desktop coworker from a job description

Lane source for the Mac "Add a coworker" description flow: the hosted Orb, description field and
name pill, plus a Create that returns a typed creation intent instead of creating anything.

**Not accepted.** This document describes source in `desktop/coworker-description-kickoff` only.
Root has not integrated it, and no type check, lint, build, packaging or Mac acceptance ran. The two
focused suites were run locally against a reused dependency tree (22 tests, all passing); root still
owns the full gates.

## Original provenance

Original source pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. Every file below is byte-identical
to that pin in this worktree.

- `apps/ui/components/dialogs/new-agent/NewAgentForm.tsx`: the Orb, the field, the name pill, the
  suggestions and the templates entry.
- `packages/ui/src/new-agent/useNewAgentDraft.ts`: the draft, the pinned name, the apps and the
  schedule choice.
- `packages/ui/src/new-agent/useJobReading.ts`: the debounced read, its cache and `settle`.
- `packages/ui/src/new-agent/reading.ts`: the model reply parser, `AGENT_NAME_MAX`, the readable
  bounds.
- `packages/ui/src/new-agent/schedule.ts`: `buildKickoff`, the exact wording of a first message.
- `packages/ui/src/new-agent/fallback-agent-name.ts`: the name when nothing was read.
- `apps/ui/lib/ai/read-agent-job.ts`: the hosted reader, OpenRouter only.
- `apps/ui/lib/templates/useStartScratchAgent.ts`: a name, the apps and a kickoff go to board
  placement; the kickoff is sent verbatim as the opening chat message.
- `apps/ui/app/api/_services/kickoff.service.ts`: the server sends that first message so delivery
  does not depend on the chat panel mounting.
- `apps/ui/stores/board.store.ts`: placement, not creation.

The original extracts optional name, apps and timing hints, creates only on board placement, and
sends the description verbatim as the first chat message. It never generates SOUL instructions from
the description. That behavior is kept.

## What this lane adds

| File | Role |
|---|---|
| `apps/ui/lib/desktop/new-agent.ts` | Capabilities, the creation intent, the bounded local-provider reader, the creation state machine |
| `apps/ui/components/desktop/DesktopNewAgentDialog.tsx` | The Orb, composer and name-pill dialog; returns an intent and closes |
| `packages/ui/src/new-agent/FieldFooter.tsx` | Optional `capabilities` so a host can leave out the Apps picker and the Schedule planner |
| `packages/ui/src/new-agent/index.ts` | Exports `FieldFooterCapabilities` |
| `apps/ui/lib/desktop/new-agent.test.ts` | Intent, capabilities, creation state machine, reader bounds and fallback |
| `apps/ui/components/desktop/DesktopNewAgentDialog.test.tsx` | Typing creates nothing, one intent per press, uncertain resume, refused retry, hidden entry points, hosted footer unchanged |

### Typing and name hints create nothing

The dialog talks to exactly one endpoint, a read: `POST /api/desktop/new-agent/read` with
`{ text }`. That call suggests a name, and it is the only request the dialog makes. It posts no
coworker, opens no chat, sends no message and grants no tool. `onCreate` is called only after the
user presses Create.

### The intent

```ts
type DesktopCreationIntent = {
    requestId: string   // stable across every retry of one creation
    name: string        // 1 to 60 characters
    kickoff: string     // the description, trimmed, sent verbatim
    suggestionId: null  // no hosted suggestions on this surface
    scheduled: false    // no schedule store on this surface
}
```

`desktopCreationIntent` refuses an empty description, one past the 2,000 character server bound,
and a name that comes out empty. The name is the pinned one, else the one read in the description,
else the first five words of the job. The kickoff is the trimmed description when this host cannot
schedule; with the schedule capability on it appends the same sentence the hosted dialog appends.

### Repeated and uncertain creation

`requestDesktopCreation` and `settleDesktopCreation` hold the one guarantee this flow makes:

- while a creation is pending, a second press returns `refusal: 'in-flight'` and no intent;
- an outcome of `uncertain` keeps the intent, and the next press hands back the same `requestId`;
- a definite `refused` returns to idle, so a retry is a new intent with a new `requestId`;
- a `created` outcome returns to idle.

Root turns `requestId` into a durable receipt: one coworker and one first message per id, even when
the app quits between the create and the send. The dialog keeps an uncertain intent across a close
and reopen, and offers Try again (same id) or Start over (new id) rather than guessing.

### Capabilities, not dead buttons

`DESKTOP_NEW_AGENT_CAPABILITIES = { apps: false, templates: false, schedule: false }`. The dialog
draws no Apps picker, no template browser and no Schedule planner. The shared footer keeps both
hosted entry points by default; `capabilities` is optional and omitting it changes nothing for the
web dialog. A capability that turns true later is the same dialog with one more entry.

## Root wiring

Root owns the route, the receipt, `POST /api/desktop/agents`, `createDesktopCoworker` and the first
chat message. Additive fragments:

```tsx
// DesktopApp: replaces the inline create form. `connected` still gates the button that opens it.
const [creating, setCreating] = useState(false)
const [creatingSpaceId, setCreatingSpaceId] = useState<string | null>(null)

<DesktopNewAgentDialog
    open={creating}
    onOpenChange={open => { if (!busy) setCreating(open) }}
    first={agents.length === 0}
    onCreate={async intent => {
        // One receipt per requestId, written before the POST so a quit cannot duplicate it.
        const receipt = await readOrBeginDesktopCreationReceipt(intent.requestId, {
            name: intent.name, kickoff: intent.kickoff, spaceId: creatingSpaceId,
        })
        if (receipt.agentId) return { kind: 'created' }                    // already done
        if (!receipt.agentId) {
            const { agent } = await createDesktopCoworker(await runtime(), {
                name: intent.name, description: intent.kickoff, spaceId: creatingSpaceId ?? undefined,
            })
            await finishDesktopCreationReceipt(intent.requestId, { agentId: agent.id, ... })
        }
        // The kickoff goes through the same receipt, so a retry sends it once.
        await sendDesktopKickoffOnce(intent.requestId, agentId, intent.kickoff)
        return { kind: 'created' }
    }}
/>
```

The dialog's error handling expects one of:

```ts
type DesktopCreateOutcome = { kind: 'created' } | { kind: 'refused'; error: string } | { kind: 'uncertain'; error: string }
```

Use `refused` only when the server certainly created nothing (validation, a taken name, no
provider). Use `uncertain` for a timeout, a dropped connection, a 5xx, or a receipt that cannot be
read: the coworker or the first message may exist.

The reader route root mounts:

```ts
// POST /api/desktop/new-agent/read  { text: string }  ->  { reply: string } | 4xx/5xx
// Uses the coworker-independent local default model from settings, never a hosted key.
// Empty reply on no model. The client parses and bounds it itself.
```

Until that route exists, the dialog still works: every failed read is an empty reading, so the
name comes from the pill or the first words of the job, and Create is never blocked.

## Mac differences from the hosted flow

- **Provider.** `apps/ui/lib/ai/read-agent-job.ts` reads OpenRouter with `OPENROUTER_API_KEY`. The
  Mac adapter posts to a local route that uses the connected provider; no hosted key is read or
  assumed. A missing model is the honest fallback, not an error state.
- **Catalog.** The Mac app has no connector catalog, so a reply naming an app is parsed against an
  empty slug list and its apps are dropped. Apps are not offered or sent.
- **Schedule.** No schedule store on this surface, so the planner is hidden and the kickoff gets no
  timing sentence.
- **Templates.** No template import, so no template browser and `suggestionId` is always null.
- **Placement.** The hosted `useStartScratchAgent` writes to the board store on drop. Here the
  dialog hands root an intent; placement and the first message are root's.

## Limits

- B4 stays partial until template import and setup resume exist.
- No apps install, permissions grant, automatic schedule or self-instruction change.
- The reading is a name hint only on this surface; a wrong name is one click in the pill.
- A read that lands after its text was replaced is aborted, and one that lands after an uncertain
  creation changes only a name that Create would then read from the same draft.
- Root owns the full gates: type check, lint, build, packaging, live model calls, Mac restart and
  acceptance. The local runs covered the two focused suites only.
