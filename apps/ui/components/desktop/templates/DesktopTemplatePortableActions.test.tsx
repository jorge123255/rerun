import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DesktopTemplatePortableActions } from './DesktopTemplatePortableActions'

const template = {
    templateId: 'a'.repeat(32),
    revision: 'b'.repeat(64),
    title: 'Demo template',
    tagline: '',
    category: 'other' as const,
    updatedAt: '2026-11-05T00:00:00.000Z',
    agents: [],
    description: 'warning',
    capturedAt: '2026-11-05T00:00:00.000Z',
    exclusions: [],
    unsupportedEntries: [],
    portable: {
        binaryAssets: false,
        userSkillTrees: true,
        sourceKind: 'local-v1' as const,
        notes: ['Existing text-only local captures are not advertised as full portable fidelity.'],
    },
}

describe('DesktopTemplatePortableActions', () => {
    test('names delete effect and keeps export/import affordances', () => {
        const actions = {
            exportTemplate: vi.fn(),
            importPackage: vi.fn(),
            deleteTemplate: vi.fn(),
        }
        render(<DesktopTemplatePortableActions
            template={template}
            actions={actions}
            onLibraryChanged={() => undefined}
            onPickImport={async () => null}
        />)
        expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Import' })).toBeTruthy()
        expect(screen.getByText(/not advertised as full portable fidelity/i)).toBeTruthy()
    })
})
