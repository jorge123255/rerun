// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopSetupEditor } from './DesktopSetupEditor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: { root: Root; host: HTMLElement }[] = []
afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
        act(() => root.unmount())
        host.remove()
    }
})

function render(props: Partial<Parameters<typeof DesktopSetupEditor>[0]> = {}) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    act(() => root.render(<DesktopSetupEditor
        value={{ required: null, prompt: '' }}
        defaultPrompt="Local setup"
        dirty={false}
        saving={false}
        saved={false}
        error=""
        onChange={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
        {...props}
    />))
    return host
}

it('requires an explicit answered state and nonempty required instructions', () => {
    const unanswered = render()
    expect([...unanswered.querySelectorAll('button')].find(button => button.textContent === 'Save')!.disabled).toBe(true)
    act(() => roots[0].root.unmount())
    roots.splice(0)
    const empty = render({ value: { required: true, prompt: '   ' }, dirty: true })
    expect([...empty.querySelectorAll('button')].find(button => button.textContent === 'Save')!.disabled).toBe(true)
})

it('guards Cancel only when the author has unsaved edits', () => {
    const onCancel = vi.fn()
    const host = render({ value: { required: false, prompt: '' }, dirty: true, onCancel })
    const cancel = [...host.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!
    act(() => cancel.click())
    expect(onCancel).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Discard unsaved setup changes?')
    const discard = [...document.querySelectorAll('button')].find(button => button.textContent === 'Discard changes')!
    act(() => discard.click())
    expect(onCancel).toHaveBeenCalledOnce()
})

it('preserves the original Save progress and saved labels', () => {
    const saving = render({ value: { required: false, prompt: '' }, dirty: true, saving: true })
    expect(saving.textContent).toContain('Saving...')
    act(() => roots[0].root.unmount())
    roots.splice(0)
    const saved = render({ value: { required: false, prompt: '' }, saved: true })
    expect(saved.textContent).toContain('Saved')
})
