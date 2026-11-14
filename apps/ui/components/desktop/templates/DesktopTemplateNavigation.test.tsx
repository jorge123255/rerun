// @vitest-environment happy-dom
import { act, StrictMode, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const local = vi.hoisted(() => ({ list: vi.fn(), sources: vi.fn(), detail: vi.fn(), createDraft: vi.fn(), dispose: vi.fn() }))
const factory = vi.hoisted(() => ({ create: vi.fn() }))
const portable = vi.hoisted(() => ({ pendingImport: vi.fn(), importPackage: vi.fn(), exportTemplate: vi.fn(), deleteTemplate: vi.fn(), dispose: vi.fn() }))
vi.mock('@/lib/desktop/portable-template-client', () => ({ createDesktopPortableTemplatesClient: () => portable }))
vi.mock('@/lib/desktop/templates-client', () => ({
    createDesktopTemplatesClient: () => factory.create(),
    DesktopTemplateRequestError: class extends Error { constructor(message: string, readonly definite: boolean) { super(message) } },
}))
vi.mock('motion/react', async original => {
    const actual = await original<typeof import('motion/react')>()
    const { createElement, forwardRef } = await import('react')
    const plain = (tag: string) => forwardRef<HTMLElement, Record<string, unknown>>(({ children, ...props }, ref) =>
        createElement(tag, { ...Object.fromEntries(Object.entries(props).filter(([name]) => !actual.isValidMotionProp(name))), ref }, children as ReactNode))
    const elements = new Map<string, ReturnType<typeof plain>>()
    const element = (tag: string) => { if (!elements.has(tag)) elements.set(tag, plain(tag)); return elements.get(tag)! }
    return { ...actual, AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>, motion: new Proxy(actual.motion, { get(target, key, receiver) {
        if (key === 'create') return (tag: unknown) => typeof tag === 'string' ? element(tag) : tag
        return typeof key === 'string' && key !== 'then' ? element(key) : Reflect.get(target, key, receiver)
    } }) }
})
import { loadMessages } from '@rerun/i18n/messages'
import { desktopMessages } from '@/lib/desktop/locale'
import { DesktopLocale } from '../DesktopLocale'
import { DesktopTemplateNavigation } from './DesktopTemplateNavigation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
beforeEach(() => { factory.create.mockReturnValue(local) })
afterEach(() => {
    if (root) act(() => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    for (const mock of Object.values(local)) mock.mockReset()
    factory.create.mockReset()
    for (const mock of Object.values(portable)) mock.mockReset()
    vi.restoreAllMocks()
    delete (window as Window & { desktopApp?: unknown }).desktopApp
})
const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)!

it('Import from the mounted library recovers the server attempt without reopening the Mac picker', async () => {
    const pending = { operation: 'import-package', requestId: '11111111-1111-4111-8111-111111111111', uploadId: '22222222-2222-4222-8222-222222222222' }
    const pickImport = vi.fn()
    ;(window as Window & { desktopApp?: unknown }).desktopApp = { templates: { pickImport, saveArtifact: vi.fn() } }
    local.list.mockResolvedValue([])
    portable.pendingImport.mockResolvedValue(pending)
    portable.importPackage.mockResolvedValue({ status: 'uncertain', requestId: pending.requestId, receiptId: pending.requestId, recoverable: true, reason: 'Recover this import' })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopTemplateNavigation open onOpenChange={() => {}} onCreateFromScratch={() => {}} onInstalled={() => {}} />))
    await act(async () => button('Import package').click())
    expect(portable.pendingImport).toHaveBeenCalledOnce()
    expect(pickImport).not.toHaveBeenCalled()
    expect(portable.importPackage).toHaveBeenCalledExactlyOnceWith({ requestId: pending.requestId, uploadId: pending.uploadId })
    expect(document.body.textContent).toContain('Recover this import')
})

it('does no library or capture reads while closed, then loads only the explicitly opened step', async () => {
    const onActiveChange = vi.fn()
    local.list.mockResolvedValue([])
    local.sources.mockResolvedValue([])
    local.createDraft.mockResolvedValue({ templateId: 'a'.repeat(32), revision: 'b'.repeat(64), title: 'Local template' })
    function Harness() {
        const [open, setOpen] = useState(false)
        return <><button onClick={() => setOpen(true)}>Open library</button><DesktopTemplateNavigation open={open} onOpenChange={setOpen} onActiveChange={onActiveChange} onCreateFromScratch={() => {}} onInstalled={() => {}} /></>
    }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Harness />))
    expect(local.list).not.toHaveBeenCalled()
    expect(local.sources).not.toHaveBeenCalled()
    expect(local.detail).not.toHaveBeenCalled()
    expect(onActiveChange).toHaveBeenLastCalledWith(false)
    await act(async () => button('Open library').click())
    expect(local.list).toHaveBeenCalledOnce()
    expect(local.sources).not.toHaveBeenCalled()
    expect(onActiveChange).toHaveBeenLastCalledWith(true)
    await act(async () => button('New template').click())
    expect(local.sources).not.toHaveBeenCalled()
    expect(onActiveChange).toHaveBeenLastCalledWith(true)
    const input = document.querySelector<HTMLInputElement>('input[placeholder="e.g. Research team"]')!
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Local template')
        input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Continue').click())
    expect(local.createDraft).toHaveBeenCalledExactlyOnceWith('Local template')
    expect(local.sources).toHaveBeenCalledOnce()
})

it('searches every private category with canonical Unicode and follows the workspace language', async () => {
    const research = { templateId: 'research', revision: 'r1', title: 'E\u0301quipe de recherche', tagline: '', category: 'productivity', agents: [] }
    const sales = { templateId: 'sales', revision: 'r2', title: 'Suivi commercial', tagline: '', category: 'sales', agents: [] }
    local.list.mockResolvedValue([research, sales])
    const language = { locale: 'fr' as const, preference: 'fr' as const, messages: desktopMessages('fr', await loadMessages('fr')) }
    const copy = language.messages.templateLibrary
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopLocale initial={language}>
        <DesktopTemplateNavigation open onOpenChange={() => {}} onCreateFromScratch={() => {}} onInstalled={() => {}} />
    </DesktopLocale>))
    const salesCategory = [...document.querySelectorAll<HTMLButtonElement>('nav button')].find(item => item.textContent?.startsWith(copy.categories.sales))!
    await act(async () => salesCategory.click())
    expect(document.body.textContent).not.toContain(research.title)
    const searches = document.querySelectorAll<HTMLInputElement>(`input[aria-label="${copy.search.placeholder}"]`)
    expect(searches).toHaveLength(2)
    const [hidden, field] = [...searches]
    vi.spyOn(hidden, 'getClientRects').mockReturnValue({ length: 0 } as DOMRectList)
    vi.spyOn(field, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList)
    const focusHidden = vi.spyOn(hidden, 'focus')
    const slash = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
    await act(async () => { salesCategory.dispatchEvent(slash) })
    expect(slash.defaultPrevented).toBe(true)
    expect(focusHidden).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(field)
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Équipe')
        field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.textContent).toContain(research.title)
    expect(document.body.textContent).not.toContain(sales.title)
    const clear = field.parentElement!.querySelector<HTMLButtonElement>(`button[aria-label="${copy.search.clear}"]`)!
    await act(async () => clear.click())
    expect(document.activeElement).toBe(field)
    expect(document.body.textContent).toContain(sales.title)
    expect(document.body.textContent).not.toContain(research.title)
})

it('creates a fresh live client after StrictMode effect cleanup', async () => {
    const instances: { closed: boolean; list: ReturnType<typeof vi.fn> }[] = []
    factory.create.mockImplementation(() => {
        const instance = { closed: false, list: vi.fn() }
        instance.list.mockImplementation(async () => {
            if (instance.closed) throw new Error('Disposed client was reused')
            return []
        })
        instances.push(instance)
        return { ...local, list: instance.list, dispose: () => { instance.closed = true } }
    })
    function Harness() {
        const [open, setOpen] = useState(false)
        return <><button onClick={() => setOpen(true)}>Open library</button><DesktopTemplateNavigation open={open} onOpenChange={setOpen} onCreateFromScratch={() => {}} onInstalled={() => {}} /></>
    }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<StrictMode><Harness /></StrictMode>))
    expect(instances.length).toBeGreaterThanOrEqual(2)
    expect(instances[0].closed).toBe(true)
    expect(instances.at(-1)!.closed).toBe(false)
    await act(async () => button('Open library').click())
    expect(instances.at(-1)!.list).toHaveBeenCalled()
    expect(instances.filter(instance => instance.closed).every(instance => instance.list.mock.calls.length === 0)).toBe(true)
    expect(document.body.textContent).not.toContain('Disposed client was reused')
})
