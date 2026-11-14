'use client'

import {
    DESKTOP_OPENCODE_CONNECTION_ID, desktopOpencodeConnectionView, desktopOpencodeEnableProblem, desktopOpencodeKeyProblem,
    desktopOpencodeRefreshSchema, desktopOpencodeUsageView, type DesktopOpencodeConnectionChange,
} from '@rerun/contracts'
import { z } from 'zod'
import type { DesktopOpencodeConnectionScope, DesktopOpencodeDriver } from './driver'

const path = '/api/desktop/opencode/settings'
const viewSchema = z.object({ connection: desktopOpencodeConnectionView.nullable() })

async function request(pathname: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await fetch(pathname, {
        ...(body !== undefined && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal,
    })
    const result: unknown = await response.json()
    if (!response.ok) {
        const problem = z.object({ error: z.string().max(350) }).safeParse(result)
        throw new Error(problem.success ? problem.data.error : 'OpenCode request was not confirmed.')
    }
    signal.throwIfAborted()
    return result
}

export async function changeDesktopOpencode(change: DesktopOpencodeConnectionChange, signal: AbortSignal) {
    const { connection } = viewSchema.parse(await request(path, signal, change))
    if (connection && connection.workspaceId !== change.workspaceId) throw new Error('OpenCode connection changed.')
    return connection
}

export function createDesktopOpencodeDriver(): DesktopOpencodeDriver {
    const catalog: DesktopOpencodeDriver['catalog'] = async ({ connectionId, ...scope }, signal) => {
        if (connectionId !== DESKTOP_OPENCODE_CONNECTION_ID) throw new Error('OpenCode connection changed.')
        const view = desktopOpencodeRefreshSchema.parse(await request(path, signal, { action: 'catalog', ...scope }))
        if (view.workspaceId !== scope.workspaceId || view.requestId !== scope.requestId) throw new Error('OpenCode catalog changed.')
        return view
    }
    const driver: DesktopOpencodeDriver = {
        snapshot: async (scope: DesktopOpencodeConnectionScope, signal) => {
            if (scope.connectionId !== DESKTOP_OPENCODE_CONNECTION_ID) throw new Error('OpenCode connection changed.')
            const { connection } = viewSchema.parse(await request(path + '?workspaceId=' + scope.workspaceId, signal))
            if (!connection) return null
            if (connection.workspaceId !== scope.workspaceId) throw new Error('OpenCode connection changed.')
            return { ...connection, owner: connection.name, connectionRevision: connection.revision, state: 'active', credentialStored: true }
        },
        prepare: async (apiKey, signal) => {
            signal.throwIfAborted()
            const problem = desktopOpencodeKeyProblem(apiKey)
            return problem ? { ok: false, problem } : { ok: true }
        },
        catalog,
        refresh: async ({ connectionId, ...scope }, signal) => {
            if (connectionId !== DESKTOP_OPENCODE_CONNECTION_ID) throw new Error('OpenCode connection changed.')
            const view = desktopOpencodeRefreshSchema.parse(await request(path, signal, { action: 'refresh', ...scope }))
            if (view.workspaceId !== scope.workspaceId || view.requestId !== scope.requestId) throw new Error('OpenCode catalog changed.')
            return view
        },
        usage: async ({ workspaceId, connectionId, refresh }, signal) => {
            if (connectionId !== DESKTOP_OPENCODE_CONNECTION_ID) throw new Error('OpenCode connection changed.')
            return desktopOpencodeUsageView.parse(await request(path, signal, { action: 'usage', workspaceId, refresh }))
        },
        enable: async (input, signal) => {
            const view = await catalog({ workspaceId: input.workspaceId, connectionId: input.connectionId,
                requestId: 'enable-preview', selectedModelId: input.defaultModelId }, signal)
            const problem = desktopOpencodeEnableProblem({ ...input, knownIds: view.models.map(model => model.id) })
            return problem ? { ok: false, problem } : { ok: true }
        },
        disconnect: async (scope, signal) => {
            const connection = await driver.snapshot(scope, signal)
            if (!connection) throw new Error('OpenCode connection changed.')
            await changeDesktopOpencode({ action: 'disconnect', workspaceId: scope.workspaceId, expectedRevision: connection.connectionRevision }, signal)
            return { ok: true }
        },
    }
    return driver
}
