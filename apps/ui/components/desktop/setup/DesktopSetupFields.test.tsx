// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { DesktopSetupFields, type DesktopSetupDraft } from './DesktopSetupFields'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: { root: Root; host: HTMLElement }[] = []
afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
        act(() => root.unmount())
        host.remove()
    }
})

function render(value: DesktopSetupDraft, onChange: (next: DesktopSetupDraft) => void = () => {}) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    act(() => root.render(<DesktopSetupFields value={value} defaultPrompt="Use the local Mac tools." onChange={onChange} />))
    return host
}

it('starts a required empty prompt from the injected local default', () => {
    let next: DesktopSetupDraft | undefined
    const host = render({ required: null, prompt: '' }, value => { next = value })
    const yes = [...host.querySelectorAll('button')].find(button => button.textContent === 'Yes')!
    act(() => yes.click())
    expect(next).toEqual({ required: true, prompt: 'Use the local Mac tools.' })
})

it('offers the injected local default without overwriting an existing answer', () => {
    let next: DesktopSetupDraft | undefined
    const host = render({ required: true, prompt: 'Keep this answer.' }, value => { next = value })
    const reset = [...host.querySelectorAll('button')].find(button => button.textContent === 'Reset to the default template')!
    act(() => reset.click())
    expect(next).toBeUndefined()
    expect(document.body.textContent).toContain('Reset to the default template?')
})

it('uses the injected default for the empty-prompt action and textarea placeholder', () => {
    const host = render({ required: true, prompt: '' })
    expect(host.querySelector('textarea')?.placeholder).toBe('Use the local Mac tools.')
    expect(host.textContent).toContain('Use the default template')
})
