'use client'
import { desktopMcpSseSnapshotSchema, type DesktopMcpSseMutationResult, type DesktopMcpSseRequest } from '@rerun/contracts'
import type { SseEditorAttempt, SseEditorDriver } from '@/components/desktop/mcp-sse/editor-state'
import type { SseStatusDriver } from '@/components/desktop/mcp-sse/DesktopMcpSseConnection'

export function desktopSseClient(agentId: string): { editor: SseEditorDriver; status: SseStatusDriver } {
    const request = async (body: unknown, signal: AbortSignal) => {
        const response = await fetch(`/api/desktop/coworkers/${encodeURIComponent(agentId)}/mcp-sse`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal })
        const data = await response.json()
        if (!response.ok) throw new Error('MCP acknowledgement is unavailable')
        signal.throwIfAborted()
        return data
    }
    const operation = (input: SseEditorAttempt) => input.kind === 'save' ? { kind: 'save', ...input.change } : { kind: 'delete', agentId, requestId: input.requestId, reference: input.reference }
    const operate = async (input: DesktopMcpSseRequest, signal: AbortSignal) => desktopMcpSseSnapshotSchema.parse(await request({ action: 'control', input }, signal))
    return {
        status: { read: (ref, signal) => operate({ ...ref, operation: 'status', requestId: crypto.randomUUID() }, signal), operate },
        editor: {
            journal: {
                async read(slot, signal) {
                    const saved = await request({ action: 'journal-read', slot }, signal)
                    if (!saved) return null
                    if (saved.agentId !== agentId) throw new Error('MCP editor owner changed')
                    if (saved.kind === 'save') { const { kind: _kind, ...change } = saved; return { kind: 'save', change } }
                    if (saved.kind === 'delete') return { kind: 'delete', requestId: saved.requestId, reference: saved.reference }
                    throw new Error('MCP editor attempt is invalid')
                },
                async put(slot, attempt, signal) { await request({ action: 'journal-put', slot, input: operation(attempt) }, signal) },
                async clear(slot, requestId, signal) { await request({ action: 'journal-clear', slot, requestId }, signal) },
            },
            save: (change, signal) => request({ action: 'mutate', input: { kind: 'save', ...change } }, signal) as Promise<DesktopMcpSseMutationResult>,
            remove: (reference, requestId, signal) => request({ action: 'mutate', input: { kind: 'delete', agentId, reference, requestId } }, signal) as Promise<DesktopMcpSseMutationResult>,
            reconcile: (owner, requestId, signal) => {
                if (owner !== agentId) throw new Error('MCP editor owner changed')
                return request({ action: 'reconcile', requestId }, signal) as Promise<DesktopMcpSseMutationResult>
            },
        },
    }
}
