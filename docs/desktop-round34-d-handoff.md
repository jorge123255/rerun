# Desktop Round 34 — Agent D handoff (E9 model webhook tools)

Source only. No tests, typecheck, lint, build, install, server, packaging, Docker, Keychain, live provider, or app launch was run. E9 is not accepted and `docs/desktop-parity-checklist.md` was not changed.

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round34-trigger-tools`  
Branch: `desktop/round34-trigger-tools`  
Base: `caa9904df8a57fb845f5b04c26a77642956757b3`  
Original pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`  
Installed build named by the assignment: `40aa370` (not treated as acceptance of this package)

## Original → adapter

| Original at `a6d63a4` | Desktop adapter |
| --- | --- |
| `apps/engine/src/tools/builtin/trigger.ts` | `apps/engine/src/desktop/trigger-tools/tools.ts` — same seven tools. Public-URL sentences are local-only denials. `trigger_edit` is exact text. Rotate requires `{ slug, revision, action: "rotate" }` |
| `apps/engine/src/tools/builtin/automation-model.ts` | `trigger-tools/model.ts` — no `pinnedModel` and no `connectionsOfProvider`. A different pin is refused. A matching pin is stored as follow-coworker (`connectionId` / `provider` / `model` null). Create ignores a provider named without a model. Update refuses it with `provider only goes with a model; nothing changed.` |
| `apps/engine/src/triggers/loader.ts` | not called. Definitions stay on `createDesktopTriggerLifecycle` and `replaceDesktopTriggerDefinition` |
| `apps/engine/src/triggers/url.ts` | not called. Tools never call the hub and never return `Its public URL is …` |
| `apps/engine/src/triggers/index.ts` `buildTriggerIndex` | not edited. It still says the trigger has a public URL. Desktop prompt replacement is `DESKTOP_TRIGGER_TOOL_PROMPT` |
| `apps/engine/src/http/routes/triggers.ts` | not edited. Human trigger routes stay root-owned |
| `apps/engine/src/desktop/triggers/**` | not edited. This package calls `lifecycle` and `store`. The older `createDesktopTriggerToolFactory` stays for that runtime and must not be registered beside these tools |
| Webhook request UI | not this package. B owns request projections. No presenter and no notice route were added |

Hosted `triggerTools` remain the non-desktop path.

## Contract

`packages/contracts/src/desktop-trigger-tools.ts` is not on the barrel. Engine value-imports it from `@rerun/contracts`, so root adds this before the tools can load:

```ts
export * from './desktop-trigger-tools.js'
```

Then rebuild `@rerun/contracts`. Existing `export * from './desktop-triggers.js'` already covers the definition schemas. Do not add a second trigger schema.

Exports: `DESKTOP_TRIGGER_TOOL_GRANT_ID` (`trigger`), `DESKTOP_TRIGGER_TOOL_NAMES` (includes `trigger_edit`), `DESKTOP_TRIGGER_TOOL_MAX_BODY_CHARS` (64000), `DESKTOP_TRIGGER_TOOL_MESSAGES`, `DESKTOP_TRIGGER_TOOL_DESCRIPTIONS`, `DESKTOP_TRIGGER_TOOL_PROMPT`, `desktopTriggerRotateConfirmationSchema`, projection and outcome schemas.

Grant id is the existing Triggers grant. It is not `scheduleManage`. Management stays off until that grant is on for the coworker. `trigger_edit` is missing from the catalog row in `packages/contracts/src/desktop-tool-grants.ts` (the row lists the other six names). Root adds `trigger_edit` to that same row. Do not invent a second grant.

## Behavior

- Identity is the current engine coworker, run, and session. Mutations hash `coworker + run + toolCallId` into a UUID request id. The lifecycle fingerprints the parsed input. The same id and fingerprint replay the stored result. A different fingerprint conflicts. The previous trigger stays.
- Every call rechecks active, running parent, enabled, deleting, guided setup, and `assertTriggerGrant`. That grant check must be a fresh `grants.trigger === true`. `runtime.authority.assertTriggerGrant` is the authorize callback, not this check. `scheduleManage` and a chat approval are not authority.
- Create, update, rotate, and delete go through `createDesktopTriggerLifecycle`. There is no second intent table, token format, or trigger registry. `desktop_trigger_intents` is already created by `desktopTriggerStateSchema`.
- `trigger_edit` computes the next body and calls `lifecycle.update`. The stored kind is `update`. The model text is `Edited trigger …`. A retry uses `intent.before.body`, not the already edited file.
- `expectedRevision` is `desktopTriggerDefinitionRevision` (slug, name, description, enabled, methods, connectionId, provider, model, body, token, createdAt). Fire count and last fired time are outside the hash and are preserved by `replaceDesktopTriggerDefinition`.
- Rotate checks `{ slug, revision, action: "rotate" }` against the current trigger before the first reserve. A missing or mismatched confirmation returns `Token rotation needs a confirmation for this trigger, its current revision, and the action rotate. A chat approval is not enough. The previous address still works.` and does not write. After a reserve, a retry of that same request id uses the reserved revision and does not re-check the confirmation against the new file. The old token stays until `replaceTrigger` commits. Only that slug changes.
- The lifecycle mints the next token inside the first rotate `prepare` and stores it on the intent. A lost `completeIntent` retries the same intent and does not mint again.
- A stopped or cancelled admission after reserve does not seal the intent (the lifecycle has no seal-on-throw). The file stays unwritten unless the write already landed. The same request can finish later. `recoverDesktopTriggerOwner` reconciles delivery rows only. It does not apply a pending mutation and does not rotate again.
- Disable and delete do not call `startTriggerRun`, `cancelExactRun`, `markFired`, or `listEvents` delete. Ingress already rejects a missing, disabled, or wrong-token definition. Recorded delivery rows stay.
- List and get do not reserve. List text is sorted by slug. Get adds `Revision:` and `This webhook is local to this Mac while Rerun is open. There is no public URL.` Get uses `includeToken: false`.
- Model tools never persist a pin. Create always writes null `connectionId` / `provider` / `model`. Update and edit that do not mention a model omit those fields so a human pin stays. A named model that matches `connectedModel` is stored as null. Any other named model writes nothing. `connectedModel` must be what `assertDesktopProvider` allows and `isUsable` accepts, otherwise null. Do not call `automationModel` or `pinnedModel` from the tool.
- Tool strings are scrubbed for `/api/desktop/trigger-ingress/` and `Its public URL is`. A user-written `https://` instruction is left in the body. The lifecycle still stores `view(includeToken: true)` in `resultJson`, including the token. The model text does not include that JSON. Do not log `resultJson` into the chat.

Desktop differences from the hosted tools, on purpose:

- No hub URL and no “paste this URL” line.
- Create does not upsert.
- Rotate is bound to slug, revision, and `action: "rotate"`.
- A provider/model other than the coworker’s connected pair is refused, because desktop launch calls `resolveAutomationModel` again and the runtime copy forces `provider: null`.
- `trigger_get` adds a revision line so a later edit or rotation can name that version.
- Lifecycle 409 `Trigger changed since you opened it` covers both a missing slug and a stale revision. This package maps that 409 to `Trigger changed since you read it. Call trigger_get and retry. The previous trigger was kept.` `trigger_get` still returns `Trigger not found: …`.

## Root wiring

1. Barrel export and contracts build, above.
2. In `packages/contracts/src/desktop-tool-grants.ts`, add `'trigger_edit'` to the existing `supported('trigger', …)` list. Leave the grant id as `trigger`.
3. After `createDesktopTriggerRuntime` has bound the lifecycle (startup already calls `recoverDesktopTriggerOwner`):

```ts
import { bindDesktopTriggerTools } from './desktop/trigger-tools/index.js'

const runtime = readDesktopTriggerRuntime()
if (runtime) {
  bindDesktopTriggerTools({
    lifecycle: runtime.lifecycle,
    store: runtime.store,
    authority: {
      assertActive: () => runtime.authority.assertActive(),
      resolveOwner: id => runtime.authority.resolveOwnerByEngineId(id),
      assertSetupClear: id => runtime.authority.assertSetupClear(id),
      assertTriggerGrant: async () => {
        // Replace this throw with a fresh `grants.trigger === true` read.
        // Do not call runtime.authority.assertTriggerGrant. A throw refuses the tool.
        throw new Error('missingTriggerGrant')
      },
      readRun: (id, runId) => runtime.authority.readRun(id, runId),
      connectedModel: async () => {
        // Replace this throw with the usable desktop model, or return null.
        // Do not substitute automationModel. A throw is treated as no model.
        throw new Error('missingConnectedModel')
      },
    },
  })
}
```

Do not add `DESKTOP_SCHEDULE_TOOL_SCHEMA_SQL` or another copy of `desktopTriggerStateSchema`.

4. In `buildTools`, replace the `triggers.toolFactory` assignment. Do not register both factories. Names collide and `buildTools` already throws when a tool name is duplicated.

```ts
const triggerToolRuntime = readDesktopTriggerTools()
if (triggerToolRuntime && hasDesktopToolGrant(ctx.agent.config, 'trigger') && !ctx.agent.config.ephemeral) {
  Object.assign(tools, triggerToolRuntime.tools(ctx.agent.id, ctx))
}
```

Do not register these tools for delegation children. `delegation/runtime.ts` already blocks `trigger_` names. Leave `apps/engine/src/desktop/triggers/tools.ts` in place.

5. In `apps/engine/src/agents/systemPrompt.ts`, the desktop branch still calls `buildTriggerIndex` when `cfg.trigger` is set (around the `Promise.all` that fills `triggerIndex`). That string says “public URL”. On desktop, when `hasDesktopToolGrant(agent.config, 'trigger')` is true, use `DESKTOP_TRIGGER_TOOL_PROMPT` instead and do not call `buildTriggerIndex`. Do not edit the hosted index in the non-desktop branch.
6. Do not enable `loopbackIngress`, open a tunnel, or change `hostingDecision`. Tools never print `ingressOrigin()`.
7. Optional in-process outcome: `readDesktopTriggerTools()?.projection(toolCallId)`. It is not the webhook-request UI.

## Regressions authored, not run

- `apps/engine/src/desktop/trigger-tools/tools.test.ts` — local create with ingress origin enabled and no token or URL in the tool text, lifecycle receipt still holds the token, list order, get revision, empty list, user `https` kept and ingress path scrubbed, replay, fingerprint conflict, no upsert, exact edit, stored kind `update`, ambiguous edit, stale update, lone provider, matching pin stored null, other pins refused, human pin kept when the model is omitted, rotate confirmation, sibling token unchanged, lost-ack rotate mints one token, definition CAS retry, post-reserve stop left pending, grant, setup, enabled, deleting, stopped parent, unsafe file, name, empty body, 64000 cap, methods, sibling list, disable and delete keep the delivery row and do not start or cancel a run, revoke, missing tool-call id, aborted parent, bind requires authority
- `apps/engine/src/desktop/trigger-tools/model.test.ts` — omit, clear, mismatch, no connected model, lone provider

## Root-only native QA (not executed)

1. Rebuild contracts after the barrel export. Typecheck the engine against that build.
2. Run `apps/engine/src/desktop/trigger-tools/tools.test.ts`, `model.test.ts`, and the existing `apps/engine/src/desktop/triggers/lifecycle.test.ts`. This lane did not run them.
3. With the Triggers grant off, a coworker cannot call these tools. With the grant on, create a trigger. The tool text has no token and no `http` URL. The Triggers tab still shows the local address. The secret is not in the chat.
4. `trigger_edit` an exact excerpt. `trigger_update` a full body. A stale revision keeps the file.
5. Rotate without the confirmation object. The token is unchanged. Rotate with `{ slug, revision, action: "rotate" }` from `trigger_get`. Only that trigger’s token changes. Retrying the same tool call does not change it again.
6. Deliver one local event through the existing ingress, then disable or delete the trigger. The delivery row and any open chat remain. A new call is fenced. This package does not perform that delivery.
7. A second coworker does not see the slug. Revoking triggers refuses the first coworker only.
8. Confirm no tunnel, no public host, and `hostingDecision` still `loopback-only` unless a separate hosting change is made.

## Matrix

| | |
| --- | --- |
| Implemented | Seven model tools on the existing trigger lifecycle, exact edit, revision-bound rotate confirmation, local-only tool text, fresh grant/setup/run checks, follow-coworker pin policy, lost-ack replay through the existing intent row, unrun regressions, prompt and registry fragments |
| Root-dependent | Contracts barrel and rebuild, `trigger_edit` on the Triggers catalog row, `bindDesktopTriggerTools` with a fresh `grants.trigger` check and `connectedModel`, `buildTools` swap off `toolFactory`, desktop prompt swap off `buildTriggerIndex`, test/typecheck/native QA |
| Unsupported | Public URL, hub `trigger_url`, tunnel, turning a listener on, a second trigger database, delivering an event, human-input UI (B), replaying events from these tools, stripping the token out of lifecycle `resultJson` without editing `lifecycle.ts`, splitting the lifecycle’s combined missing/stale 409, installed acceptance of E9 |
