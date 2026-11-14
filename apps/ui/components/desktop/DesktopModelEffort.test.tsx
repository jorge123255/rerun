// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopModelEffort } from './DesktopModelEffort'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = '' })
function mount(node: React.ReactNode) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    act(() => { root.render(node) })
    return host
}
const levels = ['low', 'medium', 'high', 'xhigh', 'max']
function slide(input: HTMLInputElement, value: number) {
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value))
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
    })
}

test('shows the chosen effort and saves the stop the slider is released on', () => {
    const onChoose = vi.fn()
    const host = mount(<DesktopModelEffort model="GPT-6.1 Sol" options={levels} chosen="high" onChoose={onChoose} />)
    const input = host.querySelector<HTMLInputElement>('input[type=range]')!
    expect(host.textContent).toContain('High')
    expect(host.textContent).toContain('GPT-6.1 Sol')
    expect(input.value).toBe('2')
    expect(input.max).toBe('4')
    slide(input, 3)
    // Nothing is saved while the thumb is still held.
    expect(onChoose).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Extra high')
    act(() => { input.dispatchEvent(new Event('pointerup', { bubbles: true })) })
    expect(onChoose).toHaveBeenCalledExactlyOnceWith('xhigh')
})

test('rests on the model default until an effort is picked, and the reset button returns to it', () => {
    const onChoose = vi.fn()
    const host = mount(<DesktopModelEffort model="GPT-6.1 Sol" options={levels} inherited="medium" onChoose={onChoose} />)
    expect(host.textContent).toContain('Default · Medium')
    expect(host.querySelector<HTMLInputElement>('input[type=range]')!.value).toBe('1')
    const reset = () => host.querySelector<HTMLButtonElement>('button[aria-label="Use this model’s default effort"]')!
    expect(reset().disabled).toBe(true)
    act(() => { roots[0]!.render(<DesktopModelEffort model="GPT-6.1 Sol" options={levels} chosen="max" inherited="medium" onChoose={onChoose} />) })
    expect(reset().disabled).toBe(false)
    act(() => { reset().click() })
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(null)
})
