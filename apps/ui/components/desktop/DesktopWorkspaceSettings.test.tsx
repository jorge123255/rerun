// @vitest-environment happy-dom
// Authored for the workspace-icons lane; the integration owner runs all validation.
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DESKTOP_WORKSPACE_ICONS, type DesktopWorkspaceIcon } from '@/lib/desktop/icon-catalog'
import { DesktopWorkspaceSettings, type DesktopWorkspaceIconSaved } from './DesktopWorkspaceSettings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Call = { url: string; method: string; body?: unknown }
type Fixture = { catalogId: string | null; failLoad?: boolean; failPatch?: boolean; failPut?: boolean }

const dialog = () => document.querySelector('[role="dialog"]')
const nameField = () => document.querySelector<HTMLInputElement>('#workspace-settings-name')!
const choices = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] [aria-pressed]')]
const preview = () => document.querySelector<HTMLImageElement>('[role="dialog"] img[alt=""]')!
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })

const rename = async (value: string) => act(async () => {
    const input = nameField()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
})

function mount() {
    const container = document.createElement('div')
    document.body.append(container)
    return { container, root: createRoot(container) }
}

function Harness({ onSaved }: { onSaved: (saved: DesktopWorkspaceIconSaved) => void }) {
    const [open, setOpen] = useState(true)
    return <DesktopWorkspaceSettings open={open} onOpenChange={setOpen} workspaceName="Disposable" onSaved={onSaved} />
}

async function render(root: ReturnType<typeof createRoot>, fixture: Fixture, onCall: (call: Call) => void, onSaved: (saved: DesktopWorkspaceIconSaved) => void) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const call: Call = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
        onCall(call)
        if (url === '/api/desktop/workspace/icon' && call.method === 'GET') {
            if (fixture.failLoad) return Response.json({ error: 'unavailable' }, { status: 503 })
            return Response.json({ catalogId: fixture.catalogId }, { headers: { 'cache-control': 'no-store' } })
        }
        if (url === '/api/desktop/workspace/icon' && call.method === 'PUT') {
            if (fixture.failPut) return Response.json({ error: 'Unknown icon' }, { status: 400 })
            const body = call.body as { catalogId?: string } | null
            return Response.json({ catalogId: body?.catalogId ?? null })
        }
        if (url === '/api/desktop/settings' && call.method === 'PATCH') {
            if (fixture.failPatch) return Response.json({ error: 'Check the provider, model, or workspace name and try again.' }, { status: 400 })
            return Response.json({ connections: [], default: null })
        }
        throw new Error(`Unexpected request ${url}`)
    }))
    await act(async () => { root.render(<Harness onSaved={onSaved} />) })
}

const saveButton = async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent?.trim() === 'Save')
    expect(button, 'Save').toBeTruthy()
    await act(async () => { button!.click() })
}

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

test('the dialog carries the original layout: name beside the preview, ten illustrations and the expand toggle', async () => {
    const { root } = mount()
    const calls: Call[] = []
    await render(root, { catalogId: null }, call => calls.push(call), () => {})
    await settle()
    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain('Workspace settings')
    expect(dialog()!.textContent).toContain('Your workspace name and logo, as your team and your invitations see them.')
    expect(dialog()!.textContent).toContain('Or pick an illustration')
    expect(nameField().value).toBe('Disposable')
    expect(nameField().getAttribute('placeholder')).toBe('e.g. Acme Inc.')
    expect(choices()).toHaveLength(10)
    // Without a saved icon the preview stays an empty muted block, with no picked artwork.
    expect(preview().getAttribute('src')).toBeNull()
    const expand = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Show all'))
    expect(expand!.textContent).toBe(`Show all ${DESKTOP_WORKSPACE_ICONS.length}`)
    await act(async () => { expand!.click() })
    expect(choices()).toHaveLength(DESKTOP_WORKSPACE_ICONS.length)
    await act(async () => {
        const collapse = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Show less')!
        collapse.click()
    })
    expect(choices()).toHaveLength(10)
    expect(calls).toEqual([{ url: '/api/desktop/workspace/icon', method: 'GET', body: undefined }])
})

test('picking an illustration previews it, marks it selected, and Save writes the name and the validated catalog ID', async () => {
    const { root } = mount()
    const calls: Call[] = []
    const saved: DesktopWorkspaceIconSaved[] = []
    const pick: DesktopWorkspaceIcon = DESKTOP_WORKSPACE_ICONS[7]!
    await render(root, { catalogId: null }, call => calls.push(call), result => { saved.push(result) })
    await settle()
    await act(async () => { choices()[7]!.click() })
    expect(choices()[7]!.getAttribute('aria-pressed')).toBe('true')
    expect(preview().getAttribute('src')).toBe(pick.url)
    await rename(' Renamed workspace ')
    await saveButton()
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['PATCH /api/desktop/settings', 'PUT /api/desktop/workspace/icon'])
    expect(calls[0]!.body).toEqual({ action: 'workspace', name: 'Renamed workspace' })
    expect(calls[1]!.body).toEqual({ catalogId: pick.id })
    expect(saved).toEqual([{ name: 'Renamed workspace', iconCatalogId: pick.id }])
    expect(dialog()).toBeNull()
})

test('Save without a pick keeps the workspace icon untouched, and picking first saves it through the catalog ID', async () => {
    const { root } = mount()
    const calls: Call[] = []
    const saved: DesktopWorkspaceIconSaved[] = []
    await render(root, { catalogId: 'amber-fluid-blob.webp' }, call => calls.push(call), result => { saved.push(result) })
    await settle()
    // The saved illustration renders in the preview and shows as selected in the grid.
    expect(preview().getAttribute('src')).toBe('/workspace-icons/amber-fluid-blob.webp')
    const selected = choices().findIndex(button => button.getAttribute('aria-pressed') === 'true')
    expect(DESKTOP_WORKSPACE_ICONS[selected]!.id).toBe('amber-fluid-blob.webp')
    await rename('Just renamed')
    await saveButton()
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['PATCH /api/desktop/settings'])
    expect(saved).toEqual([{ name: 'Just renamed', iconCatalogId: 'amber-fluid-blob.webp' }])
    await act(async () => { root.unmount() })

    const second = mount()
    const secondCalls: Call[] = []
    const secondSaved: DesktopWorkspaceIconSaved[] = []
    try {
        await render(second.root, { catalogId: null }, call => secondCalls.push(call), result => { secondSaved.push(result) })
        await settle()
        await act(async () => { choices()[0]!.click() })
        await saveButton()
        expect(secondCalls.map(call => `${call.method} ${call.url}`)).toEqual(['PATCH /api/desktop/settings', 'PUT /api/desktop/workspace/icon'])
        expect(secondSaved).toEqual([{ name: 'Disposable', iconCatalogId: DESKTOP_WORKSPACE_ICONS[0]!.id }])
    } finally { await act(async () => { second.root.unmount() }) }
})

test('a rejected catalog ID surfaces the error, keeps the dialog open and reports nothing saved', async () => {
    const { root } = mount()
    const calls: Call[] = []
    const saved: DesktopWorkspaceIconSaved[] = []
    await render(root, { catalogId: null, failPut: true }, call => calls.push(call), result => { saved.push(result) })
    await settle()
    await act(async () => { choices()[3]!.click() })
    await saveButton()
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['PATCH /api/desktop/settings', 'PUT /api/desktop/workspace/icon'])
    expect(dialog()!.querySelector('.text-destructive')!.textContent).toContain('Unknown icon')
    // The name write landed before the icon failed, so the caller still learns the new name.
    expect(saved).toEqual([{ name: 'Disposable', iconCatalogId: null }])
    expect(choices()[3]!.getAttribute('aria-pressed')).toBe('true')
    expect(dialog()).not.toBeNull()
})

test('a failed name save blocks the icon write and keeps the dialog open with the error', async () => {
    const { root } = mount()
    const calls: Call[] = []
    const saved: DesktopWorkspaceIconSaved[] = []
    await render(root, { catalogId: null, failPatch: true }, call => calls.push(call), result => { saved.push(result) })
    await settle()
    await act(async () => { choices()[0]!.click() })
    await saveButton()
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['PATCH /api/desktop/settings'])
    expect(dialog()!.querySelector('.text-destructive')!.textContent).toContain('Check the provider, model, or workspace name and try again.')
    expect(saved).toEqual([])
})

test('an unavailable icon read surfaces its own error, and a save without a pick leaves the icon state unknown', async () => {
    const { root } = mount()
    const calls: Call[] = []
    const saved: DesktopWorkspaceIconSaved[] = []
    await render(root, { catalogId: null, failLoad: true }, call => calls.push(call), result => { saved.push(result) })
    await settle()
    expect(dialog()!.textContent).toContain('Could not load the workspace icon. Try again.')
    expect(preview().getAttribute('src')).toBeNull()
    await saveButton()
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['PATCH /api/desktop/settings'])
    expect(saved).toHaveLength(1)
    expect(saved[0]!.name).toBe('Disposable')
    expect(saved[0]!.iconCatalogId).toBeUndefined()
    expect(dialog()).toBeNull()
    // A picked illustration still saves despite the failed read.
    await act(async () => { root.unmount() })

    const second = mount()
    const secondCalls: Call[] = []
    const secondSaved: DesktopWorkspaceIconSaved[] = []
    try {
        await render(second.root, { catalogId: null, failLoad: true }, call => secondCalls.push(call), result => { secondSaved.push(result) })
        await settle()
        await act(async () => { choices()[5]!.click() })
        await saveButton()
        expect(secondCalls.map(call => `${call.method} ${call.url}`)).toEqual(['PATCH /api/desktop/settings', 'PUT /api/desktop/workspace/icon'])
        expect(secondSaved).toHaveLength(1)
        expect(secondSaved[0]!.iconCatalogId).toBe(DESKTOP_WORKSPACE_ICONS[5]!.id)
    } finally { await act(async () => { second.root.unmount() }) }
})

test('Cancel closes without saving a picked illustration', async () => {
    const { root } = mount()
    const calls: Call[] = []
    const saved: DesktopWorkspaceIconSaved[] = []
    await render(root, { catalogId: null }, call => calls.push(call), result => { saved.push(result) })
    await settle()
    await act(async () => { choices()[2]!.click() })
    expect(choices()[2]!.getAttribute('aria-pressed')).toBe('true')
    const cancel = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Cancel')!
    await act(async () => { cancel.click() })
    expect(dialog()).toBeNull()
    expect(calls).toEqual([{ url: '/api/desktop/workspace/icon', method: 'GET', body: undefined }])
    expect(saved).toEqual([])
})
