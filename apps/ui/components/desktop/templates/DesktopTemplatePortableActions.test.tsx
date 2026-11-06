// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopPortableTemplateActions } from '@/lib/desktop/portable-template-actions'
import { DesktopTemplatePortableActions } from './DesktopTemplatePortableActions'

const template = {
    templateId: 'a'.repeat(32), revision: 'b'.repeat(64), title: 'Demo template', tagline: '', category: 'other' as const,
    updatedAt: '2026-11-05T00:00:00.000Z', agents: [], description: 'warning', capturedAt: '2026-11-05T00:00:00.000Z',
    exclusions: [], unsupportedEntries: [], portable: { binaryAssets: false, userSkillTrees: true, sourceKind: 'local-v1' as const,
        notes: ['Existing text-only local captures are not advertised as full portable fidelity.'] },
}
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.replaceChildren()
})
async function mount(actions: DesktopPortableTemplateActions, pick = vi.fn(async () => ({ uploadId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222' })), save?: (artifactId: string) => Promise<{ saved: boolean }>) {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopTemplatePortableActions template={template} actions={actions} onLibraryChanged={() => undefined} onPickImport={pick} onSaveExport={save} />))
    return pick
}
function button(label: string) {
    const result = [...document.querySelectorAll('button')].find(item => item.textContent === label)
    if (!result) throw new Error(`Missing button ${label}`)
    return result
}
function actions() {
    return {
        exportTemplate: vi.fn<DesktopPortableTemplateActions['exportTemplate']>(async () => ({ ok: false, uncertain: true, error: 'Connection interrupted' })),
        importPackage: vi.fn<DesktopPortableTemplateActions['importPackage']>(async () => ({ ok: false, uncertain: true, error: 'Connection interrupted' })),
        deleteTemplate: vi.fn<DesktopPortableTemplateActions['deleteTemplate']>(async () => ({ ok: false, uncertain: true, error: 'Connection interrupted' })),
    }
}
test('keeps export/import affordances and honest local capture fidelity', async () => {
    await mount(actions())
    expect(button('Export')).toBeTruthy()
    expect(button('Import')).toBeTruthy()
    expect(document.body.textContent).toContain('not advertised as full portable fidelity')
})
test('an unknown export retries its attempt while the panel stays open', async () => {
    const api = actions()
    await mount(api)
    await act(async () => button('Export').click())
    const first = api.exportTemplate.mock.calls[0]![0]
    expect(first.requestId).toMatch(/^[a-f0-9-]{36}$/)
    await act(async () => button('Export').click())
    expect(api.exportTemplate.mock.calls[1]![0]).toEqual(first)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Connection interrupted')
})
test('a recreated panel obtains the server-owned import identity from the picker bridge', async () => {
    const api = actions()
    const pick = await mount(api)
    await act(async () => button('Import').click())
    const first = api.importPackage.mock.calls[0]![0]
    await act(async () => root!.unmount())
    document.body.replaceChildren()
    await mount(api, pick)
    await act(async () => button('Import').click())
    expect(pick).toHaveBeenCalledTimes(2)
    expect(api.importPackage.mock.calls[1]![0]).toEqual(first)
})

test('a completed export opens the native save action with only its opaque artifact identity', async () => {
    const api = actions(), save = vi.fn(async () => ({ saved: false }))
    api.exportTemplate.mockImplementation(async input => ({ ok: true, result: {
        status: 'exported', requestId: input.requestId!, receiptId: input.requestId!, templateId: input.templateId, revision: input.revision,
        artifactId: 'c'.repeat(32), contentDigest: 'd'.repeat(64), bytes: 50, fileName: 'Team.tar.gz',
        fidelity: { binaryAssets: true, userSkillTrees: true, sourceKind: 'portable-capture', notes: [] },
    } }))
    await mount(api, undefined, save)
    await act(async () => button('Export').click())
    expect(save).toHaveBeenCalledExactlyOnceWith('c'.repeat(32))
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Choose Export to save')
})
