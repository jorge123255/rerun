# Round 32 C — private secret requests in chat

Source implementation and regression sources only. Root owns central integration, every repair/check, disposable-credential testing and installed-app/restart acceptance.

## Verified original design mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/tools/builtin/hitl.ts`: `requestSecretTool`, 1–8 fields, SCREAMING_SNAKE_CASE keys, 300-character reason/help, optional docs, and delivered `HITL_ACK` end-of-turn behavior. The desktop tool keeps those semantics but removes unsupported shell/MCP substitution instructions.
- `apps/ui/components/chat/SecretRequestBlock.tsx`: existing-name-only lookup and hosted completion adapter. The desktop replacement uses acknowledged local decisions and no hosted action.
- `packages/ui/src/chat/SecretRequestBlock.tsx`: masked password inputs, existing-key placeholders, label/help/docs order, Lock icon, inline card, Save/Skip/Dismiss, local menu scrolling and responsive layout. The desktop form preserves these visuals while changing three behaviors: raw values are not trimmed, every close waits for acknowledgement, and failed attempts stay answerable.
- `packages/contracts/src/chat-hitl.ts`: names-only receipt structure and delivered HITL semantics. The new summary has no `${KEY}`, shell-command or MCP-config promise.
- `apps/ui/components/chat/HitlReceipt.tsx`: Keys card, per-key Stored/Skipped badges and names-only presentation.
- `packages/contracts/src/secrets.ts`: secret/path scanning references. No values are added to diagnostics, exports or scans.

The local form keeps `Credentials needed`, `Credential needed`, `Stored as KEY`, `Already saved. Enter a value to replace it`, `Paste the value`, `Where to find it`, `Save`, `Saving…`, `Skip`, and `Dismiss credential request`. Storage copy is now truthful: `Stored encrypted for this coworker. Never sent to the model.`

## Owned contracts and factories

### `packages/contracts/src/desktop-secret-requests.ts`

Exports canonical schemas/types for source, ordered fields, views, decisions and receipts:

- Exact `{agentId,sessionId,runId,sourceMessageId,toolCallId,fingerprint}` source.
- `requestId`, `revision`, ordered fields with `existing` presence, pending/sealed/accepted status, optional pending attempt and safe receipt.
- Save/Skip/Dismiss `{operation,requestId,attemptId,expectedRevision,source,values?}`. Only this submit schema can contain values.
- Names-only `serializeDesktopSecretReceiptSummary` and `parseDesktopSecretReceiptSummary`.
- Limits: 1–8 fields, 64-character key, 100-character label, 300-character reason/help, HTTPS docs, 16 KiB per value and 64 KiB total submitted value bytes.
- Duplicate/reserved key rejection. Reserved runtime names include `ENGINE_API_KEY`, `ENCRYPTION_KEY`, `SESSION_TOKEN`, `DATABASE_URL`, process environment names and `RERUN_`/`NEXT_` prefixes. Model input cannot select paths, engine IDs or credential namespaces.

No values, sealed payloads or decryption handles are valid in a view/receipt.

### Engine

`createDesktopSecretRequestTool(authority)` returns `request_secret`. `authorize` must perform current run/owner/grant/admission checks, including disabled/deleting/revoked/delegated-child refusal. `deliver` must persist the exact source and return it. The factory validates the input and matching tool-call source before returning original `HITL_ACK`.

### UI server

- `createDesktopSecretCrypto(keyReader)`: AES-256-GCM with context `desktop-secret-request-v1` plus domain/coworker/key/version/request/attempt. HMAC-SHA-256 keyed attempt fingerprints compare exact retry bodies without a public low-entropy secret hash.
- `ensureDesktopSecretRequestSchema(db)`: feature-owned additive tables for requests, attempts, receipts and encrypted credentials.
- `createDesktopSecretRequestStore(db,crypto)`: `publish`, `read`, `readBySource`, `existingNames`, `stage`, `sealStaged`, `decide`, `refuse`, `discard`, `markAccepted`, and narrow `useCredential`.
- `createDesktopSecretRequestContinuation(store,{send})`: `decide` and explicit `recover`.
- `createDesktopSecretRequestRuntimePorts`: binds store/current-source/current-authority/continuation into the API.
- `createDesktopSecretRequestApi`: bounded no-store GET/POST handlers with source/session and acknowledgement checks.
- `desktopSecretRequestAttention` and `canMarkDesktopSecretRequestRead`: safe Needs you/Actions/history projections.

### UI/client

- `readDesktopSecretRequest` and `submitDesktopSecretRequestDecision` in `apps/ui/lib/desktop/secret-requests-client.ts`.
- `DesktopSecretRequestBlock`: attempt identity/retry and owner lifecycle.
- `DesktopSecretRequestForm`: original masked presentation with raw-byte values and async decisions.
- `DesktopSecretRequestReceipt`: original names-only Keys presentation.

## Required root integration

### 1. Central export and schema initialization

Export the new contract through root’s normal contract policy. During database initialization, after root’s agent/session tables exist:

```ts
import { ensureDesktopSecretRequestSchema } from './secret-requests/schema'

await ensureDesktopSecretRequestSchema(db)
```

No existing migration, schema, `database.ts` or barrel was edited in this lane. Root must include its normal migration test from the previous schema.

### 2. Crypto and store mounting

Bind the existing root-owned desktop identity encryption key; never create/read a plaintext key file:

```ts
const crypto = createDesktopSecretCrypto(() => rootEncryptionKey)
const store = createDesktopSecretRequestStore(db, crypto)
```

A missing/wrong-length key throws. There is no plaintext fallback. Root must not log this key, sealed values, submit bodies or decrypted bytes.

### 3. Tool registry and default-off grant

Register `createDesktopSecretRequestTool` through root’s existing catalog/registry. Add a separate default-off secret-request grant; do not infer it from Apps/MCP/delegation grants or enable it in this lane.

`authorize` must re-check current authenticated run/owner, enabled/not-deleting owner, grant and non-delegated admission. `deliver` must bind the current local agent/session/run/source message/tool call/fingerprint and call `store.publish`. A delegated child must be denied. Delivery persists before `HITL_ACK`; the original turn ends rather than pausing a process.

### 4. Route authority factory (required missing root export)

The new route imports this root-owned function from `apps/ui/lib/desktop/server/engine.ts`:

```ts
function desktopSecretRequestPorts(runtime: DesktopRuntime, sessionId: string): DesktopSecretRequestApiPorts
```

Implement it with `createDesktopSecretRequestRuntimePorts({store,source,authority,send})`:

- `source(sessionId,signal)` reads the current source-bound request from authenticated local history and returns `{source,fields,reason?}` or null. Reject foreign history and stale sources. It never resumes a decision.
- `authority(sessionId).check` synchronously asserts the prepared current local agent/session identity, enabled/not-deleting owner and current grant. Abort/revoke before effects and before commit.
- `send(receipt,source,mode)` is root’s provider/queue adapter. `replay` performs replay-only lookup; `send` admits only the same source guard and continuation request ID.

The route already uses `desktopRoute` authentication. No parallel runtime or global singleton is introduced.

### 5. Provider/queue continuation

Root’s queued-turn schema/admission must accept a secret source guard analogous to question/approval/service guards. The continuation message is `receipt.summary` and the queued run ID is `receipt.continuationRequestId`:

```ts
await chat(engine, agent.engineAgentId, {
    sessionId: session.engineSessionId,
    message: receipt.summary,
    desktopQueuedTurn: {
        runId: receipt.continuationRequestId,
        ...(mode === 'replay' ? { replayOnly: true } : {}),
        secret: source,
    },
    source: 'dashboard',
})
```

Return exact local session/run acknowledgement. `createDesktopSecretRequestContinuation` tries replay first, then first send, and marks accepted only after matching acknowledgement. An accepted receipt returns a DONE replay without another message. Root must block ordinary sends while the source request is pending, without blocking exact saved continuation replay.

### 6. Attention, history and UI mount

Use `desktopSecretRequestAttention(view)` for pending Needs you/Actions projections and `canMarkDesktopSecretRequestRead(view,{requestId,revision})` for exact completion/read races. These expose only request identity, tool-call ID and names-only summary.

Root fetches with `readDesktopSecretRequest(sessionId)` and mounts only the exact source-bound block:

```tsx
<DesktopSecretRequestBlock
    sessionId={session.id}
    request={request}
    active={active}
    inline
    onAccepted={response => consumeAcknowledgedContinuation(response)}
/>
```

`onAccepted` may consume the returned SSE/DONE response through root’s existing transport. Save success clears fields on the server acknowledgement, not on mount or request initiation. Root must refresh the view/receipt and attention projection afterward.

### 7. Authorized consumer boundary

Root alone decides whether a supported operation may consume a credential:

```ts
await store.useCredential(agentId, key, { check: assertCurrentSupportedOperation }, async value => {
    // Use bytes in the narrowly authorized operation, then discard the reference.
})
```

This callback must not be exposed to the renderer/model. Do not inject all names/values into prompts, child environments, generic shell commands, MCP configs, templates or diagnostics. A receipt or stored value grants no operation. OAuth, app sign-in, credential import and arbitrary runtime substitution are not implemented.

## Durable, retry, restart and error semantics

- Save validates keys against the current request and preserves exact UTF-16-to-UTF-8 input bytes, including spaces/newlines. Empty values are not provided. Per-value/total bounds are enforced before encryption.
- Save first inserts an encrypted staged attempt with exact source/revision and credential versions. A second transaction re-checks authority/source/versions, seals credential updates and the receipt together, and clears staging. Wrong-owner/source/revision or newer-credential conflicts refuse before effects.
- Same-attempt retry compares a keyed fingerprint of operation/revision/source/exact values. Changed bodies refuse. A sealed replay performs no credential write and returns the same receipt/continuation identity. A different Save/Skip/Dismiss attempt cannot produce a second receipt.
- Skip and Dismiss create all-skipped receipts and never delete/replace existing credentials. They do not claim saved values.
- Decisions persist before continuation. Lost Save/Finish acknowledgement retries the sealed receipt. Lost continuation acknowledgement replays the same run before any first send. Unknown responses remain sealed and retryable, never accepted early.
- `refuse` tombstones a matching unsealed attempt and clears encrypted staging, so a lost definitive-refusal acknowledgement cannot later become a Save. `discard` removes only a matching unsealed staged attempt after exact fingerprint verification. Completed credentials/receipts remain. `recover` is explicit; GET/mount/restart never Save or resume automatically.
- Metadata lives in the desktop database, not loopback origin, browser storage or a plaintext `.env`. Reopening the same store after restart/port change recovers attempts/receipts without origin state.
- Form values remain only in the active form/attempt memory. Save/Skip/Dismiss failures preserve them for correction/retry. Successful acknowledgement, explicit successful close, owner change and disposal clear them. Late responses cannot complete a replacement owner.
- Existing-name reads, views, receipts, notifications and summaries contain no values. Encryption/validation errors do not include submitted values.

## Implemented / dependent / unsupported matrix

| Area | Implemented in lane | Root dependency | Unsupported here |
| --- | --- | --- | --- |
| Canonical request | Source, fields, revisions, decisions and safe receipts | Central export | Values in views/history |
| Delivered tool | Validated factory and original HITL_ACK | Default-off grant/registry/current run authority | Auto-enable or delegated-child requests |
| Encrypted storage | AAD-bound crypto, schema, two-phase store | Identity key and DB initialization | Plaintext fallback or reusable renderer handles |
| Save/Skip/Dismiss | Raw bytes, revision/source/version guards, keyed replay | Current authority checks | Silent trim, duplicate receipt or deletion on close |
| Continuation | Sealed-first replay/send and exact acknowledgement | Provider/queue guard and transport | Automatic GET/restart resume |
| Attention/history | Names-only pending and read projections | Central mounts | Secret notifications/transcript exports |
| Masked UI | Original layout, existing indicators, async lifecycle | Exact source mount and SSE consumer | Auto-submit/prefill/hosted actions |
| Runtime consumer | Narrow authorized `useCredential` callback | Root-selected supported operation | OAuth, sign-in, shell/MCP/generic secret injection |
| Verification | Regression sources with dummy values/fake key only | Run/repair every check and disposable-credential QA | Real credentials, cloud decisions or acceptance |

## Regression sources authored, all unrun

- `apps/ui/components/desktop/secret-requests/contracts.test.ts`: field/reserved/duplicate bounds, value-free views, exact submit bytes and names-only summary parsing.
- `apps/engine/src/desktop/secret-requests/request-secret.test.ts`: delivery/ACK, revoked/delegated authority, invalid input and foreign source.
- `apps/ui/lib/desktop/server/secret-requests/store.test.ts`: exact bytes, sealed-at-rest context, names-only views, replay/changed-body, concurrent Save/Skip, newer-credential conflict, Skip preservation, wrong owner/revocation, restart recovery, staging/discard, definitive-refusal tombstones and unauthorized consumer.
- `apps/ui/lib/desktop/server/secret-requests/service.test.ts`: persist-before-continue, replay/lost acknowledgement, unknown response and pending-inbox completion race.
- `apps/ui/lib/desktop/secret-requests-client.test.ts`: canonical routes, exact body, foreign/unknown acknowledgement.
- `apps/ui/components/desktop/secret-requests/DesktopSecretRequestBlock.test.tsx`: masked design/help/docs/existing indicators, no auto-submit, raw bytes, retry lifecycle, owner/disposal clearing and names-only receipt.

No tests, typecheck, lint, builds, installs, servers, UI/provider/network calls, Docker, Keychain, live data access or restart acceptance were performed. Installed Next.js guides under `node_modules/next/dist/docs` are absent in this checkout; no installation was attempted.

## Changed files

- `packages/contracts/src/desktop-secret-requests.ts`
- `apps/engine/src/desktop/secret-requests/request-secret.ts`
- `apps/engine/src/desktop/secret-requests/request-secret.test.ts`
- `apps/ui/lib/desktop/server/secret-requests/crypto.ts`
- `apps/ui/lib/desktop/server/secret-requests/schema.ts`
- `apps/ui/lib/desktop/server/secret-requests/store.ts`
- `apps/ui/lib/desktop/server/secret-requests/store.test.ts`
- `apps/ui/lib/desktop/server/secret-requests/service.ts`
- `apps/ui/lib/desktop/server/secret-requests/service.test.ts`
- `apps/ui/lib/desktop/server/secret-requests/api.ts`
- `apps/ui/lib/desktop/server/secret-requests/runtime.ts`
- `apps/ui/lib/desktop/secret-requests-client.ts`
- `apps/ui/lib/desktop/secret-requests-client.test.ts`
- `apps/ui/components/desktop/secret-requests/DesktopSecretRequestForm.tsx`
- `apps/ui/components/desktop/secret-requests/DesktopSecretRequestReceipt.tsx`
- `apps/ui/components/desktop/secret-requests/DesktopSecretRequestBlock.tsx`
- `apps/ui/components/desktop/secret-requests/DesktopSecretRequestBlock.test.tsx`
- `apps/ui/components/desktop/secret-requests/contracts.test.ts`
- `apps/ui/app/api/desktop/sessions/[sessionId]/secret-requests/route.ts`
- `docs/desktop-round32-c-handoff.md`
