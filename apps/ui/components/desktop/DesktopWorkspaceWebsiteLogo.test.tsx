// @vitest-environment happy-dom
// Source-only regressions; the integration owner runs validation.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { NO_LOGO_FOUND } from '@/lib/desktop/workspace-logo-link'
import { DesktopWorkspaceWebsiteLogo, type DesktopWorkspaceLinkSelection } from './DesktopWorkspaceWebsiteLogo'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// happy-dom's Response does not implement blob(), so the fixture fakes the members the component
// reads: ok/status, json() and blob().
type FakeResponse = { ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; blob(): Promise<Blob> }
const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })
const fake = (overrides: Partial<FakeResponse> = {}): FakeResponse => ({
    ok: true, status: 200, headers: { get: () => null }, json: async () => null, blob: async () => png(), ...overrides,
})

type Pending = { link: string; signal: AbortSignal; resolve: (response: FakeResponse) => void; promise: Promise<FakeResponse> }
let pending: Pending[] = []
let blobUrls: string[] = []
let revoked: string[] = []
const roots: Root[] = []

function fetcher(_url: string, init?: RequestInit) {
    const link = String((JSON.parse(String(init?.body)) as { link: string }).link)
    let resolve!: (response: FakeResponse) => void
    const promise = new Promise<FakeResponse>(done => { resolve = done })
    pending.push({ link, signal: init!.signal!, resolve, promise })
    return promise
}

async function mount() {
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); roots.push(root)
    let selection: DesktopWorkspaceLinkSelection | null = null
    let checking = false
    await act(async () => {
        root.render(<DesktopWorkspaceWebsiteLogo onSelection={(value, active) => { selection = value; checking = active }} />)
    })
    return {
        container,
        selection: () => selection,
        checking: () => checking,
        linkField: () => document.querySelector<HTMLInputElement>('input[placeholder="acme.com"]')!,
        preview: () => document.querySelector<HTMLImageElement>('img[alt=""]'),
        error: () => document.querySelector<HTMLElement>('p.text-destructive')?.textContent ?? null,
        setSelection: (value: DesktopWorkspaceLinkSelection | null) => { selection = value },
    }
}

const type = async (field: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
})
const settle = async (index: number, response: FakeResponse) => { await act(async () => { pending[index]!.resolve(response) }) }

beforeEach(() => {
    pending = []; blobUrls = []; revoked = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
        const url = `blob:preview-${blobUrls.length}`
        blobUrls.push(url)
        return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => { revoked.push(url) })
    vi.stubGlobal('fetch', fetcher)
})
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

test('posts a site link and reports the reviewed blob as a named File with a local preview URL', async () => {
    const h = await mount()
    await type(h.linkField(), 'acme.com')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.link).toBe('acme.com')
    await settle(0, fake())
    const selection = h.selection()
    expect(selection).not.toBeNull()
    expect(selection!.file.name).toBe('logo.png')
    expect(selection!.file.type).toBe('image/png')
    expect(selection!.previewUrl).toBe('blob:preview-0')
    expect(h.preview()?.getAttribute('src')).toBe('blob:preview-0')
    expect(h.error()).toBeNull()
})

test('posts the normalized domain for a full site URL', async () => {
    const h = await mount()
    await type(h.linkField(), 'https://www.acme.com/pricing')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.link).toBe('acme.com')
})

test('a newer keystroke supersedes the older request and revokes its preview URL', async () => {
    const h = await mount()
    await type(h.linkField(), 'acme.com')
    await settle(0, fake())
    expect(h.preview()?.getAttribute('src')).toBe('blob:preview-0')
    await type(h.linkField(), 'acme.co.uk')
    expect(h.selection()).toBeNull()
    expect(h.checking()).toBe(true)
    expect(revoked).toEqual(['blob:preview-0'])
    expect(pending).toHaveLength(2)
    expect(pending[1]!.link).toBe('acme.co.uk')
    await type(h.linkField(), 'latest.example')
    expect(pending[1]!.signal.aborted).toBe(true)
    await settle(2, fake())
    expect(h.selection()!.file.name).toBe('logo.png')
    expect(h.preview()?.getAttribute('src')).toBe('blob:preview-1')
    expect(revoked).toEqual(['blob:preview-0'])
    // The aborted first request must not replace the newer selection when it lands late.
    await settle(1, fake())
    expect(h.selection()!.previewUrl).toBe('blob:preview-1')
    expect(h.preview()?.getAttribute('src')).toBe('blob:preview-1')
    expect(revoked).toEqual(['blob:preview-0'])
    expect(h.checking()).toBe(false)
})

test('invalid response bytes cannot become a named logo selection', async () => {
    const h = await mount()
    await type(h.linkField(), 'acme.com')
    await settle(0, fake({ blob: async () => new Blob(['<html>wrong response</html>'], { type: 'text/html' }) }))
    expect(h.selection()).toBeNull()
    expect(h.checking()).toBe(false)
    expect(blobUrls).toEqual([])
    expect(h.error()).toContain(NO_LOGO_FOUND)
})

test('a failed preview reports null and a clear error', async () => {
    const h = await mount()
    await type(h.linkField(), 'acme.com')
    await settle(0, fake({ ok: false, status: 404, json: async () => ({ error: NO_LOGO_FOUND }) }))
    expect(h.selection()).toBeNull()
    expect(h.preview()).toBeNull()
    expect(h.error()).toContain('No logo found at this address')
})

test('clearing the field cancels the preview and reports null', async () => {
    const h = await mount()
    await type(h.linkField(), 'acme.com')
    await settle(0, fake())
    expect(h.selection()).not.toBeNull()
    await type(h.linkField(), '')
    expect(h.selection()).toBeNull()
    expect(h.preview()).toBeNull()
    expect(pending).toHaveLength(1)
    expect(revoked).toEqual(['blob:preview-0'])
})

test('unmount aborts an in-flight preview; a late result cannot select', async () => {
    const h = await mount()
    await type(h.linkField(), 'acme.com')
    const first = pending[0]!
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    await act(async () => { first.resolve(fake()) })
    expect(h.selection()).toBeNull()
    expect(h.preview()).toBeNull()
    expect(revoked).toEqual([])
})

test('unmount releases the shown preview URL', async () => {
    const h = await mount()
    await type(h.linkField(), 'acme.com')
    await settle(0, fake())
    expect(h.preview()?.getAttribute('src')).toBe('blob:preview-0')
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    expect(revoked).toEqual(['blob:preview-0'])
})

test('an in-flight preview cannot land once the form is disabled for saving', async () => {
    const h = await mount()
    await type(h.linkField(), 'acme.com')
    const first = pending[0]!
    await act(async () => {
        roots[0]!.render(<DesktopWorkspaceWebsiteLogo disabled={true} onSelection={value => { h.setSelection(value) }} />)
    })
    await act(async () => { first.resolve(fake()) })
    expect(h.selection()).toBeNull()
    expect(h.preview()).toBeNull()
    expect(revoked).toEqual([])
})
