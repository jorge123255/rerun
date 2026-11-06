'use client'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { desktopMcpSecretReferencePublicConfig, desktopMcpSecretReferenceSaveResultSchema, desktopMcpSecretReferenceSaveSchema } from '@rerun/contracts'
import { DesktopMcpSecretReferenceEditor, type DesktopMcpSecretReferenceEditorProps } from './DesktopMcpSecretReferenceEditor'
import type { SecretReferenceEditorAttempt, SecretReferenceEditorDriver } from './editor-state'

type Snapshot = Pick<DesktopMcpSecretReferenceEditorProps, 'agentId' | 'origin' | 'config' | 'expectedConfigRevision' | 'expectedBindingRevision' | 'presence'>
export function DesktopMcpReferenceSettings({ agentId, name, onBack, onDone }: { agentId: string; name: string; onBack(): void; onDone(): void }) {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [error, setError] = useState('')
    const url = `/api/desktop/coworkers/${encodeURIComponent(agentId)}/mcp-secret-references`
    useEffect(() => {
        const controller = new AbortController()
        setSnapshot(null); setError('')
        void fetch(`${url}?serverName=${encodeURIComponent(name)}`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
            const raw = await response.json(), config = desktopMcpSecretReferencePublicConfig(raw.config)
            if (!response.ok || !config || raw.agentId !== agentId || config.name !== name || typeof raw.origin !== 'string' || typeof raw.expectedConfigRevision !== 'string' || !Number.isSafeInteger(raw.expectedBindingRevision) || !Array.isArray(raw.presence)) throw new Error()
            if (!controller.signal.aborted) setSnapshot({ ...raw, config })
        }).catch(() => { if (!controller.signal.aborted) setError('Could not load MCP credential settings. Return to the server and try again.') })
        return () => controller.abort()
    }, [agentId, name, url])
    const driver = useMemo<SecretReferenceEditorDriver>(() => {
        const key = (slot: string) => `rerun.desktop.mcp-reference-attempt:${slot}`
        const pending = (slot: string): SecretReferenceEditorAttempt | null => {
            const raw = localStorage.getItem(key(slot))
            if (!raw) return null
            const parsed = JSON.parse(raw)
            if (parsed.kind !== 'save') throw new Error('Invalid settings recovery')
            return { kind: 'save', change: desktopMcpSecretReferenceSaveSchema.parse(parsed.change) }
        }
        return {
            journal: {
                async read(slot, signal) { signal.throwIfAborted(); return pending(slot) },
                async put(slot, attempt, signal) { signal.throwIfAborted(); const current = pending(slot); if (current && current.change.saveId !== attempt.change.saveId) throw new Error('Settings recovery changed'); localStorage.setItem(key(slot), JSON.stringify(attempt)) },
                async clear(slot, id, signal) { signal.throwIfAborted(); if (pending(slot)?.change.saveId === id) localStorage.removeItem(key(slot)) },
            },
            async save(change, signal) {
                const response = await fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) })
                const result = desktopMcpSecretReferenceSaveResultSchema.parse(await response.json())
                if (!response.ok && !['conflict', 'not-saved'].includes(result.status)) throw new Error('Unknown settings outcome')
                return result
            },
            async reconcile(owner, saveId, signal) {
                if (owner !== agentId) throw new Error('Settings owner changed')
                const attempt = pending(JSON.stringify(['mcp-secret-references', agentId, name]))
                if (!attempt || attempt.change.saveId !== saveId) throw new Error('Recovery changed')
                const response = await fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'reconcile', change: attempt.change }) })
                const body = await response.json()
                if (body.status === 'not-saved') return desktopMcpSecretReferenceSaveResultSchema.parse(body)
                if (!response.ok) throw new Error('Settings outcome unavailable')
                return desktopMcpSecretReferenceSaveResultSchema.parse(body)
            },
        }
    }, [agentId, name, url])
    if (!snapshot) return <div className="space-y-3 p-3"><Button variant="ghost" size="sm" onClick={onBack}>Back to MCP servers</Button><p role={error ? 'alert' : 'status'} className="text-sm">{error || 'Loading credential settings…'}</p></div>
    return <DesktopMcpSecretReferenceEditor {...snapshot} driver={driver} onBack={onBack} onDone={onDone}/>
}
