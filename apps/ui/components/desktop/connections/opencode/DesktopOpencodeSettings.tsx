'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { connectionsListSchema, DESKTOP_OPENCODE_CONNECTION_ID, type ConnectionsList, type DesktopOpencodeConnectionChange } from '@rerun/contracts'
import { changeDesktopOpencode, createDesktopOpencodeDriver } from '@/lib/desktop/opencode/client'
import type { DesktopOpencodeConnectionSnapshot } from '@/lib/desktop/opencode/driver'
import { DesktopOpencodeConnection } from './DesktopOpencodeConnection'

export function DesktopOpencodeSettings({ workspaceId, rejected, onProviders, onBack }: {
    workspaceId: number
    rejected: boolean
    onProviders: (providers: ConnectionsList) => void
    onBack: () => void
}) {
    const driver = useMemo(createDesktopOpencodeDriver, [])
    const lifetime = useRef<AbortController | null>(null)
    const [connection, setConnection] = useState<DesktopOpencodeConnectionSnapshot | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    useEffect(() => {
        const controller = new AbortController()
        lifetime.current = controller
        void driver.snapshot({ workspaceId, connectionId: DESKTOP_OPENCODE_CONNECTION_ID }, controller.signal)
            .then(value => { if (!controller.signal.aborted) setConnection(value) })
            .catch(() => { if (!controller.signal.aborted) setError('OpenCode settings could not be loaded.') })
            .finally(() => { if (!controller.signal.aborted) setLoading(false) })
        return () => controller.abort()
    }, [driver, workspaceId])

    function signal() {
        const current = lifetime.current?.signal
        if (!current || current.aborted) throw new Error('The workspace changed.')
        return current
    }

    async function publish(change: DesktopOpencodeConnectionChange) {
        const current = signal()
        const view = await changeDesktopOpencode(change, current)
        current.throwIfAborted()
        setConnection(view ? { ...view, owner: view.name, connectionRevision: view.revision, state: 'active', credentialStored: true } : null)
    }

    async function refreshProviders() {
        const current = signal()
        const response = await fetch('/api/desktop/settings', { cache: 'no-store', signal: current })
        if (!response.ok) throw new Error('Provider list could not be loaded.')
        const list = connectionsListSchema.parse(await response.json())
        current.throwIfAborted()
        onProviders(list)
    }

    if (loading) return <p role="status">Loading OpenCode settings…</p>
    if (error) return <p role="alert">{error}</p>
    return <DesktopOpencodeConnection workspaceId={workspaceId} connection={connection} driver={driver} rejected={rejected}
        onProviders={refreshProviders} onBack={onBack}
        onSave={change => {
            if (change.action === 'key') return publish({ action: 'key', workspaceId, expectedRevision: change.expectedConnectionRevision ?? null, apiKey: change.apiKey })
            if (change.action === 'models' && connection && change.expectedConnectionRevision)
                return publish({ action: 'models', workspaceId, expectedRevision: change.expectedConnectionRevision,
                    enabledModelIds: change.models, defaultModelId: connection.defaultModelId, consoleEnabled: change.consoleEnabled })
            return Promise.reject(new Error('OpenCode connection changed.'))
        }}
        onRename={(_id, name, expectedRevision) => publish({ action: 'rename', workspaceId, name, expectedRevision })}
        onDisconnect={async (_id, expectedRevision) => {
            await publish({ action: 'disconnect', workspaceId, expectedRevision })
            await refreshProviders()
        }} />
}
