import { describe, expect, test } from 'vitest'
import {
    DESKTOP_PORTABLE_TEMPLATE_FORMAT,
    DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION,
    desktopPortableOperationSchema,
    desktopPortablePackageManifestSchema,
} from '@rerun/contracts'

describe('portable template client contracts', () => {
    test('operations stay fingerprinted and package-local', () => {
        const exportOp = desktopPortableOperationSchema.parse({
            operation: 'export',
            requestId: '11111111-1111-4111-8111-111111111111',
            templateId: 'a'.repeat(32),
            revision: 'b'.repeat(64),
        })
        expect(exportOp.operation).toBe('export')
        const imported = desktopPortableOperationSchema.parse({
            operation: 'import-package',
            requestId: '22222222-2222-4222-8222-222222222222',
            uploadId: '33333333-3333-4333-8333-333333333333',
        })
        expect(imported.operation).toBe('import-package')
        expect(() => desktopPortablePackageManifestSchema.parse({
            format: DESKTOP_PORTABLE_TEMPLATE_FORMAT,
            formatVersion: DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION,
            packageKey: 'c'.repeat(32),
            title: 'x',
            capturedAt: '2026-11-05T00:00:00.000Z',
            proseWarning: 'Selected instructions, files, skills and binary assets are copied as written. Binary files are not text-scanned for secrets.',
            limits: {
                maxCoworkers: 12,
                maxFiles: 2000,
                maxFileBytes: 25 * 1024 * 1024,
                maxTotalBytes: 150 * 1024 * 1024,
                maxCompressedBytes: 160 * 1024 * 1024,
                maxMembers: 4000,
                maxTitleLength: 80,
                maxElapsedMs: 120_000,
                maxWalkEntries: 4000,
            },
            contentDigest: 'd'.repeat(64),
            coworkers: [],
            fidelity: { binaryAssets: true, userSkillTrees: true, sourceKind: 'portable-capture', notes: [] },
            excludedCategories: [],
        })).toThrow()
    })
})
