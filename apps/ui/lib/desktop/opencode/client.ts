'use client'

import { desktopOpencodeRefreshSchema } from '@rerun/contracts'
import { desktopOpencodeConnectionSnapshotSchema } from './driver'
import type { DesktopOpencodeConnectionScope, DesktopOpencodeDriver } from './driver'

async function request(body: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await fetch('/api/desktop/opencode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal,
    })
    const text = await response.text()
    if (text.length > 1_000_000) throw new Error('OpenCode response is too large.')
    const result: unknown = text ? JSON.parse(text) : null
    if (result && typeof result === 'object' && 'status' in result && result.status !== 'saved') throw new Error('message' in result && typeof result.message === 'string' ? result.message : 'OpenCode request failed.')
    if (!response.ok) throw new Error('OpenCode request was not confirmed.')
    signal.throwIfAborted()
    return result
}

export function createDesktopOpencodeDriver(): DesktopOpencodeDriver {
    return {
        snapshot: async (scope: DesktopOpencodeConnectionScope, signal) => {
            const response = await fetch(`/api/desktop/opencode/connection?${new URLSearchParams({ workspaceId: String(scope.workspaceId), connectionId: scope.connectionId })}`, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal })
            if (!response.ok) throw new Error('OpenCode connection could not be read.')
            const result = desktopOpencodeConnectionSnapshotSchema.nullable().parse(await response.json())
            if (result && (result.workspaceId !== scope.workspaceId || result.connectionId !== scope.connectionId)) throw new Error('OpenCode connection changed.')
            return result
        },
        prepare: async (apiKey, signal) => request({ action: 'prepare', apiKey }, signal) as ReturnType<DesktopOpencodeDriver['prepare']>,
        catalog: async (scope, signal) => desktopOpencodeRefreshSchema.parse(await request({ action: 'catalog', ...scope }, signal)),
        refresh: async (scope, signal) => desktopOpencodeRefreshSchema.parse(await request({ action: 'refresh', ...scope }, signal)),
        usage: async (scope, signal) => request({ action: 'usage', ...scope }, signal) as ReturnType<DesktopOpencodeDriver['usage']>,
        enable: async (input, signal) => request({ action: 'enable', ...input }, signal) as ReturnType<DesktopOpencodeDriver['enable']>,
        disconnect: async (scope, signal) => request({ action: 'disconnect', ...scope }, signal) as ReturnType<DesktopOpencodeDriver['disconnect']>,
    }
}
