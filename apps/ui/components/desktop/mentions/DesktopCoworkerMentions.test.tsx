// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { DesktopCoworkerCallTarget } from '@rerun/contracts'
import type { DesktopCoworkerMention } from '@/lib/desktop/coworker-mentions'
import { DesktopCoworkerMentions } from './DesktopCoworkerMentions'

const targets: DesktopCoworkerCallTarget[] = [
    { agentId: 'peer-1', name: 'Researcher', handle: 'researcher', boxName: 'Research', enabled: true, callable: true },
    { agentId: 'peer-2', name: 'Research assistant', handle: 'assistant', boxName: 'Other', enabled: true, callable: true },
]

vi.mock('@rerun/ui/iso-grid', () => ({ AgentBuddy: () => null }))
vi.mock('@/lib/desktop/use-desktop-skill-suggestions', () => ({
    useDesktopSkillSuggestions: () => ({ status: 'ready', skills: [{ slug: 'docs', name: 'Documentation', description: 'Read project docs' }], error: null, retry: vi.fn() }),
}))
vi.mock('@/lib/desktop/coworker-mentions', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/desktop/coworker-mentions')>()
    return { ...actual, useDesktopCoworkerMentionTargets: () => ({ status: 'ready', targets, targetError: null, retryTargets: vi.fn() }) }
})

let root: Root | undefined
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
    if (!window.matchMedia) window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia
})

afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})

async function mount(onTextChange = vi.fn(), onMentionsChange = vi.fn(), onSubmit = vi.fn()) {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerMentions agentId="owner-1" preferredBoxName="Research" text="" mentions={[]} onTextChange={onTextChange} onMentionsChange={onMentionsChange}>
        {api => <form onSubmit={onSubmit}><textarea ref={api.inputRef} {...api.textareaProps} />{api.menu}</form>}
    </DesktopCoworkerMentions>))
    return { onTextChange, onMentionsChange, onSubmit }
}

async function type(value: string) {
    const textarea = document.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
    textarea.setSelectionRange(value.length, value.length)
    await act(async () => textarea.dispatchEvent(new Event('input', { bubbles: true })))
}

async function key(key: string) {
    const textarea = document.querySelector('textarea')!
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
}

it('keeps original Box hints and preferred ordering alongside /skills', async () => {
    await mount()
    await type('@research')
    const options = [...document.querySelectorAll('[role="option"]')]
    expect(options[0]?.textContent).toContain('Researcher')
    expect(options[0]?.textContent).toContain('Research')
    expect(options[1]?.textContent).toContain('Research assistant')
    await type('/doc')
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('Documentation')
})

it('records an immutable coworker selection without sending or changing grants', async () => {
    const { onTextChange, onMentionsChange, onSubmit } = await mount()
    await type('@re')
    await key('Enter')
    expect(onTextChange).toHaveBeenLastCalledWith('@researcher ')
    expect(onMentionsChange).toHaveBeenLastCalledWith([{ targetId: 'peer-1', token: '@researcher', start: 0, end: 11 }])
    expect(onSubmit).not.toHaveBeenCalled()
})

it('inserts a /skill as text without creating a coworker target record', async () => {
    const { onTextChange, onMentionsChange, onSubmit } = await mount()
    await type('/do')
    await key('Tab')
    expect(onTextChange).toHaveBeenLastCalledWith('/docs ')
    expect(onMentionsChange).toHaveBeenLastCalledWith([])
    expect(onSubmit).not.toHaveBeenCalled()
})

it('does not turn email or embedded text into coworker suggestions', async () => {
    await mount()
    await type('mail@researcher')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    await type('prefix@researcher')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
})

it('wraps keyboard highlight and exposes the active option without submitting', async () => {
    const { onTextChange, onSubmit } = await mount()
    await type('@re')
    const textarea = document.querySelector('textarea')!
    expect(textarea.getAttribute('aria-expanded')).toBe('true')
    await key('ArrowUp')
    const options = [...document.querySelectorAll('[role="option"]')]
    expect(options[1]?.getAttribute('aria-selected')).toBe('true')
    expect(textarea.getAttribute('aria-activedescendant')).toBe(options[1]?.id)
    await key('Enter')
    expect(onTextChange).toHaveBeenLastCalledWith('@assistant ')
    expect(onSubmit).not.toHaveBeenCalled()
})

it('supports pointer hover/pick while retaining textarea focus and caret placement', async () => {
    const { onTextChange, onSubmit } = await mount()
    await type('@re')
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    await act(async () => options[1].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })))
    await act(async () => options[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
    const textarea = document.querySelector('textarea')!
    expect(onTextChange).toHaveBeenLastCalledWith('@assistant ')
    expect(textarea.selectionStart).toBe(11)
    expect(document.activeElement).toBe(textarea)
    expect(onSubmit).not.toHaveBeenCalled()
})

it('leaves IME composition and Escape follow-up editing untouched', async () => {
    const { onTextChange, onSubmit } = await mount()
    await type('@re')
    const textarea = document.querySelector('textarea')!
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
    expect(onTextChange).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    await key('Escape')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    await key('Enter')
    expect(onTextChange).toHaveBeenCalledTimes(1)
})
