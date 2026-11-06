// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopQuestionCardProps } from '../DesktopQuestionCard'
import { testTriggerView as view } from '@/lib/desktop/trigger-requests/fixtures.test-support'
vi.mock('../DesktopQuestionCard', () => ({ DesktopQuestionCard: ({ question, disabled, onAnswer }: DesktopQuestionCardProps) => <button disabled={disabled} onClick={() => { void onAnswer({ action: 'answer', questionId: question.id, requestId: crypto.randomUUID(), answers: [['42']] }).catch(() => {}) }}>Answer 42</button> }))
vi.mock('../DesktopApprovalCard', () => ({ DesktopApprovalCard: () => null }))
vi.mock('../DesktopTakeoverCard', () => ({ DesktopTakeoverCard: () => null }))
vi.mock('../service-requests/DesktopServiceRequestBlock', () => ({ DesktopServiceRequestBlock: () => null }))
vi.mock('../secret-requests/DesktopSecretRequestBlock', () => ({ DesktopSecretRequestBlock: () => null }))
import { DesktopWebhookHumanRequest } from './DesktopWebhookHumanRequest'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === name)
const ack = () => new Response('data: [DONE]\n\n', { headers: { 'x-session-id': view.link.sessionId, 'x-run-id': view.continuationId, 'x-trigger-request-key': view.key } })
describe('webhook result presentation without private-chat effects', () => {
    it('history mounting and tab switches never answer, stop or navigate', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json({ request: view }))
        vi.stubGlobal('fetch', fetcher)
        const accepted = vi.fn(async () => {}), navigate = vi.fn()
        await act(async () => root.render(<DesktopWebhookHumanRequest initial={view} active={false} onAccepted={accepted} onOpenResult={navigate} />))
        expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
        expect(navigate).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled()
        await act(async () => root.render(<DesktopWebhookHumanRequest initial={view} active onAccepted={accepted} onOpenResult={navigate} />))
        await act(async () => button('Open result chat')!.click())
        expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: view.link.sessionId, tabUid: `trigger:${view.link.sessionId}` }))
    })
    it('a delayed accepted reply cannot mutate or navigate a different active chat', async () => {
        let resolve!: (response: Response) => void
        const delayed = new Promise<Response>(done => { resolve = done })
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? delayed : Response.json({ request: view })))
        const accepted = vi.fn(async () => {}), navigate = vi.fn()
        await act(async () => root.render(<DesktopWebhookHumanRequest initial={view} active onAccepted={accepted} onOpenResult={navigate} />))
        await act(async () => button('Answer 42')!.click())
        await act(async () => root.render(<DesktopWebhookHumanRequest initial={view} active={false} onAccepted={accepted} onOpenResult={navigate} />))
        await act(async () => resolve(ack()))
        expect(button('Open result chat')?.disabled).toBe(true)
        expect(accepted).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
    })
    it('shows unknown acknowledgement without conflicting Stop or editable answers', async () => {
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ request: { ...view, phase: 'uncertain' } })))
        await act(async () => root.render(<DesktopWebhookHumanRequest initial={{ ...view, phase: 'uncertain' }} active onAccepted={async () => {}} onOpenResult={() => {}} />))
        expect(button('Check saved outcome')?.disabled).toBe(false)
        expect(button('Answer 42')?.disabled).toBe(true)
        expect(button('Stop')).toBeUndefined()
    })
    it('hands an exact acknowledged stream to its owner without aborting it when the form hides', async () => {
        let dispatchSignal: AbortSignal | null = null, finish!: () => void
        const held = new Promise<void>(resolve => { finish = resolve })
        const accepted = vi.fn(async () => held)
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => { if (init?.method === 'POST') { dispatchSignal = init.signal as AbortSignal; return ack() } return Response.json({ request: view }) })
        vi.stubGlobal('fetch', fetcher)
        await act(async () => root.render(<DesktopWebhookHumanRequest initial={view} active onAccepted={accepted} onOpenResult={() => {}} />))
        await act(async () => button('Answer 42')!.click())
        expect(accepted).toHaveBeenCalledTimes(1)
        await act(async () => root.render(<DesktopWebhookHumanRequest initial={view} active={false} onAccepted={accepted} onOpenResult={() => {}} />))
        expect((dispatchSignal as AbortSignal | null)?.aborted).toBe(false)
        await act(async () => finish())
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    })
})
