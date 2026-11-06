// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopClaudePlanRuntime } from '@/lib/desktop/claude-plan-client/use-desktop-claude-plan'
import { DesktopClaudePlanSteps } from './DesktopClaudePlanSteps'
import { DesktopClaudePlanDialog } from './DesktopClaudePlanDialog'

vi.mock('@/components/connections/plan-connect/ForemanTrack', () => ({
    ForemanTrack: ({ steps }: { steps: { title: string; body?: React.ReactNode }[] }) => <ol>{steps.map((step, index) => <li key={index}><span>{step.title}</span>{step.body}</li>)}</ol>,
}))
vi.mock('@rerun/ui/foreman', () => ({ Orb: () => null }))
const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})
const runtime = (): DesktopClaudePlanRuntime & { submit: ReturnType<typeof vi.fn> } => ({
    start: vi.fn(async () => ({ attemptId: 'attempt-1', phase: 'waiting', authorizeUrl: 'https://claude.ai/oauth/authorize?state=opaque' })),
    reconcile: vi.fn(async () => ({ attemptId: 'attempt-1', phase: 'idle' })),
    submit: vi.fn(async () => ({ attemptId: 'attempt-1', phase: 'connected' })),
    cancel: vi.fn(async () => ({ attemptId: 'attempt-1', phase: 'idle' })),
})
const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)!
    await act(async () => { button.click() })
}

test('preserves Open, code, and Name it steps through connected completion', async () => {
    const auth = runtime(), onOpenAuthorization = vi.fn(), onDone = vi.fn()
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopClaudePlanSteps runtime={auth} onOpenAuthorization={onOpenAuthorization} onDone={onDone} />))
    expect(document.body.textContent).toContain('Approve Rerun on Claude')
    expect(document.body.textContent).toContain('Paste the code')
    expect(document.body.textContent).toContain('Name it')
    await click('Open Claude')
    expect(onOpenAuthorization).toHaveBeenCalledWith('https://claude.ai/oauth/authorize?state=opaque')
    const code = document.querySelector<HTMLInputElement>('input[type="password"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(code, 'opaque-code')
    await act(async () => code.dispatchEvent(new Event('input', { bubbles: true })))
    await act(async () => code.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(auth.submit).toHaveBeenCalledWith('attempt-1', 'opaque-code', expect.any(AbortSignal))
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Connection name"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Claude work')
    await act(async () => name.dispatchEvent(new Event('input', { bubbles: true })))
    await click('Done')
    expect(onDone).toHaveBeenCalledWith('Claude work')
})

test('direct paste submits once and a failed exchange remains retryable', async () => {
    const auth = runtime()
    auth.submit
        .mockResolvedValueOnce({ attemptId: 'attempt-1', phase: 'error', error: 'The code did not match. Try again.' })
        .mockResolvedValueOnce({ attemptId: 'attempt-1', phase: 'connected' })
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopClaudePlanSteps runtime={auth} onOpenAuthorization={vi.fn()} onDone={vi.fn()} />))
    await click('Open Claude')
    const code = document.querySelector<HTMLInputElement>('input[type="password"]')!
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'pasted-code' } })
    await act(async () => code.dispatchEvent(paste))
    expect(auth.submit).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('The code did not match. Try again.')
    await act(async () => code.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(auth.submit).toHaveBeenCalledTimes(2)
})

test('Escape closes only the pending UI operation and never disconnects an existing login', async () => {
    const auth = runtime()
    auth.reconcile = vi.fn(async () => ({ attemptId: 'attempt-1', phase: 'waiting', authorizeUrl: 'https://claude.ai/oauth/authorize?state=opaque' }))
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopClaudePlanDialog open runtime={auth} onOpenAuthorization={vi.fn()} onOpenChange={vi.fn()} onDone={vi.fn()} />))
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(auth.cancel).toHaveBeenCalledWith('attempt-1', expect.any(AbortSignal))
})
