// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopCoworkerPatch, DesktopCoworkerSettings as Settings } from '@/lib/desktop/coworker-settings'
import { DesktopLocale } from './DesktopLocale'
import { desktopMessages, desktopTranslator, englishDesktopLanguage, type DesktopLanguage } from '@/lib/desktop/locale'
import { loadMessages } from '@rerun/i18n/messages'
import { DesktopCoworkerSettings } from './DesktopCoworkerSettings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const coworker = { id: 'archivist', name: 'Archivist', description: '', createdAt: '', updatedAt: '' }
let root: Root
const settings: Settings = { soul: 'Check facts.', verbosity: 'normal', soulEditable: true, suggestedReplies: true, workspaceReadEnabled: false, memoryEnabled: true, autoMemory: true, selfImprovementEnabled: true }
const button = (text: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === text)!
const toggle = (id: string) => document.querySelector<HTMLButtonElement>(`[role="switch"]#${id}`)!
const click = (element: HTMLElement) => act(async () => { element.click() })

async function mount(initial: Settings, failFirstSave = false, language: DesktopLanguage = englishDesktopLanguage) {
    let saved = initial
    const patches: DesktopCoworkerPatch[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        expect(url).toBe('/api/desktop/agents/archivist/settings')
        if (init.method === 'PATCH') {
            const patch = JSON.parse(String(init.body))
            patches.push(patch)
            if (failFirstSave && patches.length === 1) return Response.json({ error: 'Try again.' }, { status: 503 })
            saved = { ...saved, ...patch }
        }
        return Response.json(saved)
    })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => { root.render(<DesktopLocale initial={language}><DesktopCoworkerSettings agent={coworker} disabled={false} /></DesktopLocale>) })
    await click(button(desktopTranslator(language)('coworker.edit')))
    return patches
}

afterEach(async () => {
    await act(async () => { root.unmount() })
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
})

test('pausing recall preserves the learning preference through save, reopen and cancelled edits', async () => {
    const patches = await mount(settings)
    const memory = () => toggle('coworker-memory-enabled')
    const learning = () => toggle('coworker-auto-memory')
    expect(document.querySelector('label[for="coworker-memory-enabled"]')?.textContent).toBe('Use saved memories in chat')
    expect(document.querySelector('label[for="coworker-auto-memory"]')?.textContent).toBe('Learn from replies')
    await click(memory())
    expect(learning().disabled).toBe(true)
    expect(learning().getAttribute('aria-checked')).toBe('false')
    expect(learning().getAttribute('aria-description')).toContain('Turn on saved memories')
    await click(button('Save changes'))
    expect(patches).toEqual([{ memoryEnabled: false }])
    await click(button('Edit coworker'))
    await click(memory())
    expect(learning().disabled).toBe(false)
    expect(learning().getAttribute('aria-checked')).toBe('true')
    await click(learning())
    await click(button('Cancel'))
    await click(button('Edit coworker'))
    expect(memory().getAttribute('aria-checked')).toBe('false')
    await click(memory())
    expect(learning().getAttribute('aria-checked')).toBe('true')
    await click(button('Save changes'))
    expect(patches).toEqual([{ memoryEnabled: false }, { memoryEnabled: true }])
})

test('saving learning alone retains the edit on failure and persists a false value after retry', async () => {
    const patches = await mount({ ...settings, soulEditable: false }, true)
    await click(toggle('coworker-auto-memory'))
    await click(button('Save changes'))
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Try again.')
    expect(toggle('coworker-auto-memory').getAttribute('aria-checked')).toBe('false')
    await click(button('Save changes'))
    await click(button('Edit coworker'))
    expect(toggle('coworker-auto-memory').getAttribute('aria-checked')).toBe('false')
    expect(toggle('coworker-memory-enabled').getAttribute('aria-checked')).toBe('true')
    expect(button('Save changes').disabled).toBe(true)
    expect(patches).toEqual([{ autoMemory: false }, { autoMemory: false }])
})

test('disabled self-improvement shows learning as unavailable without changing the saved preference', async () => {
    const patches = await mount({ ...settings, selfImprovementEnabled: false })
    const learning = toggle('coworker-auto-memory')
    expect(learning.disabled).toBe(true)
    expect(learning.getAttribute('aria-checked')).toBe('false')
    expect(learning.getAttribute('aria-description')).toContain('self-improvement is off')
    expect(button('Save changes').disabled).toBe(true)
    await click(toggle('coworker-memory-enabled'))
    await click(button('Save changes'))
    expect(patches).toEqual([{ memoryEnabled: false }])
})


test('suggested replies save independently and survive reopening the settings form', async () => {
    const patches = await mount(settings)
    await click(toggle('coworker-suggested-replies'))
    await click(button('Save changes'))
    expect(patches).toEqual([{ suggestedReplies: false }])
    await click(button('Edit coworker'))
    expect(toggle('coworker-suggested-replies').getAttribute('aria-checked')).toBe('false')
    expect(toggle('coworker-memory-enabled').getAttribute('aria-checked')).toBe('true')
})

test('French reply-length labels save canonical values and a cancelled memory edit stays unsaved', async () => {
    const language: DesktopLanguage = { locale: 'fr', preference: 'fr', messages: desktopMessages('fr', await loadMessages('fr')) }
    const t = desktopTranslator(language)
    const patches = await mount(settings, false, language)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Longueur des réponses')
    await click(button(t('coworker.concise')))
    await click(button(t('coworker.save')))
    expect(patches).toEqual([{ verbosity: 'concise' }])
    await click(button(t('coworker.edit')))
    await click(toggle('coworker-memory-enabled'))
    await click(button(t('cancel')))
    await click(button(t('coworker.edit')))
    expect(toggle('coworker-memory-enabled').getAttribute('aria-checked')).toBe('true')
    expect(patches).toEqual([{ verbosity: 'concise' }])
})
