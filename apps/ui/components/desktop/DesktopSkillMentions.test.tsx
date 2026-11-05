// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopSkillMentions, type DesktopSkillMentionsApi } from './DesktopSkillMentions'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
let captured: DesktopSkillMentionsApi | null = null
let form: HTMLFormElement | null = null
const submit = vi.fn()

const row = (slug: string, name = slug, description = '') => ({ slug, name, description, body: `# ${name}\n\nbody`, files: [] as string[], fromConnector: false })
const shelf = (skills: ReturnType<typeof row>[]) => Response.json({ skills })

function Capture({ api }: { api: DesktopSkillMentionsApi }) {
    useEffect(() => { captured = api }, [api])
    return null
}

function Harness({ agentId }: { agentId: string | null }) {
    const [text, setText] = useState('')
    const formRef = useRef<HTMLFormElement>(null)
    return (
        <DesktopSkillMentions agentId={agentId} onTextChange={setText}>
            {api => {
                return (
                    <form ref={formRef}>
                        <Capture api={api} />
                        <textarea ref={api.inputRef} value={text} aria-label="message" {...api.textareaProps} />
                        {api.menu}
                    </form>
                )
            }}
        </DesktopSkillMentions>
    )
}

async function mount(agentId: string | null) {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const render = async (nextAgentId: string | null = agentId) => {
        agentId = nextAgentId
        await act(async () => { root.render(<Harness agentId={agentId} />) })
    }
    await render()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    form = container.querySelector('form')
    if (form) form.requestSubmit = submit as typeof form.requestSubmit
    return { render, textarea }
}

// The same controlled-input typing pattern the desktop composer tests use.
const type = async (el: HTMLTextAreaElement, text: string) => {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text)
        el.dispatchEvent(new Event('input', { bubbles: true }))
    })
}

const key = async (el: HTMLTextAreaElement, init: KeyboardEventInit) => {
    await act(async () => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
        if (init.isComposing && !event.isComposing) Object.defineProperty(event, 'isComposing', { value: true })
        el.dispatchEvent(event)
    })
}

const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]

beforeEach(() => {
    submit.mockClear()
    captured = null
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('/agents/a/skills')) return shelf([row('deploy', 'Deploy the app', 'Publish the current build.'), row('describe', 'Describe a service', 'Explain what a service does.')])
        if (url.includes('/agents/b/skills')) return shelf([row('bob-only', 'Bob’s procedure')])
        return shelf([])
    }))
})

afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
})

test('`/` opens the original Skills menu with name, slug and description labels', async () => {
    const { textarea } = await mount('a')
    await type(textarea, '/')
    expect(captured?.menu).not.toBeNull()
    expect(document.body.textContent).toContain('Skills')
    const rows = options()
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Deploy the app')
    expect(rows[0].textContent).toContain('/deploy')
    expect(rows[0].textContent).toContain('Publish the current build.')
    expect(rows[1].textContent).toContain('Describe a service')
    expect(rows[1].textContent).toContain('/describe')
})

test('the menu filters on the typed query', async () => {
    const { textarea } = await mount('a')
    await type(textarea, '/dep')
    const rows = options()
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('/deploy')
})

test('`@` finds nothing and stays closed: coworker delegation is not surfaced', async () => {
    const { textarea } = await mount('a')
    await type(textarea, '@')
    expect(captured?.menu).toBeNull()
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
})

test('arrows navigate and Enter picks the highlighted row before it may send', async () => {
    const { textarea } = await mount('a')
    await type(textarea, '/')
    await key(textarea, { key: 'ArrowDown' })
    expect(options()[1].getAttribute('aria-selected')).toBe('true')
    await key(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('/describe ')
    expect(captured?.menu).toBeNull()
    expect(submit).not.toHaveBeenCalled()
})

test('Escape dismisses the menu and keeps the draft', async () => {
    const { textarea } = await mount('a')
    await type(textarea, '/')
    expect(captured?.menu).not.toBeNull()
    await key(textarea, { key: 'Escape' })
    expect(captured?.menu).toBeNull()
    expect(textarea.value).toBe('/')
})

test('a composing Enter neither picks a suggestion nor sends', async () => {
    const { textarea } = await mount('a')
    await type(textarea, '/')
    await key(textarea, { key: 'Enter', isComposing: true })
    expect(textarea.value).toBe('/')
    expect(captured?.menu).not.toBeNull()
    expect(submit).not.toHaveBeenCalled()
})

test('an Enter with the menu closed still submits', async () => {
    const { textarea } = await mount('a')
    await type(textarea, 'hello')
    await key(textarea, { key: 'Enter' })
    expect(submit).toHaveBeenCalledTimes(1)
})

test('switching the owner surfaces only that owner’s skills', async () => {
    const { render, textarea } = await mount('a')
    await render('b')
    await type(textarea, '/')
    const rows = options()
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('/bob-only')
    expect(rows[0].textContent).not.toContain('deploy')
})

test('tokens expose only the current owner’s `/slug` mentions', async () => {
    const { render } = await mount('a')
    expect(captured?.tokens).toEqual([
        { text: '/deploy', kind: 'skill' },
        { text: '/describe', kind: 'skill' },
    ])
    await render('b')
    expect(captured?.tokens).toEqual([{ text: '/bob-only', kind: 'skill' }])
})

test('typing through the composed handlers updates the durable draft text', async () => {
    const { textarea } = await mount('a')
    await type(textarea, '/deploy')
    expect(textarea.value).toBe('/deploy')
    expect(captured?.skills.map(skill => skill.slug)).toEqual(['deploy', 'describe'])
})

test('shelf failures are distinguishable through the wrapper', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await mount('a')
    expect(captured?.status).toBe('unavailable')
    expect(captured?.error).toBe('Failed to fetch')
    expect(captured?.skills).toEqual([])
})
