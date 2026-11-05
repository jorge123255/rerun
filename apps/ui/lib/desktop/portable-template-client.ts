'use client'

import {
    desktopPortableDeleteResultSchema,
    desktopPortableExportResultSchema,
    desktopPortableImportResultSchema,
    desktopPortableOperationSchema,
    desktopPortableReceiptSchema,
    type DesktopPortableDeleteResult,
    type DesktopPortableExportResult,
    type DesktopPortableImportResult,
    type DesktopPortableReceipt,
} from '@rerun/contracts'
import { DesktopTemplateRequestError } from './templates-client'

const UNKNOWN = 'Local portable template acknowledgement is unknown. Retry the same attempt.'

export function createDesktopPortableTemplatesClient() {
    const base = '/api/desktop/templates'
    const controllers = new Set<AbortController>()
    let closed = false

    async function fetchResponse(url: string, init: RequestInit): Promise<unknown> {
        if (closed) throw new DesktopTemplateRequestError('Template panel was closed. Reopen it to reconcile the attempt.', false)
        const controller = new AbortController()
        controllers.add(controller)
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
            const response = await fetch(url, { ...init, cache: 'no-store', signal })
            const data = await response.json()
            signal.throwIfAborted()
            if (closed) throw new Error('Panel closed')
            if (!response.ok) {
                throw new DesktopTemplateRequestError(
                    typeof data.error === 'string' ? data.error : 'Portable template request refused',
                    [400, 404, 409, 413, 503].includes(response.status),
                )
            }
            return data
        } catch (error) {
            if (error instanceof DesktopTemplateRequestError) throw error
            throw new DesktopTemplateRequestError(UNKNOWN, false)
        } finally {
            controllers.delete(controller)
        }
    }

    function request(body: Record<string, unknown>, intent = false) {
        return fetchResponse(`${base}/portable${intent ? '/intent' : ''}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
    }

    async function mutate(body: Record<string, unknown>) {
        const operation = desktopPortableOperationSchema.parse(await request({ operation: body }, true))
        return request(operation)
    }

    return {
        async exportTemplate(input: { templateId: string; revision: string; requestId?: string }): Promise<DesktopPortableExportResult> {
            return desktopPortableExportResultSchema.parse(await mutate({
                operation: 'export',
                requestId: input.requestId ?? crypto.randomUUID(),
                templateId: input.templateId,
                revision: input.revision,
            }))
        },
        async importPackage(input: { uploadId: string; title?: string; requestId?: string }): Promise<DesktopPortableImportResult> {
            return desktopPortableImportResultSchema.parse(await mutate({
                operation: 'import-package',
                requestId: input.requestId ?? crypto.randomUUID(),
                uploadId: input.uploadId,
                ...(input.title ? { title: input.title } : {}),
            }))
        },
        async deleteTemplate(input: { templateId: string; revision: string; requestId?: string }): Promise<DesktopPortableDeleteResult> {
            return desktopPortableDeleteResultSchema.parse(await mutate({
                operation: 'delete',
                requestId: input.requestId ?? crypto.randomUUID(),
                templateId: input.templateId,
                revision: input.revision,
            }))
        },
        async receipt(requestId: string): Promise<DesktopPortableReceipt> {
            return desktopPortableReceiptSchema.parse(await fetchResponse(`${base}/portable/receipt?requestId=${encodeURIComponent(requestId)}`, { method: 'GET' }))
        },
        dispose() {
            closed = true
            for (const controller of controllers) controller.abort()
            controllers.clear()
        },
    }
}

export type DesktopPortableTemplatesClient = ReturnType<typeof createDesktopPortableTemplatesClient>
