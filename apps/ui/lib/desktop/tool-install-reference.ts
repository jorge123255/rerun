import { z } from 'zod'
import { desktopToolInstallSnapshotSchema } from '@rerun/contracts'

export const desktopToolInstallReferenceSchema = desktopToolInstallSnapshotSchema.pick({ operationId: true, agentId: true, sessionId: true, runId: true, toolCallId: true }).strict()
export type DesktopToolInstallReference = z.infer<typeof desktopToolInstallReferenceSchema>
/** Public history retains only the opaque reference; the card reads current state from its ledger. */
export function desktopToolInstallReferenceOf(raw: unknown): DesktopToolInstallReference | null {
    let value = raw
    for (let depth = 0; depth < 3; depth++) {
        if (typeof value === 'string') { if (value.length > 128000) return null; try { value = JSON.parse(value) } catch { return null } }
        if (value && typeof value === 'object' && !Array.isArray(value) && 'type' in value && value.type === 'json' && 'value' in value) value = value.value
        else break
    }
    const reference = desktopToolInstallReferenceSchema.safeParse(value)
    if (reference.success) return reference.data
    const snapshot = desktopToolInstallSnapshotSchema.safeParse(value)
    if (!snapshot.success) return null
    return desktopToolInstallReferenceSchema.parse({ operationId: snapshot.data.operationId, agentId: snapshot.data.agentId, sessionId: snapshot.data.sessionId, runId: snapshot.data.runId, toolCallId: snapshot.data.toolCallId })
}
