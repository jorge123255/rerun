import { z } from 'zod'
import {
    desktopPortableDeleteResultSchema,
    desktopPortableExportResultSchema,
    desktopPortableImportResultSchema,
    desktopPortableOperationSchema,
    desktopPortableReceiptSchema,
    type DesktopPortableOperation,
} from '@rerun/contracts'
import { TemplateRequestError } from './errors.js'
import { deleteDesktopPortableTemplate, reconcilePortableDelete, type PortableDeleteDeps } from './portable-delete.js'
import { exportDesktopPortableTemplate, type PortableExportDeps } from './portable-export.js'
import { importDesktopPortableTemplate, type PortableImportDeps } from './portable-import.js'
import { readOwnJson, requestHome } from './store.js'

export type PortableTemplateDeps = PortableExportDeps & PortableImportDeps & PortableDeleteDeps

export function createDesktopPortableTemplateService(deps: PortableTemplateDeps) {
    if (!deps.dataRoot) throw new TemplateRequestError(503, 'Portable template storage root is not configured')

    return {
        async handle(operation: DesktopPortableOperation) {
            const parsed = desktopPortableOperationSchema.parse(operation)
            switch (parsed.operation) {
                case 'export':
                    return desktopPortableExportResultSchema.parse(await exportDesktopPortableTemplate({
                        requestId: parsed.requestId,
                        templateId: parsed.templateId,
                        revision: parsed.revision,
                        deps,
                    }))
                case 'import-package':
                    if (!deps.readImmutableUpload) throw new TemplateRequestError(503, 'Immutable upload callback is not configured')
                    return desktopPortableImportResultSchema.parse(await importDesktopPortableTemplate({
                        requestId: parsed.requestId,
                        uploadId: parsed.uploadId,
                        title: parsed.title,
                        deps,
                    }))
                case 'delete':
                    return desktopPortableDeleteResultSchema.parse(await deleteDesktopPortableTemplate({
                        requestId: parsed.requestId,
                        templateId: parsed.templateId,
                        revision: parsed.revision,
                        deps,
                    }))
                case 'portable-receipt':
                    return this.receipt(parsed.requestId)
            }
        },

        async receipt(requestId: string) {
            if (!z.uuid().safeParse(requestId).success) throw new TemplateRequestError(400, 'Invalid portable request')
            const home = requestHome(deps.dataRoot)
            for (const [operation, name] of [
                ['export', `portable-export-${requestId}.json`],
                ['import-package', `portable-import-${requestId}.json`],
                ['delete', `portable-delete-${requestId}.json`],
            ] as const) {
                const raw = await readOwnJson(home, name)
                if (!raw || typeof raw !== 'object') continue
                const row = raw as Record<string, unknown>
                if (row.requestId !== requestId) throw new TemplateRequestError(409, 'Portable receipt identity does not match')
                const deleted = operation === 'delete' ? await reconcilePortableDelete(deps.dataRoot, requestId) : null
                if (deleted) {
                    return desktopPortableReceiptSchema.parse({
                        requestId,
                        receiptId: requestId,
                        operation: 'delete',
                        status: deleted.status,
                        templateId: 'templateId' in deleted ? deleted.templateId : null,
                        revision: 'revision' in deleted ? deleted.revision : null,
                        artifactId: null,
                        recoverable: deleted.status === 'uncertain',
                    })
                }
                const acknowledged = operation === 'export'
                    ? row.phase === 'published' && typeof row.artifactId === 'string' && typeof row.contentDigest === 'string' && typeof row.bytes === 'number' && typeof row.fileName === 'string'
                    : row.phase === 'published' && typeof row.templateId === 'string' && typeof row.revision === 'string' && row.provenance != null && row.fidelity != null
                return desktopPortableReceiptSchema.parse({
                    requestId,
                    receiptId: requestId,
                    operation,
                    status: acknowledged ? 'acknowledged' : 'uncertain',
                    templateId: typeof row.templateId === 'string' ? row.templateId : null,
                    revision: typeof row.revision === 'string' ? row.revision : null,
                    artifactId: typeof row.artifactId === 'string' ? row.artifactId : null,
                    recoverable: !acknowledged,
                })
            }
            throw new TemplateRequestError(404, 'Portable template receipt not found')
        },
    }
}

export type DesktopPortableTemplateService = ReturnType<typeof createDesktopPortableTemplateService>

export const portableRouteFragments = {
    allow: [
        { method: 'POST', path: '/desktop/templates/export' },
        { method: 'POST', path: '/desktop/templates/import-package' },
        { method: 'POST', path: '/desktop/templates/delete' },
        { method: 'GET', path: '/desktop/templates/portable-receipt/:requestId' },
    ],
} as const
