// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopServiceSuggestionCard, type DesktopServiceSuggestionCardProps } from './DesktopServiceSuggestionCard'
import { DesktopServiceRequestReceipt } from './DesktopServiceRequestReceipt'

vi.mock('@rerun/ui', () => ({ BorderBeam: () => null }))
vi.mock('motion/react', async () => {
    const { createElement } = await import('react')
    return {
        AnimatePresence: ({ children }: { children: ReactNode }) => children,
        motion: { div: ({ children, className }: { children: ReactNode; className: string }) => createElement('div', { className }, children) },
    }
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = '' })

async function render(props: Partial<DesktopServiceSuggestionCardProps> = {}) {
    const callbacks = { onConnect: vi.fn(), onCancel: vi.fn(), onSkip: vi.fn(), onAdvance: vi.fn(), onSelect: vi.fn() }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopServiceSuggestionCard
        name="Fixture app" slug="fixture" reason="Use this to complete the task." icon={null} category="dev"
        current={0} count={1} selected={[false]} skipped={false} canConnect canUseConnection={false}
        canAdvance={false} configuring={false} busy={false} {...callbacks} {...props}
    />))
    return callbacks
}

function button(label: string) {
    return [...document.querySelectorAll('button')].find(item => item.textContent === label)!
}

test('mounting never answers and unavailable methods remain explicit and skippable without a secret form', async () => {
    const callbacks = await render({ canConnect: false, unavailableReason: 'OAuth is unavailable on this Mac.' })
    expect(document.body.textContent).toContain('OAuth is unavailable on this Mac.')
    expect(document.body.textContent).toContain('Use this to complete the task.')
    expect(document.querySelector('input,textarea,iframe')).toBeNull()
    expect(button('Connect')).toBeUndefined()
    expect(button('Finish').disabled).toBe(true)
    Object.values(callbacks).forEach(callback => expect(callback).not.toHaveBeenCalled())
    await act(async () => button('Not now').click())
    expect(callbacks.onSkip).toHaveBeenCalledOnce()
    expect(callbacks.onAdvance).not.toHaveBeenCalled()
})

test('Cancel only closes setup and does not choose Skip or Finish', async () => {
    const callbacks = await render({ configuring: true })
    await act(async () => button('Cancel').click())
    expect(callbacks.onCancel).toHaveBeenCalledOnce()
    expect(callbacks.onSkip).not.toHaveBeenCalled()
    expect(callbacks.onAdvance).not.toHaveBeenCalled()
    expect(button('Finish').disabled).toBe(true)
})

test('renders the original compact Apps receipt from server-derived names and outcomes as text', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopServiceRequestReceipt entries={[
        { name: '<script>example</script>', outcome: 'connected' },
        { name: 'Other', outcome: 'reset' },
        { name: 'Missing', outcome: 'not-found' },
    ]} />))
    expect(document.body.textContent).toContain('1 of 3 connected')
    expect(document.body.textContent).toContain('Not reconnected')
    expect(document.body.textContent).toContain('Not found')
    expect(document.body.textContent).toContain('<script>example</script>')
    expect(document.querySelector('script')).toBeNull()
})
