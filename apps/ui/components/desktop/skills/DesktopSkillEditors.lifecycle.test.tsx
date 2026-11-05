// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const api = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), get: vi.fn(), update: vi.fn(), quit: false }))
vi.mock('@/lib/desktop/coworker-skills', () => ({ readCoworkerSkillFile: api.read, writeCoworkerSkillFile: api.write, getCoworkerSkill: api.get, updateCoworkerSkill: api.update,
    deleteCoworkerSkillFile: vi.fn(), deleteCoworkerSkill: vi.fn(), downloadCoworkerSkillArchive: vi.fn(), createCoworkerSkill: vi.fn() }))
vi.mock('@/lib/desktop/draft-writes', () => ({ isDesktopQuitting: () => api.quit }))
vi.mock('@/components/ui/panel-steps', () => ({ PanelSteps: ({ children }: { children: ReactNode }) => <>{children}</> }))
import { DesktopSkillFileEditor } from './DesktopSkillFileEditor'
import { DesktopSkillEditor } from './DesktopSkillEditor'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
let root: ReturnType<typeof createRoot>, container: HTMLDivElement
const findButton = (text: string) => [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === text || button.getAttribute('aria-label') === text)
beforeEach(() => {
    vi.clearAllMocks(); api.quit = false
    api.read.mockImplementation(async (_owner: string, _slug: string, path: string) => ({ content: `Saved ${path}`, truncated: false, identity: `version-${path}` }))
    api.get.mockResolvedValue({ slug: 'review', name: 'Review', description: 'Review notes', body: 'Read the saved notes.', files: [], fromConnector: false, identity: 'manifest-version' })
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

test('bundled-file saves carry the read identity and a late old-file success cannot leave the new editor', async () => {
    const first = deferred<{ success: boolean }>(), current = deferred<{ success: boolean }>(), onBack = vi.fn()
    api.write.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => current.promise)
    const render = (path: string) => act(async () => { root.render(<DesktopSkillFileEditor agentId="alice" slug="review" path={path} onBack={onBack} />) })
    await render('references/a.md')
    await act(async () => { findButton('Save changes')!.click(); findButton('Save changes')!.click() })
    expect(api.write).toHaveBeenCalledExactlyOnceWith('alice', 'review', 'references/a.md', 'Saved references/a.md', { baseIdentity: 'version-references/a.md', completeRead: true })
    expect(findButton('Back')).toBeUndefined()
    await render('references/b.md')
    expect(findButton('Save changes')?.disabled).toBe(false)
    await act(async () => { findButton('Save changes')!.click() })
    await act(async () => { first.resolve({ success: true }) })
    expect(onBack).not.toHaveBeenCalled()
    expect(findButton('Save changes')?.disabled).toBe(true)
    await act(async () => { current.resolve({ success: true }) })
    expect(onBack).toHaveBeenCalledOnce()
})

test.each(['truncated', 'missing-version'] as const)('a %s file cannot submit an overwrite', async reason => {
    api.read.mockResolvedValue({ content: 'Incomplete or unversioned file', truncated: reason === 'truncated', ...(reason === 'truncated' && { identity: 'partial-version' }) })
    await act(async () => { root.render(<DesktopSkillFileEditor agentId="alice" slug="review" path="references/checklist.md" onBack={() => {}} />) })
    expect(findButton('Save changes')?.disabled).toBe(true)
    await act(async () => { findButton('Save changes')!.click() })
    expect(api.write).not.toHaveBeenCalled()
})

test('manifest saves preserve the exact read version and an old owner completion cannot close the current editor', async () => {
    const old = deferred<{ success: boolean }>(), onDone = vi.fn(), onBack = vi.fn()
    api.update.mockImplementationOnce(() => old.promise)
    const render = (agentId: string) => act(async () => { root.render(<DesktopSkillEditor agentId={agentId} slug="review" onDone={onDone} onBack={onBack} />) })
    await render('alice')
    await act(async () => { findButton('Save changes')!.click() })
    expect(api.update).toHaveBeenCalledExactlyOnceWith('alice', 'review', { description: 'Review notes', body: 'Read the saved notes.', baseIdentity: 'manifest-version' })
    expect(findButton('Back')).toBeUndefined()
    await render('bob')
    await act(async () => { old.resolve({ success: true }) })
    expect(onDone).not.toHaveBeenCalled()
    expect(findButton('Save changes')?.disabled).toBe(false)
    await act(async () => { api.quit = true; findButton('Save changes')!.click() })
    expect(api.update).toHaveBeenCalledTimes(1)
})
