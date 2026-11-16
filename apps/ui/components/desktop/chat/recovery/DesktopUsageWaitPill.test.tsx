// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopUsageWaitView } from '@/lib/desktop/server/usage-waits'
import { usageLine } from '../../schedules/DesktopCoworkerSchedules'
import { DesktopUsageWaitPill } from './DesktopUsageWaitPill'

vi.mock('@rerun/ui', () => ({ BorderBeam: () => null }))
const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount() }); document.body.innerHTML = '' })

const wait = (extra: Partial<DesktopUsageWaitView> = {}): DesktopUsageWaitView => ({ id: 'w1', text: 'Summarise the week', plan: 'ChatGPT', resetsAt: '2026-11-16T15:00:00.000Z', nextCheckAt: '2026-11-16T15:00:30.000Z', state: 'waiting', reason: null, createdAt: '2026-11-16T10:00:00.000Z', ...extra })
async function mount(view: DesktopUsageWaitView, onCancel = vi.fn()) {
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopUsageWaitPill wait={view} onCancel={onCancel} />))
    return onCancel
}
const button = (label: string) => [...document.querySelectorAll<HTMLElement>('button')].find(item => item.textContent?.includes(label))

test('the waiting message is visible in the conversation and can be cancelled', async () => {
    const onCancel = await mount(wait())
    expect(document.body.textContent).toContain('Waiting to send your message')
    expect(document.body.textContent).toContain('ChatGPT resets at')
    expect(document.body.textContent).toContain('Summarise the week')
    await act(async () => { button('Cancel')?.click() })
    expect(onCancel).toHaveBeenCalledTimes(1)
})

test('a message that was held back says why and can be dismissed', async () => {
    await mount(wait({ state: 'held', reason: 'This conversation now uses a model billed per token, so the message was not sent.' }))
    expect(document.body.textContent).toContain('Message not sent')
    expect(document.body.textContent).toContain('billed per token')
    expect(button('Dismiss')).toBeDefined()
})

test('a parked routine reads as waiting, and one skipped after a day gives its reason', () => {
    const format = (iso: string) => iso.slice(11, 16)
    expect(usageLine({ usageWait: { slug: 'daily', plan: 'ChatGPT', parkedAt: '', resetsAt: '2026-11-16T15:00:00.000Z', nextCheckAt: '', skippedWhileWaiting: 0 }, usageSkip: null }, format)).toBe('Waiting for ChatGPT to reset at 15:00')
    expect(usageLine({ usageWait: { slug: 'daily', plan: 'ChatGPT', parkedAt: '', resetsAt: null, nextCheckAt: '', skippedWhileWaiting: 2 }, usageSkip: null }, format)).toBe('Waiting for ChatGPT to have usage again (checking every 15 minutes) · 2 later runs skipped while waiting')
    expect(usageLine({ usageWait: null, usageSkip: { slug: 'daily', at: '', reason: 'Skipped: ChatGPT was still out of usage after 24 hours.' } }, format)).toBe('Skipped: ChatGPT was still out of usage after 24 hours.')
    expect(usageLine({ usageWait: null, usageSkip: null }, format)).toBeNull()
})
