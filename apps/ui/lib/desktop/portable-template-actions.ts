'use client'

import type { DesktopPortableDeleteResult, DesktopPortableExportResult, DesktopPortableImportResult } from '@rerun/contracts'
import type { DesktopPortableTemplatesClient } from './portable-template-client'
import { DesktopTemplateRequestError } from './templates-client'

export type PortableActionResult<T> =
    | { ok: true; result: T }
    | { ok: false; error: string; uncertain: boolean }

function wrap<T>(work: Promise<T>): Promise<PortableActionResult<T>> {
    return work.then(
        result => ({ ok: true as const, result }),
        (error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : 'Portable template request failed',
            uncertain: !(error instanceof DesktopTemplateRequestError && error.definite),
        }),
    )
}

export function createDesktopPortableTemplateActions(client: DesktopPortableTemplatesClient) {
    return {
        exportTemplate(input: { templateId: string; revision: string; requestId?: string }) {
            return wrap<DesktopPortableExportResult>(client.exportTemplate(input))
        },
        importPackage(input: { uploadId: string; title?: string; requestId?: string }) {
            return wrap<DesktopPortableImportResult>(client.importPackage(input))
        },
        deleteTemplate(input: { templateId: string; revision: string; requestId?: string }) {
            return wrap<DesktopPortableDeleteResult>(client.deleteTemplate(input))
        },
    }
}

export type DesktopPortableTemplateActions = ReturnType<typeof createDesktopPortableTemplateActions>
