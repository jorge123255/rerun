// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DesktopForemanAnswerActions } from './DesktopForemanAnswerActions'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('renders only the original two thumbs, marks the saved vote and reports the chosen rating', async () => {
    const network = vi.fn(() => { throw new Error('No action-row effects permitted') })
    vi.stubGlobal('fetch', network)
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    const onRate = vi.fn()
    try {
        await act(async () => root.render(<DesktopForemanAnswerActions rating="up" onRate={onRate} />))
        const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')]
        expect(buttons).toHaveLength(2)
        expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true')
        expect(buttons[1]!.getAttribute('aria-pressed')).toBe('false')
        expect(host.textContent).toContain('Good response')
        expect(host.textContent).toContain('Bad response')
        expect(host.querySelector('a, input, textarea, form')).toBeNull()
        await act(async () => buttons[1]!.click())
        expect(onRate).toHaveBeenCalledWith('down')
        expect(network).not.toHaveBeenCalled()

        await act(async () => root.render(<DesktopForemanAnswerActions rating="down" disabled onRate={onRate} />))
        const disabled = [...host.querySelectorAll<HTMLButtonElement>('button')]
        expect(disabled.every(button => button.disabled)).toBe(true)
        expect(disabled[1]!.getAttribute('aria-pressed')).toBe('true')
    } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
})
