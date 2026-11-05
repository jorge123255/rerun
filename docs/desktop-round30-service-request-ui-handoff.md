# Round 30 lane F — C6 app-request chat presentation

Source handoff only. Root execution, integration and native acceptance are pending. This does not mark C6 or the checklist accepted.

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round30-service-request-ui`  
Branch: `desktop/round30-service-request-ui`  
Exact parent: `c9acacf82d6964890d57bc007346e78481ea3773`  
Original source pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`

## Owned files

- `apps/ui/components/desktop/service-requests/DesktopServiceRequestBlock.tsx`: current-source controller, durable progress/Finish, Apps flow, acknowledged stream handoff.
- `apps/ui/components/desktop/service-requests/DesktopServiceSuggestionCard.tsx`: original card presentation using local event callbacks.
- `apps/ui/components/desktop/service-requests/DesktopServiceRequestReceipt.tsx`: compact original Apps receipt presentation.
- `apps/ui/components/desktop/service-requests/index.ts`: public component/props exports.
- `apps/ui/components/desktop/service-requests/retry-journal.ts`: bounded exact outbound-attempt journal, scoped by owner/session/request.
- `apps/ui/components/desktop/service-requests/retry-journal.test.ts`: authored storage/restart regressions.
- `apps/ui/components/desktop/service-requests/DesktopServiceSuggestionCard.test.tsx`: authored presentation/no-secret/no-auto-answer cases.
- `apps/ui/components/desktop/service-requests/DesktopServiceRequestBlock.test.tsx`: authored acknowledgment, Cancel, restart and stale-owner cases.
- `apps/ui/components/desktop/service-requests/service-request-fixtures.ts`: synthetic regression fixtures, imported only by regression sources.
- `apps/ui/lib/desktop/service-requests-client.ts`: E-schema HTTP adapter, identity checks, bounded reads, exact retry and stream ownership transfer.
- `apps/ui/lib/desktop/service-requests-client.test.ts`: authored transport/identity/recovery/byte-limit cases.
- This handoff document.

No root-owned integration file, paired contract, Apps implementation, previous worktree or live data was edited. No dependency was added.

## Original sources read and preserved

All original paths below were read with `git show` at the pin above.

| Source | Reused behavior/design |
| --- | --- |
| `apps/ui/components/services/ServiceSuggestionBlock.tsx` | Ordered cards, reason text, bordered muted frame, BorderBeam, fading step transition, icon/name header, Connect/Cancel, Skip/Not now, step dots and Next/Finish. The original synchronous `submittedRef`/`onDone(summary)` and install-triggered automatic advance are replaced by acknowledged server operations. |
| `apps/ui/components/services/ServiceAlternatives.tsx` | Reviewed original alternative-choice layout and its hosted data dependency. No alternatives are rendered because E's delivered ordered request has no alternative suggestions. |
| `apps/ui/components/chat/HitlReceipt.tsx` (`ReceiptCard`, `SERVICE_STATUS`, `ServicesReceipt`) | Compact user-side Apps card, connected count, divided rows, status badges and original Connected/Skipped/Not reconnected/Not found labels. |
| `apps/ui/components/chat/AgentChat.tsx:879–886` | Original service HITL branch placement and boundary. Root must replace its hosted `onDone -> sendMessage` pattern with the callback described below. |
| `packages/contracts/src/chat-hitl.ts` (`pendingServices`, `serializeServiceSetupResult`, `ServiceSetupEntry`, receipt parser) | Original ordered request/result meaning and receipt entry model. The browser does not serialize any service result. |

Current `DesktopApprovalCard.tsx`, `services/DesktopServiceConfigForm.tsx`, `DesktopCoworkerServices.tsx`, `DesktopServicesDialog.tsx`, `DesktopConversation.tsx`, and `docs/desktop-round30-interfaces.md` were read. Installed Next.js `apps/ui/node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md` was read from `/Users/gszulc/OpenBot/Shared/rerun-desktop`; callbacks stay between client components.

## Necessary Mac adaptations

- The original suggestion component imports hosted catalog actions, OAuth popup code and hosted setup children before driver injection. This port copies its presentation and imports none of those actions/hooks/children. Connect opens the accepted Apps lifecycle through a required root callback; it never mounts a second configuration form.
- E owns the request document, ordered choices, decision revision, usable installation views and final serialization. This lane imports E's types/schemas; there is no parallel request schema.
- A healthy current server connection is selected only through a user action. If several connections are usable, explicit `Use <key>` buttons save the exact server-issued key/revision. A sole usable connection may be selected by Next/Finish. Merely reading or closing Apps does not select it, save progress, send Finish, or grant Apps permission.
- The saved decision revision and installation revision are separate fields throughout. Any changed choices/index are acknowledged with `progress`, followed by a fresh authoritative GET, before a Finish can use the new decision revision.
- A final Skip/Not now can finish only after its progress is acknowledged and every app has an explicit non-pending choice. Earlier pending apps stay pending; the final card explains how to return using dots. Next can move to an earlier/later card without implicitly skipping it.
- Configuration Cancel aborts only the callback's matching flow. No progress/Finish is sent. The flow remains locked until its promise settles; a still-current request is refreshed before controls become available again.
- The original synchronous completion latch is absent. Mutations have a synchronous in-flight guard and an immutable attempt saved before POST. Unknown/failed progress or Finish leaves that exact UUID, source guard, choices and expected decision revision available after remount/restart. Retry is always explicit.
- The server remains the source for card progress. Local storage holds only one bounded, unacknowledged outbound mutation for that exact owner/session/request. It contains no credential fields, input form values or client health claims. Corrupt/unavailable storage blocks submission. It is never interpreted as a connected outcome. Uncertain data is not silently dropped or overwritten.
- The receipt uses the original fallback Link icon without hosted catalog/alternative hooks or a second network lookup. Names/outcomes come from E's accepted receipt or E's verified persisted result in chat. Existing catalog metadata drives card icons.
- Long names/reasons wrap; footer controls wrap; a full 20-step dot row can scroll horizontally inside its card. No fixed card height or new settings dialog was added. Viewport behavior is source-authored and unverified.

## E dependency — exact consumed surface

Read in place from paired worktree `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round30-service-requests` while E was authoring it:

- `packages/contracts/src/desktop-service-requests.ts`
- `apps/ui/lib/desktop/server/service-requests/service.ts`
- `apps/ui/app/api/desktop/sessions/[sessionId]/service-requests/route.ts`

Root must integrate E and add its central export (owned by root), then rebuild contracts as part of root's checks:

```ts
// packages/contracts/src/index.ts
export * from './desktop-service-requests.js'
```

Consumed exports are `desktopServiceRequestGuardSchema`, `desktopServiceRequestMutationSchema`, `desktopServiceRequestViewSchema`, `desktopServiceProgressResultSchema`, `DesktopServiceRequestGuard`, `DesktopServiceRequestMutation`, `DesktopServiceRequestView` and `DesktopServiceChoice`. The component's `request` type is `NonNullable<DesktopServiceRequestView['request']>`.

GET `/api/desktop/sessions/[sessionId]/service-requests` has no browser owner or path parameters beyond the local session ID. It returns E's `{request: ... | null}`. POST accepts E's `progress` or `finish` body. Progress returns the exact saved ID/revision/index/choices. Finish returns the already submitted UI message stream, with exact `x-service-request-id`, `x-session-id`, and `x-run-id` acknowledgment headers. A JSON `{status:'unknown'}` is never treated as success.

The client refuses a different request ID/source message/tool call/fingerprint, invalid ordered rows, mismatched progress receipt, or mismatched Finish headers. JSON display reads are capped at 2 MiB and 30 seconds. Finish headers have a 130-second bound; once acknowledged, stream consumption and Stop belong to root. Request redirects are refused and fetch uses the local same-origin session. Root still owns authenticated route policy and all server-side source/owner/grant/installation checks.

E's unaccepted sealed Finish is reconstructed from `retry.phase === 'finishing'`, `retry.requestId`, the saved revision, index and choices. Mount performs reads only and displays Retry Finish. E's accepted receipt is displayed without invoking a completion callback on mount. If an old source has ceased to be pending, root should render the authoritative transcript receipt and remove its pending card, rather than reuse it for another source.

## Root wiring: rendering, pending state and receipts

These are additive fragments for root-owned files; they were not applied.

```tsx
import { desktopServiceRequestViewSchema, parseHitlReply } from '@rerun/contracts'
import {
  DesktopServiceRequestBlock,
  DesktopServiceRequestReceipt,
  type DesktopServiceRequestBlockProps,
} from './service-requests'
import type { DesktopOpenApps } from '@/lib/desktop/service-requests-client'

type ServiceCard = DesktopServiceRequestBlockProps['request']
type AcceptedServiceResponse = Parameters<DesktopServiceRequestBlockProps['onAccepted']>[0]
```

Extend the existing generation-guarded `Promise.all` history/question/approval read in `DesktopConversation` with GET of this endpoint. Parse it with `desktopServiceRequestViewSchema`; treat fetch/schema/catalog failure as unavailable pending state, not no request. Only install its `request` into history when owner, local session and read generation are still current. Preserve E's complete source guard and full ordered request; do not derive a new request ID from a slug.

Include `serviceRequest` and its loaded/unknown state in existing `pendingRequest`, `requestBlocked`, attention, composer/quick-reply, queue-flush and run-admission guards. An unknown service-request read must block ordinary sends until authoritative state is known. Refuse conflicting simultaneous HITL kinds and retain the ordinary draft. Root/E own the queued-turn guard and tool-registration changes.

Mount only for the matching current source/session, with the same inactive/generating/stopping/quitting/readiness restrictions as the approval card:

```tsx
{serviceRequest && sessionId && (
  <DesktopServiceRequestBlock
    agentId={agent.id}
    sessionId={sessionId}
    request={serviceRequest}
    inline
    disabled={draft.quitting || !active || inactive || generating || stopping || !ready}
    onOpenApps={openServiceApps}
    onAccepted={adoptServiceResponse}
  />
)}
```

For a persisted, verified E service-result message, reuse the original parser and render its compact receipt in place of the raw summary bubble:

```tsx
const reply = parseHitlReply(serverPersistedText)
if (reply?.kind === 'service') {
  return <DesktopServiceRequestReceipt entries={reply.entries} />
}
```

`serverPersistedText` here is E's canonical follow-up from authoritative chat history (or use `serviceRequest.receipt.entries` when `receipt.accepted` is true). Do not manufacture entries from client choices, current catalog metadata or an Apps dialog result.

## Root wiring: accepted stream without another submission

`onAccepted` is called only after the exact Finish HTTP acknowledgment. E already serialized, saved and submitted the follow-up. Do not call `sendMessage`, POST Finish again, or POST `/api/desktop/chat` from this callback. Root must adopt this existing response into its current stream/history lifecycle, including Stop and stale-owner handling.

One concrete decode fragment uses the installed AI SDK's existing decoder without calling its send/reconnect methods. The protected method and `readUIMessageStream` signatures were read from installed `ai/dist/index.d.ts`:

```tsx
import { DefaultChatTransport, readUIMessageStream, type UIMessage } from 'ai'

class AcceptedResponseDecoder extends DefaultChatTransport<UIMessage> {
  decode(response: Response) {
    if (!response.body) throw new Error('The accepted app response has no stream.')
    return this.processResponseStream(response.body)
  }
}

// Define alongside the existing run refs in DesktopConversation.
const serviceStream = useRef<AcceptedServiceResponse | null>(null)
const [serviceStreaming, setServiceStreaming] = useState(false)

// Keep this ref current during render; source may disappear normally after acceptance.
const serviceOwner = useRef({ agentId: agent.id, sessionId, active })
serviceOwner.current = { agentId: agent.id, sessionId, active }

const adoptServiceResponse: DesktopServiceRequestBlockProps['onAccepted'] = async result => {
  const owns = () => serviceOwner.current.agentId === result.agentId
    && serviceOwner.current.sessionId === result.sessionId
    && serviceOwner.current.active
  if (!owns() || serviceStream.current) {
    result.cancelStream()
    throw new Error('This conversation is no longer available for the accepted app response.')
  }
  serviceStream.current = result
  setServiceStreaming(true)
  setLiveSessionId(result.sessionId)
  setLiveRunId(result.requestId)
  try {
    for await (const message of readUIMessageStream<UIMessage>({
      stream: new AcceptedResponseDecoder().decode(result.response),
      terminateOnError: true,
    })) {
      if (!owns() || serviceStream.current !== result) {
        result.cancelStream()
        return
      }
      setMessages(previous => previous.some(item => item.id === message.id)
        ? previous.map(item => item.id === message.id ? message : item)
        : [...previous, message])
    }
  } finally {
    if (serviceStream.current === result) {
      serviceStream.current = null
      setServiceStreaming(false)
      // Reuse the existing history-generation reload to obtain E's actual user receipt
      // and canonical assistant messages. Preserve composer drafts/queue state.
      setAttempt(value => value + 1)
    }
  }
}
```

Root must include `serviceStreaming` in its existing generating/queue/quick-reply guards and avoid applying an older history snapshot over the live adopted reply. The final history reload is authoritative and replaces any temporary stream snapshot. Register `serviceStream.current.cancelStream()` in owner/session teardown and the renderer Stop path; the existing engine Stop must still cancel `result.requestId` in `result.sessionId`. Use the existing run-error display on decode/stream failure; this error does not make the already accepted submission retryable. An accepted card can unmount normally without aborting its transferred stream. Source changes before acknowledgment still abort pending reads/requests and prevent callbacks.

## Root wiring: existing Apps flow and exact close identity

The required exported type is:

```ts
const openServiceApps: DesktopOpenApps = async ({
  agentId, slug, serviceRequestId, sourceFingerprint, signal,
}) => {
  // Root implementation opens the existing Apps dialog at this exact local catalog slug.
  // Resolve {status:'closed'} only after that specific flow actually closes.
  // The flow never returns Connected or changes an Apps grant.
  return waitForMatchingAppsClose({ agentId, slug, serviceRequestId, sourceFingerprint, signal })
}
```

`waitForMatchingAppsClose` is the exact missing root interface, not an implemented helper in this lane. Implement it using a unique flow token plus `{agentId, slug, serviceRequestId, sourceFingerprint}` in the existing dialog owner. Reject an attempt to replace a different active flow. Only the flow owning that token may settle or close its dialog; an old abort/close must not close a newer dialog. On abort, close/detach only that flow, finish its existing guarded teardown, and reject its wait. Cancel keeps the card locked until this settlement. Remove abort listeners on settlement. Do not resolve on `Install`, a health probe, permission changes, or panel navigation while the owned flow is still open.

Forward focused-slug support through existing components (root-owned changes):

```tsx
// Extend existing props; keep the existing form and driver.
type ServiceFocus = { focusSlug?: string; focusRequestKey?: string }

// DesktopServicesDialog -> DesktopCoworkerServices
<DesktopCoworkerServices
  key={agent.id}
  agentId={agent.id}
  focusSlug={flow?.slug}
  focusRequestKey={flow?.token}
/>
```

After the existing `DesktopCoworkerServices` client is ready, open `focusSlug` through its existing `open(slug)` guarded detail reader, once per `{agentId, focusRequestKey, focusSlug}`. Leave credential installation/probe/disconnect and grant controls in that accepted panel. Wire the existing actual dialog-close callback to settle only its captured flow token. Root must keep this dialog mounted/accessible when the pending card opens it even if the ordinary coworker-card overlay is closed. No new global singleton, hosted popup or alternate settings surface is needed.

## Validation status and limits

Only source reading, editing, source review and local Git handoff operations were performed. **Tests, type checks, lint, builds, packaging, installations, app servers, live model/API requests, UI/viewport QA and Mac/restart acceptance were not run.** No external services, Docker, installed app, live workspace data or Keychain were used. No push or merge.

Authored regression sources cover delayed progress before Finish; distinct card/installation revisions; duplicate clicks; no answer on mount/Apps close; exact Cancel abort; unknown progress across remount/restart; server-sealed Finish recovery without auto-submit; unavailable/corrupt retry storage; wrong/oversized responses; wrong Finish headers; disposed-owner/source reads; and root-owned stream cancellation after transfer. Root must execute and repair these sources after E/contract integration.

Remaining required root work: integrate E's API/contracts/migrations/registration and server guards; add the pending/history/attention/queue wiring; implement focused existing Apps flow ownership; adopt the accepted stream into the current chat lifecycle; render the canonical receipt; run all checks and physical Mac/restart QA. This lane does not claim an installed, runnable or accepted C6 capability before that work.
