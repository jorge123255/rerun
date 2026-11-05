// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { IsolatedScreenDialog } from './IsolatedScreenDialog'
const sessions = vi.hoisted(() => ({ connect: vi.fn(), finish: vi.fn(), close: vi.fn(), cancelConnection: vi.fn() }))
vi.mock('@/lib/desktop/screen-session', () => ({ createDesktopScreenSession: () => sessions }))
vi.mock('@/components/dialogs/DesktopDialog', () => ({ DesktopDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/desktop/DesktopViewer', () => ({ DesktopViewer: ({ viewOnly }: { viewOnly: boolean }) => <div data-watch={String(viewOnly)}>screen</div> }))
vi.mock('@/components/desktop/DesktopNotch', () => ({ DesktopNotch: ({ onDone, disabled }: { onDone?: () => void; disabled?: boolean }) => onDone ? <button disabled={disabled} onClick={onDone}>Done</button> : null }))
vi.mock('@/components/desktop/TakeControlOverlay', () => ({ TakeControlOverlay: ({ onClick }: { onClick: () => void }) => <button onClick={onClick}>Take control</button> }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.resetAllMocks(); document.body.innerHTML = '' })
async function mount(props: Partial<Parameters<typeof IsolatedScreenDialog>[0]> = {}) {
    sessions.connect.mockResolvedValue({ socketUrl: 'ws://127.0.0.1/ticket' }); sessions.finish.mockResolvedValue({ url: 'https://example.com' }); sessions.close.mockResolvedValue(undefined)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<IsolatedScreenDialog open agentId="owner" title="Coworker" onOpenChange={() => {}} {...props} />))
}
async function click(label: string) { const button = [...document.querySelectorAll('button')].find(b => b.textContent === label)!; expect(button).toBeDefined(); await act(async () => button.click()) }
test('manual Done tears down driving and closes the dialog', async () => {
    const close = vi.fn(); await mount({ onOpenChange: close })
    expect(document.querySelector('[data-watch="true"]')).not.toBeNull()
    await click('Take control'); expect(document.querySelector('[data-watch="false"]')).not.toBeNull()
    await click('Done')
    expect(sessions.cancelConnection).toHaveBeenCalled()
    expect(sessions.finish).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-watch="false"]')).toBeNull()
    expect(close).toHaveBeenCalledWith(false)
})
test('requested takeover waits for the durable hand-back receipt and retries without releasing twice', async () => {
    const close = vi.fn(), handBack = vi.fn().mockRejectedValueOnce(new Error('receipt failed')).mockResolvedValue(undefined)
    await mount({ onOpenChange: close, takeover: { callId: 'request-1', reason: 'Sign in' }, onHandBack: handBack })
    await click('Done'); expect(close).not.toHaveBeenCalled()
    expect(document.querySelector('[data-watch="false"]')).toBeNull()
    await click('Done')
    expect(handBack).toHaveBeenNthCalledWith(2, 'request-1', 'https://example.com')
    expect(sessions.finish).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledWith(false)
})
test('expired takeover reconnects before allowing a fresh hand-back', async () => {
    const close = vi.fn(), handBack = vi.fn().mockResolvedValue(undefined)
    await mount({ onOpenChange: close, takeover: { callId: 'request-1', reason: 'Review' }, onHandBack: handBack })
    sessions.finish.mockResolvedValueOnce({ url: null, expired: true }).mockResolvedValueOnce({ url: 'https://example.com/fresh' })
    await click('Done')
    expect(handBack).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    await click('Reconnect')
    expect(sessions.connect).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-watch="false"]')).not.toBeNull()
    await click('Done')
    expect(handBack).toHaveBeenCalledWith('request-1', 'https://example.com/fresh')
    expect(close).toHaveBeenCalledWith(false)
})
