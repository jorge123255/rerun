# UP-07 / TL03 — `notify_user` native receipts

Source package and authored unrun regressions only. **No checks executed and no Mac acceptance claim.**

- Base: `8297fe6404caa114dcb0c2cd6006291a8abb2038`
- Implementation: `01d70f6f12637cc2385ccf7739f43e5f63472128`
- Original reference: `2a57fa6dd53311f763bfc9abde85997b7f7e5309`
- Supplement reference: `ab3def9bfcf545cc9548f99c63c2b011ca094023`
- Ongoing cloud integration left untouched: `bc-714cd9be-c9ad-5527-b2ed-6e79b2a13a08`
- Branch: `desktop/finish-notify-up07`
- Hook stop: none. `.git/hooks` contains samples only, so commits did not execute tests/builds.

## Original mapping

- `apps/engine/src/tools/builtin/notify.ts`: original info-only, nonblocking tool, 16,000-character message bound, optional metadata and exact agent/session/run identity. `tool.ts` retains the description and input behavior, returning a typed receipt rather than treating every call as delivered.
- `apps/engine/src/runtime/notify.ts`: original `agent.notification` payload and `authorMetadata` behavior.
- `apps/ui/lib/notifications/inbound.ts`: `info` is attention, not run completion/error.
- `apps/ui/lib/notifications/attention-details.ts`: completion does not erase the information awaiting acknowledgement.
- `apps/desktop/src/main/notifications.mjs`: existing native `shown` / `failed` / `unknown` acknowledgement, in-flight key dedupe and no OS permission request from this package.
- `apps/ui/lib/desktop/server/notifications.ts`: existing admission/seen store and exact-attempt cleanup. `unknown` remains unconsumed; only `shown` inserts the seen identity.
- RD38 D historical notification presenters are not the live tool and were not edited.

The new engine path is `desktopNotifyTools` → authenticated loopback `/api/desktop/engine/notify-user` → canonical admission store → renderer-owned native bridge → store receipt → engine receipt. The engine waits for the store result; it does not infer delivery from a toast.

## Contracts

```ts
type DesktopNotifyUserNativeResult = {
    status: 'shown' | 'unavailable' | 'failed' | 'unknown'
}

type DesktopNotifyUserReceipt = {
    notificationId: string
    eventKey: string
    attemptId: string // UUID
    agentId: string
    sessionId: string
    runId: string | null
    message: string // full, max 16,000 characters
    metadata: Record<string, unknown> | null
    status: 'shown' | 'failed' | 'unknown'
    nativeStatus: 'shown' | 'unavailable' | 'failed' | 'unknown'
    reason?: string
    createdAt: string
}
```

`unavailable` is a definite `failed` receipt. `unknown` is never rewritten as `shown`. Invalid or lost acknowledgements become `unknown`; there is no automatic retry.

Identity is stable per exact agent/session/run/tool call:

```ts
notify-user:${agentId}:${sessionId}:${runId ?? 'no-run'}:${toolCallId}
notify:${agentId}:${sessionId}:${runId ?? 'no-run'}:${toolCallId}
```

The native body removes the main process’s disallowed control characters and is capped at 2,048 code points. The full message remains in the attention record.

## Changed paths

- `apps/engine/src/desktop/notify-tools/contract.ts`: receipt/native schemas, stable identity, body bounds and result mapping.
- `apps/engine/src/desktop/notify-tools/delivery.ts`: bounded authenticated loopback and receipt validation.
- `apps/engine/src/desktop/notify-tools/tool.ts`: original tool factory with live grant checks, author metadata and exact identity.
- `apps/engine/src/desktop/notify-tools/index.ts`: owned exports.
- `apps/engine/src/desktop/notify-tools/contract.test.ts`: identity and native-result regressions.
- `apps/engine/src/desktop/notify-tools/tool.test.ts`: original input/owner behavior, grant and no-auto-retry regressions.
- `apps/engine/src/desktop/notify-tools/delivery.test.ts`: loopback and invalid/lost acknowledgement regressions.
- `docs/desktop-finish-notify-up07-handoff.md`: this document.

No central registry, grant enum, contract barrel, migration, DesktopApp, DesktopConversation, main-process index/preload, checklist or other worktree was edited.

## Exact root activation fragments

### 1. Grant catalog and engine registration

Add `'notify'` to `desktopRerunGrantIds`, then change the existing pending catalog row to:

```ts
supported('notify', 'Send notifications', 'Deliver a coworker notification.', 'notify_user')
```

In `apps/engine/src/tools/registry.ts`, beside other ordinary desktop tools:

```ts
import { desktopNotifyTools } from './notify-tools/index.js'

if (hasDesktopToolGrant(ctx.agent.config, 'notify')) {
    Object.assign(tools, desktopNotifyTools(ctx))
}
```

The default remains off until the user enables the existing grant. Live grant checks run before and after the loopback.

### 2. Native `info` kind

Add `'info'` to the `kinds` set in `apps/desktop/src/main/notifications.mjs` and to `DesktopNotificationEvent['kind']` in `apps/ui/lib/desktop/notifications.ts`. Existing `desktop:notify` IPC, `Notification.isSupported()`, timeout and key dedupe remain canonical. No new listener or permission prompt is added.

### 3. Canonical store transitions

Use the existing tables:

- `desktop_notification_attempts(event_key,attempt_id,created_at)` reserves the effect and prevents duplicate banners.
- `desktop_notifications_seen(event_key,notified_at)` means shown only.
- `desktop_notification_terminals` retains the full attention record and receipt state: `pending`, `shown`, `failed`, `unknown`, `acknowledged`.

Do not delete a shown attempt: it is also the durable receipt identity. A failed attempt may be released for a later explicit retry. Unknown attempts stay admitted and are not retried.

Required receipt transition:

```ts
async function finishDesktopUserNotification(db: Client, input: {
    notificationId: string
    eventKey: string
    attemptId: string
    status: 'shown' | 'unavailable' | 'failed' | 'unknown'
}) {
    const status = input.status === 'shown' ? 'shown' : input.status === 'unknown' ? 'unknown' : 'failed'
    await db.execute({
        sql: `UPDATE desktop_notification_terminals
              SET status = ?
              WHERE id = ? AND status IN ('pending','failed')`,
        args: [status, input.notificationId],
    })
    if (status === 'shown') {
        await db.execute({
            sql: 'INSERT INTO desktop_notifications_seen(event_key,notified_at) VALUES (?,?) ON CONFLICT(event_key) DO NOTHING',
            args: [input.eventKey, new Date().toISOString()],
        })
    }
    if (status === 'failed') {
        await db.execute({
            sql: 'DELETE FROM desktop_notification_attempts WHERE event_key = ? AND attempt_id = ?',
            args: [input.eventKey, input.attemptId],
        })
    }
}
```

Admission validates current local owner and workspace before inserting the attention row. It returns an existing shown/unknown receipt without another native effect. A pending existing attempt may be awaited but is never fired again. The route stamps `createdAt = new Date().toISOString()` once for the attention/receipt record.

```ts
const owner = await db.execute({
    sql: `SELECT a.id AS local_agent_id, a.engine_agent_id, a.name,
                 s.id AS local_session_id, s.engine_session_id
          FROM desktop_agents a
          JOIN desktop_sessions s ON s.agent_id = a.id AND s.engine_session_id = ?
          LEFT JOIN desktop_deletions d ON d.agent_id = a.id
          WHERE a.engine_agent_id = ? AND a.workspace_id = 1
            AND a.enabled = 1 AND d.agent_id IS NULL`,
    args: [input.sessionId, input.agentId],
})
if (!owner.rows.length) throw new DesktopHttpError(404, 'The coworker or conversation was not found.')

await db.execute({
    sql: `INSERT INTO desktop_notification_terminals
        (id,agent_engine_id,agent_local_id,session_local_id,session_engine_id,run_id,
         source,slug,status,message,completed_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    args: [
        input.notificationId,
        input.agentId,
        String(owner.rows[0].local_agent_id),
        String(owner.rows[0].local_session_id),
        input.sessionId,
        input.runId,
        'chat',
        null,
        'pending',
        input.message,
        createdAt,
        createdAt,
    ],
})
```

Use the existing preference reader and `coworkerRuleOf`: `nothing` and `muted` refuse delivery. `everything`, `mine`, and an explicit coworker `everything` allow info; `needed` alone does not include it. A preference refusal is a definite `failed` receipt, never `shown`.

### 4. Engine route and bounded store wait

Create `apps/ui/app/api/desktop/engine/notify-user/route.ts` with `authenticateDesktopEngineRequest` and `readNotificationBody`. Parse the admission using the engine contract, then:

```ts
const receipt = await waitForDesktopUserReceipt(runtime, input, 10_000)
return Response.json(receipt, { headers: { 'cache-control': 'no-store' } })
```

The wait polls only the local store at a short bounded interval. It returns immediately for `shown`, `failed`, or `unknown`; while `pending`, it waits for the renderer’s receipt. At timeout it returns `unknown` with the same `attemptId`, never `shown` and never another native call.

### 5. Renderer delivery and receipt

The renderer polls only `status = 'pending'` rows. For each exact owner key it calls the existing native bridge once, then posts the native result to the existing delivery endpoint adapted to call `finishDesktopUserNotification` above:

```ts
const result = await desktopNotificationsBridge().notify({
    key: item.eventKey,
    kind: 'info',
    agentId: item.localAgentId,
    sessionId: item.localSessionId,
    requestId: item.notificationId,
    title: item.agentName,
    subtitle: 'Info',
    body: desktopNotifyUserNativeBody(item.message),
    silent: true,
})

await finishDesktopUserNotification(db, {
    notificationId: item.notificationId,
    eventKey: item.eventKey,
    attemptId: item.attemptId,
    status: result.status,
})
```

Do not reuse the current toast-first assignment as proof of delivery. The renderer must pass through the actual native result. A `pending` row becomes `shown`, `failed`, or `unknown`; only pending rows are eligible for native delivery, so an unknown result is not retried by polling.

### 6. Human acknowledgement and attention

Include pending/shown/failed/unknown info rows in the existing attention projection with `kind: 'info'` and the full message. Do not substitute a historical presenter for live delivery.

Acknowledgement is a separate exact-owner mutation, not an answer or a run resume:

```ts
await db.execute({
    sql: `UPDATE desktop_notification_terminals
          SET status = 'acknowledged'
          WHERE id = ? AND status IN ('pending','shown','failed','unknown')`,
    args: [notificationId],
})
```

Bind this to the existing notification click after revalidating the current local coworker/session. Deleted or rebound owners do not navigate or acknowledge. Board placement, drafts, ordinary chats and completion/error notifications remain unchanged.

## Authored unrun regressions

- `contract.test.ts`: exact stable identity, shown/failed/unknown mapping and native body bounds.
- `tool.test.ts`: original info input and owner metadata, missing grant, and no automatic retry for unknown/failed receipts.
- `delivery.test.ts`: authenticated loopback and invalid/lost acknowledgement becoming unknown without replay.

No tests, typecheck, lint, build, install, fixtures, formatter execution, provider/network activation, UI/browser/native actions, live DB operations, Keychain, listeners, accounts, permissions prompts, restart, guest/Docker, microphone, push, PR, merge, deploy or publication was performed.

## Behavior and limits

- **Already implemented on base:** native bridge statuses and key dedupe; admission/seen store; attention and preference infrastructure; original tool source.
- **New in this package:** live info-only tool factory, exact receipt schema, loopback adapter and root binding fragments.
- **Gated for root/integration:** grant enum/catalog, engine registration, `info` kind, route/store wait, renderer delivery, human acknowledgement and actual OS banner/click acceptance.
- **Unsupported here:** real notification firing, permission requests, listeners, hosted delivery, RD38 D rewrites, automatic uncertain retries, duplicate banner proof, or Mac acceptance.
- **Risk:** the root must not preserve the existing toast-first `status = 'shown'` shortcut on this new path. Only the native/store result may produce `shown`.
- **Risk:** long waits and renderer absence return `unknown`; this is intentional, not a failure to deliver proof.
- **Risk:** user preference refusal is definite non-delivery, not a pending notification.

Source delivery is not integration, validation, or Mac acceptance.
