// @vitest-environment happy-dom
// Source-only regressions; the integration owner runs validation.
import { act, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DESKTOP_WORKSPACE_ICONS, desktopWorkspaceIconSelectionUrl } from '@/lib/desktop/icon-catalog'
import { cancelDraftShutdown, flushDesktopDrafts } from '@/lib/desktop/draft-writes'
import { DesktopWorkspaceSettings } from './DesktopWorkspaceSettings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Preserve the original choose/drop surface while retaining its callback for late chooser events.
const dropzone = vi.hoisted(() => ({ files: undefined as ((files: File[]) => void) | undefined }))
vi.mock('@rerun/ui/forms', async importOriginal => {
    const actual = await importOriginal<typeof import('@rerun/ui/forms')>()
    return {
        ...actual,
        FileDropzone(props: ComponentProps<typeof actual.FileDropzone>) {
            dropzone.files = props.onFiles
            return <actual.FileDropzone {...props} />
        },
    }
})

const uploadId = '11111111-1111-4111-8111-111111111111'
const roots: Root[] = []
const settleRequests: (() => void)[] = []
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const nameField = () => document.querySelector<HTMLInputElement>('#workspace-settings-name')!
const choices = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] [aria-pressed]')]
const preview = () => document.querySelector<HTMLImageElement>('[role="dialog"] img[alt=""]')!
const button = (label: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === label)!
const click = async (target: HTMLElement) => { await act(async () => { target.click() }) }
const rename = async (value: string) => act(async () => {
    const input = nameField()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
})
const deferred = () => {
    let resolve!: (response: Response) => void
    const promise = new Promise<Response>(done => { resolve = done })
    settleRequests.push(() => resolve(Response.json({ error: 'Fixture closed' }, { status: 503 })))
    return { promise, resolve }
}

type FixtureState = { name: string; catalogId: string | null; uploadId?: string | null }
type PutInput = { name: string; catalogId?: string | null; uploadId?: string | null; file?: File }

function fixture(catalogId: string | null = null, initialUploadId?: string | null) {
    let saved: FixtureState = { name: 'Disposable', catalogId, ...(initialUploadId !== undefined ? { uploadId: initialUploadId } : {}) }
    let get: (() => Promise<Response> | Response) | undefined
    let put: ((input: PutInput) => Promise<Response> | Response) | undefined
    const calls: { method: string; body?: unknown; file?: File }[] = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe('/api/desktop/workspace/icon')
        const method = init?.method ?? 'GET'
        if (method === 'GET') {
            calls.push({ method, body: undefined })
            return get ? get() : Response.json(saved.uploadId
                ? { catalogId: null, uploadId: saved.uploadId }
                : { catalogId: saved.catalogId })
        }
        expect(method).toBe('PUT')
        // The illustration slice submits name and selection as one JSON payload; the upload slice
        // submits name and file as one multipart payload, exactly like the original form.
        if (init?.body instanceof FormData) {
            const file = init.body.get('logoFile')
            const input: PutInput = { name: String(init.body.get('name')), file: file instanceof File ? file : undefined }
            calls.push({ method, body: { name: input.name }, file: input.file })
            const savedResponse = put ? await put(input) : Response.json({ name: input.name, catalogId: null, uploadId })
            if (!put) saved = { name: input.name, catalogId: null, uploadId }
            return savedResponse
        }
        const body = JSON.parse(String(init?.body)) as { name: string; catalogId?: string | null }
        calls.push({ method, body })
        if (put) return put(body)
        // Mirrors the route: a committed catalog selection or reset replaces any uploaded icon.
        saved = {
            name: body.name,
            catalogId: Object.hasOwn(body, 'catalogId') ? body.catalogId ?? null : saved.catalogId,
            uploadId: Object.hasOwn(body, 'catalogId') ? null : saved.uploadId,
        }
        return Response.json(saved)
    })
    vi.stubGlobal('fetch', fetcher)
    return { calls, fetcher, setGet: (read: typeof get) => { get = read }, setPut: (write: typeof put) => { put = write }, get saved() { return saved } }
}

async function mount() {
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); roots.push(root)
    const saved = vi.fn()
    let control!: (open: boolean) => void
    function Harness() {
        const [open, setOpen] = useState(true)
        control = setOpen
        return <><button aria-label="Workspace menu, Disposable">Workspace</button><DesktopWorkspaceSettings open={open} onOpenChange={setOpen} workspaceName="Disposable" onSaved={saved} /></>
    }
    await act(async () => { root.render(<Harness />) })
    return { saved, setOpen: async (open: boolean) => { await act(async () => { control(open) }) } }
}

afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount(); for (const settle of settleRequests.splice(0)) settle(); cancelDraftShutdown() })
    document.body.innerHTML = ''; dropzone.files = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks()
})

test('keeps the original preview/name layout, ten illustrations and expandable full catalog', async () => {
    const f = fixture()
    await mount()
    expect(dialog()?.textContent).toContain('Workspace settings')
    expect(dialog()?.textContent).toContain('Or pick an illustration')
    expect(nameField().value).toBe('Disposable')
    expect(nameField().maxLength).toBe(60)
    expect(choices()).toHaveLength(10)
    expect(preview().getAttribute('src')).toBeNull()
    await click(button(`Show all ${DESKTOP_WORKSPACE_ICONS.length}`))
    expect(choices()).toHaveLength(50)
    await click(button('Show less'))
    expect(choices()).toHaveLength(10)
    expect(f.calls).toEqual([{ method: 'GET', body: undefined }])
})

test('one atomic Save persists trimmed name and picked catalog ID, publishes once and closes', async () => {
    const f = fixture(); const h = await mount()
    const pick = DESKTOP_WORKSPACE_ICONS[7]
    await click(choices()[7])
    expect(preview().getAttribute('src')).toBe(pick.url)
    expect(choices()[7].getAttribute('aria-pressed')).toBe('true')
    await rename(' Renamed workspace ')
    await click(button('Save'))
    expect(f.calls).toEqual([{ method: 'GET', body: undefined }, { method: 'PUT', body: { name: 'Renamed workspace', catalogId: pick.id } }])
    expect(h.saved).toHaveBeenCalledTimes(1)
    expect(h.saved).toHaveBeenCalledWith({ name: 'Renamed workspace', iconCatalogId: pick.id, iconUploadId: null })
    expect(dialog()).toBeNull()
})

test('name-only save omits the icon field and uses the authoritative preserved icon returned by PUT', async () => {
    const f = fixture(DESKTOP_WORKSPACE_ICONS[5].id); const h = await mount()
    expect(choices()[5].getAttribute('aria-pressed')).toBe('true')
    await rename('Just renamed')
    await click(button('Save'))
    expect(f.calls[1]).toEqual({ method: 'PUT', body: { name: 'Just renamed' } })
    expect(h.saved).toHaveBeenCalledTimes(1)
    expect(h.saved).toHaveBeenCalledWith({ name: 'Just renamed', iconCatalogId: DESKTOP_WORKSPACE_ICONS[5].id, iconUploadId: null })
    expect(f.saved.name).toBe('Just renamed')
})

test('a rejected atomic save reports no partial success and retains both edits for retry', async () => {
    const f = fixture(); f.setPut(() => Response.json({ error: 'Unknown icon' }, { status: 400 }))
    const h = await mount()
    await rename('Draft name'); await click(choices()[3]); await click(button('Save'))
    expect(dialog()?.textContent).toContain('Unknown icon')
    expect(h.saved).not.toHaveBeenCalled()
    expect(f.saved).toEqual({ name: 'Disposable', catalogId: null })
    expect(nameField().value).toBe('Draft name')
    expect(choices()[3].getAttribute('aria-pressed')).toBe('true')
    f.setPut(undefined)
    await click(button('Save'))
    expect(h.saved).toHaveBeenCalledTimes(1)
    expect(h.saved).toHaveBeenCalledWith({ name: 'Draft name', iconCatalogId: DESKTOP_WORKSPACE_ICONS[3].id, iconUploadId: null })
})

test('failed icon read offers Retry and permits name-only save that preserves the persisted icon', async () => {
    const f = fixture(DESKTOP_WORKSPACE_ICONS[2].id)
    f.setGet(() => Response.json({ error: 'unavailable' }, { status: 503 }))
    const h = await mount()
    expect(dialog()?.textContent).toContain('Could not load the workspace icon.')
    expect(button('Retry')).toBeTruthy()
    await rename('Still saved'); await click(button('Save'))
    expect(f.calls[1]).toEqual({ method: 'PUT', body: { name: 'Still saved' } })
    expect(h.saved).toHaveBeenCalledTimes(1)
    expect(h.saved).toHaveBeenCalledWith({ name: 'Still saved', iconCatalogId: DESKTOP_WORKSPACE_ICONS[2].id, iconUploadId: null })
})

test('Retry and a delayed initial read cannot overwrite a chosen illustration or typed name', async () => {
    const f = fixture(); const initial = deferred(); f.setGet(() => initial.promise)
    await mount()
    await rename('My choice'); await click(choices()[4])
    await act(async () => { initial.resolve(Response.json({ error: 'offline' }, { status: 503 })) })
    const retry = deferred(); f.setGet(() => retry.promise)
    await click(button('Retry'))
    await click(choices()[6])
    await act(async () => { retry.resolve(Response.json({ catalogId: DESKTOP_WORKSPACE_ICONS[1].id })) })
    expect(nameField().value).toBe('My choice')
    expect(preview().getAttribute('src')).toBe(DESKTOP_WORKSPACE_ICONS[6].url)
    expect(choices()[6].getAttribute('aria-pressed')).toBe('true')
    expect(dialog()?.textContent).not.toContain('Could not load the workspace icon.')
})

test('Save admits once, blocks Cancel/Escape/editing and holds the quit barrier until persistence settles', async () => {
    const f = fixture(); const pending = deferred(); f.setPut(() => pending.promise)
    const h = await mount()
    const form = dialog()!.querySelector('form')!
    await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1)
    expect(nameField().disabled).toBe(true); expect(button('Cancel').disabled).toBe(true)
    expect(choices().every(choice => choice.disabled)).toBe(true)
    await click(button('Cancel'))
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(dialog()).not.toBeNull()
    let quitSettled = false
    let quit!: Promise<boolean>
    await act(async () => { quit = flushDesktopDrafts().then(result => { quitSettled = true; return result }) })
    expect(quitSettled).toBe(false)
    await act(async () => { pending.resolve(Response.json({ name: 'Disposable', catalogId: null })); await quit })
    expect(quitSettled).toBe(true)
    expect(h.saved).toHaveBeenCalledTimes(1)
    expect(h.saved).toHaveBeenCalledWith({ name: 'Disposable', iconCatalogId: null, iconUploadId: null })
    expect(dialog()).toBeNull()
})

test('late save and GET from a forcibly closed form cannot change or close a reopened draft', async () => {
    const f = fixture(); const read = deferred(); const save = deferred()
    f.setGet(() => read.promise); f.setPut(() => save.promise)
    const h = await mount()
    await rename('Old name'); await click(button('Save'))
    await h.setOpen(false)
    f.setGet(() => Response.json({ catalogId: DESKTOP_WORKSPACE_ICONS[0].id }))
    await h.setOpen(true)
    await rename('New draft'); await click(choices()[8])
    await act(async () => {
        save.resolve(Response.json({ name: 'Old name', catalogId: null }))
        read.resolve(Response.json({ catalogId: DESKTOP_WORKSPACE_ICONS[3].id }))
    })
    expect(h.saved).not.toHaveBeenCalled()
    expect(dialog()).not.toBeNull()
    expect(nameField().value).toBe('New draft')
    expect(preview().getAttribute('src')).toBe(DESKTOP_WORKSPACE_ICONS[8].url)
    expect(button('Save').disabled).toBe(false)
})

test('Cancel performs no write and restores workspace-menu focus', async () => {
    const f = fixture(); const h = await mount()
    await click(choices()[2]); await rename('Not saved')
    await click(button('Cancel'))
    expect(dialog()).toBeNull(); expect(f.calls).toHaveLength(1); expect(h.saved).not.toHaveBeenCalled()
    // Radix releases its focus scope on a task after unmount.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Workspace menu, Disposable"]'))
})

test('shutdown blocks a new save even through a retained form submit handler', async () => {
    const f = fixture(); await mount()
    const form = dialog()!.querySelector('form')!
    await act(async () => { await flushDesktopDrafts() })
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(f.calls).toHaveLength(1)
    expect(button('Save').disabled).toBe(true)
    await act(async () => { cancelDraftShutdown() })
    expect(button('Save').disabled).toBe(false)
})

const chooseLogo = async (file: File) => act(async () => {
    const input = dialog()!.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
})

// happy-dom's object URLs are not stable across environments; the draft's own preview must be
// one fixed address whose revoke the test can observe.
function mockPreviewUrl() {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture-upload-preview')
    return 'blob:fixture-upload-preview'
}

test('choosing a file drafts the upload locally, and Save commits name and raster as one multipart payload', async () => {
    const f = fixture(); const h = await mount()
    const draftUrl = mockPreviewUrl()
    const logo = new File([new Uint8Array([8, 8, 8, 8])], 'logo.png', { type: 'image/png' })
    await chooseLogo(logo)
    expect(preview().getAttribute('src')).toBe(draftUrl)
    expect(choices().every(choice => choice.getAttribute('aria-pressed') !== 'true')).toBe(true)
    expect(f.calls).toHaveLength(1)
    await rename(' Uploaded studio ')
    await click(button('Save'))
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]!.method).toBe('PUT')
    expect(f.calls[1]!.file).toBe(logo)
    expect(f.calls[1]!.body).toEqual({ name: 'Uploaded studio' })
    expect(h.saved).toHaveBeenCalledTimes(1)
    expect(h.saved).toHaveBeenCalledWith({ name: 'Uploaded studio', iconCatalogId: null, iconUploadId: uploadId })
    expect(dialog()).toBeNull()
})

test('Cancel discards an upload draft, revokes its object URL and writes nothing', async () => {
    const f = fixture(); const h = await mount()
    const draftUrl = mockPreviewUrl()
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    await chooseLogo(new File([new Uint8Array([8, 8, 8, 8])], 'logo.webp', { type: 'image/webp' }))
    await click(button('Cancel'))
    expect(dialog()).toBeNull()
    expect(revoke).toHaveBeenCalledWith(draftUrl)
    expect(f.calls).toHaveLength(1)
    expect(h.saved).not.toHaveBeenCalled()
})

test('picking an illustration replaces an upload draft, revokes its object URL and saves through the catalog ID', async () => {
    const f = fixture(); await mount()
    const draftUrl = mockPreviewUrl()
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    await chooseLogo(new File([new Uint8Array([8, 8, 8, 8])], 'logo.png', { type: 'image/png' }))
    await click(choices()[2])
    expect(choices()[2].getAttribute('aria-pressed')).toBe('true')
    expect(preview().getAttribute('src')).toBe(DESKTOP_WORKSPACE_ICONS[2].url)
    expect(revoke).toHaveBeenCalledWith(draftUrl)
    await rename('Catalog choice')
    await click(button('Save'))
    expect(f.calls[1]!.body).toEqual({ name: 'Catalog choice', catalogId: DESKTOP_WORKSPACE_ICONS[2].id })
})

test('choosing a file replaces a picked illustration in the draft', async () => {
    const f = fixture(); await mount()
    const draftUrl = mockPreviewUrl()
    const logo = new File([new Uint8Array([8, 8, 8, 8])], 'logo.jpeg', { type: 'image/jpeg' })
    await click(choices()[1])
    expect(choices()[1].getAttribute('aria-pressed')).toBe('true')
    await chooseLogo(logo)
    expect(preview().getAttribute('src')).toBe(draftUrl)
    expect(choices().every(choice => choice.getAttribute('aria-pressed') !== 'true')).toBe(true)
    await click(button('Save'))
    expect(f.calls[1]!.file).toBe(logo)
    expect(f.calls[1]!.body).toEqual({ name: 'Disposable' })
})

test('a failed upload keeps the previous icon and retains the draft for retry', async () => {
    const f = fixture(); const h = await mount()
    const draftUrl = mockPreviewUrl()
    f.setPut(() => Response.json({ error: 'This image is damaged and can’t be used.' }, { status: 415 }))
    const logo = new File([new Uint8Array([8, 8, 8, 8])], 'logo.png', { type: 'image/png' })
    await chooseLogo(logo)
    await rename('Retry name')
    await click(button('Save'))
    expect(dialog()?.textContent).toContain('This image is damaged and can’t be used.')
    expect(h.saved).not.toHaveBeenCalled()
    expect(f.saved).toEqual({ name: 'Disposable', catalogId: null })
    expect(preview().getAttribute('src')).toBe(draftUrl)
    f.setPut(undefined)
    await click(button('Save'))
    expect(h.saved).toHaveBeenCalledTimes(1)
    expect(h.saved).toHaveBeenCalledWith({ name: 'Retry name', iconCatalogId: null, iconUploadId: uploadId })
    expect(dialog()).toBeNull()
})

test.each(['omitted', 'null'] as const)('catalog descriptors with %s upload identity remain compatible and publish both fields', async shape => {
    const catalogId = DESKTOP_WORKSPACE_ICONS[0].id
    const descriptor = { catalogId, ...(shape === 'null' ? { uploadId: null } : {}) }
    const f = fixture(catalogId)
    f.setGet(() => Response.json(descriptor))
    f.setPut(input => Response.json({ name: input.name, ...descriptor }))
    const h = await mount()
    expect(preview().getAttribute('src')).toBe(DESKTOP_WORKSPACE_ICONS[0].url)
    expect(dialog()?.textContent).not.toContain('Could not load')
    await rename('Renamed'); await click(button('Save'))
    expect(h.saved).toHaveBeenCalledWith({ name: 'Renamed', iconCatalogId: catalogId, iconUploadId: null })
    expect(dialog()).toBeNull()
})

test('name-only Save preserves an uploaded icon from the authoritative response and reloads it on reopening', async () => {
    const f = fixture(null, uploadId), h = await mount()
    const url = desktopWorkspaceIconSelectionUrl({ iconCatalogId: null, iconUploadId: uploadId })
    expect(preview().getAttribute('src')).toBe(url)
    expect(choices().every(choice => choice.getAttribute('aria-pressed') === 'false')).toBe(true)
    await rename('Same logo'); await click(button('Save'))
    expect(f.calls[1]).toEqual({ method: 'PUT', body: { name: 'Same logo' } })
    expect(h.saved).toHaveBeenCalledWith({ name: 'Same logo', iconCatalogId: null, iconUploadId: uploadId })
    await h.setOpen(true)
    expect(preview().getAttribute('src')).toBe(url)
})

test('replacing a saved upload with an illustration explicitly clears the published upload identity', async () => {
    const f = fixture(null, uploadId), h = await mount()
    await click(choices()[1]); await click(button('Save'))
    expect(f.calls[1]).toEqual({ method: 'PUT', body: { name: 'Disposable', catalogId: DESKTOP_WORKSPACE_ICONS[1].id } })
    expect(h.saved).toHaveBeenCalledWith({ name: 'Disposable', iconCatalogId: DESKTOP_WORKSPACE_ICONS[1].id, iconUploadId: null })
    await h.setOpen(true)
    expect(preview().getAttribute('src')).toBe(DESKTOP_WORKSPACE_ICONS[1].url)
})

test('replacing two upload drafts before a render releases both URLs when canceled', async () => {
    const f = fixture(); await mount()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const onFiles = dropzone.files!
    await act(async () => {
        onFiles([new File(['first'], 'first.png', { type: 'image/png' })])
        onFiles([new File(['second'], 'second.png', { type: 'image/png' })])
    })
    expect(create).toHaveBeenCalledTimes(2)
    expect(revoke.mock.calls).toEqual([['blob:first']])
    expect(preview().getAttribute('src')).toBe('blob:second')
    await click(button('Cancel'))
    expect(revoke.mock.calls).toEqual([['blob:first'], ['blob:second']])
    expect(f.calls).toHaveLength(1)
})

test('a late chooser callback from a closed form cannot allocate a URL or replace a reopened draft', async () => {
    const f = fixture(), h = await mount()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reopened')
    const oldOnFiles = dropzone.files!
    await h.setOpen(false); await h.setOpen(true)
    await click(choices()[2])
    await act(async () => { oldOnFiles([new File(['late'], 'late.png', { type: 'image/png' })]) })
    expect(create).not.toHaveBeenCalled()
    expect(preview().getAttribute('src')).toBe(DESKTOP_WORKSPACE_ICONS[2].url)
    expect(f.calls.filter(call => call.method === 'PUT')).toEqual([])
    await chooseLogo(new File(['current'], 'current.png', { type: 'image/png' }))
    expect(create).toHaveBeenCalledTimes(1)
    expect(preview().getAttribute('src')).toBe('blob:reopened')
})

test('a failed preview keeps the current selection and reports the file problem', async () => {
    const f = fixture(DESKTOP_WORKSPACE_ICONS[4].id); await mount()
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('No preview') })
    await chooseLogo(new File(['file'], 'logo.png', { type: 'image/png' }))
    expect(dialog()?.textContent).toContain('Could not preview this image. Try another file.')
    expect(preview().getAttribute('src')).toBe(DESKTOP_WORKSPACE_ICONS[4].url)
    expect(f.calls).toHaveLength(1)
})

test('saved icon URLs accept only local catalog members or a single valid uploaded identity', () => {
    const catalogId = DESKTOP_WORKSPACE_ICONS[0].id
    expect(desktopWorkspaceIconSelectionUrl({ iconCatalogId: catalogId })).toBe(DESKTOP_WORKSPACE_ICONS[0].url)
    expect(desktopWorkspaceIconSelectionUrl({ iconCatalogId: null, iconUploadId: uploadId })).toBe(`/api/desktop/workspace/icon/bytes?identity=${uploadId}`)
    expect(desktopWorkspaceIconSelectionUrl({ iconCatalogId: null })).toBeNull()
    expect(desktopWorkspaceIconSelectionUrl({ iconCatalogId: '../outside.png' })).toBeNull()
    expect(desktopWorkspaceIconSelectionUrl({ iconCatalogId: null, iconUploadId: '../outside.png' })).toBeNull()
    expect(desktopWorkspaceIconSelectionUrl({ iconCatalogId: catalogId, iconUploadId: uploadId })).toBeNull()
})

test.each([
    { catalogId: null, uploadId: '../outside.png' },
    { catalogId: DESKTOP_WORKSPACE_ICONS[0].id, uploadId },
])('an invalid saved descriptor is not published into the workspace surfaces', async descriptor => {
    const f = fixture(); f.setPut(input => Response.json({ name: input.name, ...descriptor }))
    const h = await mount()
    await click(button('Save'))
    expect(h.saved).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('Could not read the saved workspace settings.')
    expect(dialog()?.textContent).not.toContain('Zod')
})
