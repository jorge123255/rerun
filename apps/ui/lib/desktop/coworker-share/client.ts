'use client'

import { z } from 'zod'
import {
    desktopCoworkerShareReceiptSchema,
    desktopCoworkerShareReviewResultSchema,
    desktopCoworkerSharePlanSchema,
    desktopCoworkerSnapshotResultSchema,
    desktopCoworkerSnapshotManifestSchema,
    type DesktopCoworkerShareExportInput,
    type DesktopCoworkerShareImportInput,
    type DesktopCoworkerShareReviewInput,
    type DesktopCoworkerShareRevokeInput,
} from '@rerun/contracts'
import { refusedDestinationReason } from './sections'

const UNKNOWN = 'Local share acknowledgement is unknown. Retry the same attempt.'

export class DesktopCoworkerShareRequestError extends Error {
    constructor(message: string, readonly definite: boolean) {
        super(message)
        this.name = 'DesktopCoworkerShareRequestError'
    }
}

const importResultSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('imported'), importedAgentId: z.string().min(1).max(160) }),
    z.strictObject({ status: z.literal('uncertain'), importedAgentId: z.undefined().optional(), recoverable: z.literal(true), reason: z.string().min(1).max(400) }),
])
export type DesktopCoworkerShareImportResult = z.infer<typeof importResultSchema>

export function createDesktopCoworkerShareClient({ workspaceId, routeAgentId }: { workspaceId: number; routeAgentId: string }) {
    const base = `/api/desktop/coworkers/${encodeURIComponent(routeAgentId)}/share`
    const controllers = new Set<AbortController>()
    let closed = false

    async function fetchResponse(url: string, init: RequestInit): Promise<unknown> {
        if (closed) throw new DesktopCoworkerShareRequestError('Share panel was closed. Reopen it to reconcile the attempt.', false)
        const controller = new AbortController()
        controllers.add(controller)
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
            const response = await fetch(url, { ...init, cache: 'no-store', signal })
            const data = await response.json()
            signal.throwIfAborted()
            if (closed) throw new DesktopCoworkerShareRequestError(UNKNOWN, false)
            if (!response.ok) {
                const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
                    ? data.error : 'Local share request refused'
                throw new DesktopCoworkerShareRequestError(message, [400, 404, 409, 413].includes(response.status))
            }
            return data
        } catch (error) {
            if (error instanceof DesktopCoworkerShareRequestError) throw error
            throw new DesktopCoworkerShareRequestError(UNKNOWN, false)
        } finally {
            controllers.delete(controller)
        }
    }

    function post(body: Record<string, unknown>) {
        return fetchResponse(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
    }

    function scoped(input: DesktopCoworkerShareReviewInput | DesktopCoworkerShareExportInput) {
        if (input.workspaceId !== workspaceId || input.agentId !== routeAgentId) {
            throw new DesktopCoworkerShareRequestError('This share belongs to another workspace or coworker.', true)
        }
        return input
    }

    return {
        async plan() {
            const result = z.strictObject({ plan: desktopCoworkerSharePlanSchema }).parse(await post({ action: 'plan', workspaceId, agentId: routeAgentId }))
            return result.plan
        },
        async review(input: Omit<DesktopCoworkerShareReviewInput, 'workspaceId' | 'agentId'>) {
            const scopedInput = scoped({ ...input, workspaceId, agentId: routeAgentId })
            return desktopCoworkerShareReviewResultSchema.parse(await post({ action: 'review', ...scopedInput }))
        },
        async export(input: DesktopCoworkerShareExportInput) {
            return desktopCoworkerSnapshotResultSchema.parse(await post({ action: 'export', ...scoped(input) }))
        },
        async preview(snapshotId: string) {
            const query = new URLSearchParams({ snapshotId, preview: '1' })
            const result = z.strictObject({ manifest: desktopCoworkerSnapshotManifestSchema }).parse(await fetchResponse(`${base}?${query}`, { method: 'GET' }))
            return result.manifest
        },
        downloadUrl(snapshotId: string) {
            return `${base}?${new URLSearchParams({ snapshotId })}`
        },
        async import(input: DesktopCoworkerShareImportInput): Promise<DesktopCoworkerShareImportResult> {
            const data = await post({ action: 'import', ...input })
            const parsed = importResultSchema.safeParse(data)
            if (parsed.success) return parsed.data
            const refused = refusedDestinationReason(data)
            if (refused) throw new DesktopCoworkerShareRequestError(refused, true)
            throw new DesktopCoworkerShareRequestError(UNKNOWN, false)
        },
        async revoke(input: DesktopCoworkerShareRevokeInput) {
            return desktopCoworkerShareReceiptSchema.parse(await post({ action: 'revoke', ...input }))
        },
        dispose() {
            closed = true
            for (const controller of controllers) controller.abort()
            controllers.clear()
        },
    }
}

export type DesktopCoworkerShareClient = ReturnType<typeof createDesktopCoworkerShareClient>
