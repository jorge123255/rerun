// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopInstallGate } from './DesktopInstallGate'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: { root: Root; host: HTMLElement }[] = []
afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
        act(() => root.unmount())
        host.remove()
    }
})

function render(props: Partial<Parameters<typeof DesktopInstallGate>[0]> = {}) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    act(() => root.render(<DesktopInstallGate agentId="agent" agentName="Ada" apps={[]} onStart={async () => true} onSkip={async () => {}} {...props} />))
    return host
}

it('re-enables Start without losing the callback when model readiness or acknowledgment refuses it', async () => {
    const onStart = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const host = render({ onStart })
    const button = () => [...host.querySelectorAll('button')].find(item => item.textContent?.includes('Install Ada'))!
    await act(async () => { button().click() })
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(button().disabled).toBe(false)
    await act(async () => { button().click() })
    expect(onStart).toHaveBeenCalledTimes(2)
})

it('uses the original Continue setup state for an already claimed chat', () => {
    const onContinue = vi.fn()
    const host = render({ inProgress: true, onContinue })
    expect(host.textContent).toContain('Ada is being set up')
    expect(host.textContent).toContain('In another conversation')
    expect(host.textContent).not.toContain('Install Ada')
    const button = [...host.querySelectorAll('button')].find(item => item.textContent?.includes('Continue setup'))!
    act(() => button.click())
    expect(onContinue).toHaveBeenCalledOnce()
})

it('keeps Skip available until a Start attempt begins and then prevents overlapping mutations', async () => {
    let release = () => {}
    const pending = new Promise<boolean>(resolve => { release = () => resolve(false) })
    const onSkip = vi.fn(async () => {})
    const host = render({ onStart: () => pending, onSkip, modelSlot: <span>Model picker</span> })
    const skip = () => [...host.querySelectorAll('button')].find(item => item.textContent === 'Skip for now')!
    expect(skip().disabled).toBe(false)
    const start = [...host.querySelectorAll('button')].find(item => item.textContent?.includes('Install Ada'))!
    act(() => start.click())
    expect(skip().disabled).toBe(true)
    expect(host.textContent).toContain('Installing')
    await act(async () => { release(); await pending })
    expect(skip().disabled).toBe(false)
    act(() => skip().click())
    expect(onSkip).toHaveBeenCalledOnce()
})
