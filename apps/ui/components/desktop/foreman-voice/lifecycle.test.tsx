// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { useForemanVoiceSlot, type ForemanVoiceSlotController } from '@/lib/desktop/foreman-voice/useForemanVoiceSlot'
const fake = vi.hoisted(() => ({ start: vi.fn(async () => true), stop: vi.fn(async () => null), cancel: vi.fn(async () => {}), read: vi.fn(async () => null), request: vi.fn() }))
vi.mock('@/lib/desktop/voice/useDesktopVoiceRecorder', () => ({ useDesktopVoiceRecorder: () => ({ ...fake, stream: null }) }))
vi.mock('@/lib/desktop/foreman-voice/journal', () => ({ createForemanAudioJournal: () => ({ read: fake.read, put: vi.fn(), clear: vi.fn() }) }))
vi.mock('@/lib/desktop/foreman-voice/client', () => ({ createForemanVoiceClient: () => ({ request: fake.request }), audioBase64: vi.fn() }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const target = { chat: { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000002' }, model: { connectionId: 'connection', model: 'model' } }
let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); document.body.innerHTML = ''; vi.clearAllMocks(); vi.useRealTimers() })
test('passive hydration never opens hardware; closing and target switches cancel the exact capture', async () => {
    vi.useFakeTimers()
    const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
    let voice!: ForemanVoiceSlotController
    function Harness({ active = true, model = 'model' }: { active?: boolean; model?: string }) {
        voice = useForemanVoiceSlot({ target: { ...target, model: { ...target.model, model } }, active })
        return null
    }
    dispose = async () => { await act(async () => root.unmount()) }
    await act(async () => root.render(<Harness />))
    expect(fake.start).not.toHaveBeenCalled(); expect(fake.request).not.toHaveBeenCalled()
    await act(async () => voice.controller.start())
    expect(fake.start).toHaveBeenCalledOnce()
    await act(async () => root.render(<Harness active={false} />))
    expect(fake.cancel).toHaveBeenCalled(); expect(fake.request).not.toHaveBeenCalled()
    await act(async () => root.render(<Harness model="other" />))
    expect(voice.controller.target.model.model).toBe('other'); expect(voice.view.pending).toBeNull()
    expect(fake.start).toHaveBeenCalledOnce(); expect(fake.request).not.toHaveBeenCalled()
})
test('opening a dialog and losing document visibility cancel a simulated held microphone', async () => {
    const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
    let voice!: ForemanVoiceSlotController
    function Harness() { voice = useForemanVoiceSlot({ target, active: true }); return null }
    dispose = async () => { await act(async () => root.unmount()) }
    await act(async () => root.render(<Harness />))
    await act(async () => voice.controller.start())
    await act(async () => { const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); document.body.appendChild(dialog); await Promise.resolve() })
    expect(fake.cancel).toHaveBeenCalled(); expect(fake.request).not.toHaveBeenCalled()
    document.querySelector('[role="dialog"]')?.remove()
    await act(async () => voice.controller.start())
    await act(async () => window.dispatchEvent(new Event('blur')))
    expect(fake.cancel.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(fake.stop).not.toHaveBeenCalled()
})
