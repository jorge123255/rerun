# C6 root wiring

Do not treat this handoff as accepted. Root applies these fragments, then runs checks. Imports of `@rerun/contracts` service-request symbols stay unresolved until the barrel export is rebuilt.

## `packages/contracts/src/index.ts`

Add next to the other desktop exports:

```ts
export * from './desktop-service-requests.js'
```

Rebuild `@rerun/contracts` after that export. Do not mark `suggestService` as turning on `services`.

## `packages/contracts/src/desktop-tool-grants.ts`

Add `'suggestService'` to `desktopRerunGrantIds` after `'services'`. Replace the pending catalog row with:

```ts
supported('suggestService', 'Suggest apps', 'Suggest catalog apps in chat and wait for the setup card. This does not enable Apps or store a credential.', 'suggest_service'),
```

Leave `services` unchanged. Suggesting an app must not grant Apps.

## `apps/engine/src/tools/registry.ts`

Inside the `desktopApp()` tool object, add:

```ts
...desktopSuggestServiceTools(ctx),
```

Import `desktopSuggestServiceTools` from `../desktop/service-requests/suggest-service.js`. The helper already returns nothing unless `desktopToolGrants.suggestService === true` and the coworker is enabled. Do not also spread `suggestServiceTool`. Do not call `desktopServiceTools` from this grant.

## `apps/engine/src/http/routes/chat.ts`

`desktopQueuedTurn` is strict and today allows only `question` and `approval`. Add:

```ts
service: desktopServiceRequestGuardSchema.optional(),
```

Import `desktopServiceRequestGuardSchema` from `@rerun/contracts` and `decideDesktopServiceRequestTurn` from `../../desktop/service-requests/admission.js`. Reject a body that sets more than one of `question`, `approval`, and `service`.

Copy the guard onto the object passed to `getDesktopQueuedTurn` and `reserveDesktopQueuedTurn`. The current object is built at the queued-turn branch:

```ts
const turn = { runId: queued.runId, sessionId: session.id, message: body.message, ...desktopAttachmentFieldsOf(desktopAttachmentSelectionsOf(queued)), question: queued.question, approval: queued.approval, service: queued.service }
```

Call `decideDesktopServiceRequestTurn` only after `getDesktopQueuedTurn` resumes an existing run and after `replayOnly` returns 404 `queued_turn_not_found`. A retry whose user message is already saved must resume there. If this decision runs first, that retry 409s because the follow-up message cleared the card.

```ts
const serviceDecision = decideDesktopServiceRequestTurn({ rows: messages, queued })
if (serviceDecision.kind === 'reject') throw new HttpError(serviceDecision.status, serviceDecision.error)
if (serviceDecision.kind === 'block') {
    releaseSession(turn.runId)
    return c.json({ error: serviceDecision.error, code: serviceDecision.code }, 409)
}
if (serviceDecision.kind !== 'admit' && (pending || approval)) {
    // existing question_pending / approval_pending response
}
```

Use the same decision on the ordinary desktop chat path (`findDesktopQuestion` / `findDesktopApproval` around the non-queued branch) so a waiting card blocks a new message with `service_pending`. A matching `service` guard is the only admission. `decideDesktopServiceRequestTurn` does not itself reject a matching service follow-up when a question or approval is also unanswered in the transcript; the body-level refine above is what rejects combining those guards.

## `apps/engine/src/db/repos/desktop-queued-turns.ts`

Add `service?: DesktopServiceRequestGuard` to `QueuedTurn`. In `fingerprint`, after the approval part:

```ts
if (turn.service) parts.push(['service', turn.service.sourceMessageId, turn.service.toolCallId, turn.service.fingerprint])
```

## `apps/ui/lib/engine/client.ts` and `apps/ui/lib/desktop/server/engine.ts`

Add `service?: DesktopServiceRequestGuard` to `desktopQueuedTurn` and `DesktopChatInput`. Pass it through `startDesktopChat` the same way as `approval`. Map a 409 from that guard to: `This app setup changed or the conversation is still working. Reload the conversation and retry the saved finish.`

`sendDesktopServiceFollowUp` already posts `service` on the queued turn. Until this field is accepted, finish saves the receipt and the retry returns the engine error without a second summary.

## `apps/ui/lib/desktop/server/database.ts`

After the other desktop schema initializers:

```ts
await ensureDesktopServiceSuggestionSchema(client)
```

Import it from `./service-requests/schema`. The route also creates the tables if they are missing. Do not add columns to `desktop_service_installs` or `desktop_service_requests`.

## Attention and queue

Root owns pending, attention, and queue integration. Read the card with `findDesktopServiceRequest` and hide it when `desktop_service_suggestion_receipts.accepted = 1` for that service request. Surface it beside question and approval.

Files that currently allow only `question | approval`:

- `apps/ui/lib/desktop/server/attention.ts` — after the approval read, summary `App setup`
- `apps/ui/lib/desktop/attention.ts` — add the kind to `desktopAttentionItemSchema`
- `apps/ui/lib/desktop/pending-inbox.ts` — add the kind to `DesktopPendingReadTarget`

Do not treat Apps open, close, or configure as the answer. Do not grant `services` from this card. Dismissal stays the original sentence `[User dismissed the app setup without configuring]`. A later user message clears the card through `findDesktopServiceRequest`. Finish does not invent that sentence.

`apps/engine/src/tools/builtin/hitl.ts` already lists `suggest_service` in `HITL_TOOL_NAMES`, so a delivered call ends the turn once the tool is registered. `desktopToolInstruction` in `apps/engine/src/desktop/tool-grants.ts` lists catalog tool names by itself. There is no separate desktop bridge allowlist to edit. Do not register `request_secret`. Do not spread `suggestServiceTool` on the desktop branch.

## Limits that stay after those fragments

- `sendDesktopServiceFollowUp` posts `service` today. Until the strict queued-turn schema accepts it, finish keeps an unaccepted receipt and the retry returns the engine error without a second summary.
- `chat()` in `apps/ui/lib/engine/client.ts` uses its own timeout and does not take the route abort signal. Passing that signal through is a root client change.
- The first caller of `getDesktopRemoteMcpService` resets install health. A service-request read can be that caller. It does not probe or otherwise repair health.
- Finish re-reads catalog, installations, and source immediately before the card lock. The lock covers only the sqlite insert. A disconnect inside that gap can still be sealed as connected; the saved receipt is not derived again.
- `connected` is the adapter’s `usable` flag: ready, healthy, current engine, current launch nonce, Apps grant, and a check newer than 60 seconds. Catalog `verified` is always returned with `connected: false`.

## F

F imports the contract view, progress, and finish schemas. Connect uses its injected `onOpenApps` and then refreshes GET. Finish posts the saved choices. The browser does not build `serializeServiceSetupResult` text.
