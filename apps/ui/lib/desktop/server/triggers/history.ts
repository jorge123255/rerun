import 'server-only'
import { z } from 'zod'
import { desktopTriggerHistoryItemSchema } from '@rerun/contracts'
import type { Client } from '@libsql/client'
import type { DesktopRuntime } from '../runtime'
import { DesktopHttpError } from '../auth'
import { findDesktopSession } from '../store'
import { readDesktopQuestion } from '../questions'
import { readDesktopApproval } from '../approvals'
import { readDesktopTakeover } from '../takeover'
import { readPendingDesktopServiceToolCallView } from '../service-requests/view'
const envelope = z.strictObject({ items: z.array(desktopTriggerHistoryItemSchema), pending: z.array(z.strictObject({ eventId: z.string(), localSessionId: z.string(), engineSessionId: z.string(), toolCallId: z.string() })) })
export async function projectDesktopTriggerHistory(runtime: DesktopRuntime, db: Client, agentId: string, value: unknown, signal?: AbortSignal) {
    const parsed = envelope.parse(value), results = []
    for (const item of parsed.items) {
        const pending = parsed.pending.find(row => row.eventId === item.eventId)
        if (!pending || item.status !== 'needs-input') { results.push(item); continue }
        const session = await findDesktopSession(db, pending.localSessionId)
        if (!session || session.agentId !== agentId || session.engineSessionId !== pending.engineSessionId) throw new DesktopHttpError(409, 'Trigger conversation identity changed')
        const options = { signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) }
        const unresolved = (await readDesktopQuestion(runtime, session.id, options)).question?.toolCallId === pending.toolCallId || (await readDesktopApproval(runtime, session.id, options)).approval?.toolCallId === pending.toolCallId || (await readDesktopTakeover(runtime, session.id, options)).takeover?.toolCallId === pending.toolCallId || await readPendingDesktopServiceToolCallView(runtime, session.id, options) === pending.toolCallId
        results.push(unresolved ? item : { ...item, status: 'finished' as const })
    }
    return results
}
