import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopQuestionCardProps } from '../DesktopQuestionCard'
import { testTriggerView as view } from '@/lib/desktop/trigger-requests/fixtures.test-support'
vi.mock('../DesktopQuestionCard', () => ({ DesktopQuestionCard: ({ question, disabled, onAnswer }: DesktopQuestionCardProps) => <button disabled={disabled} onClick={() => { void onAnswer({ action: 'answer', questionId: question.id, requestId: crypto.randomUUID(), answers: [['42']] }).catch(() => {}) }}>Answer 42</button> }))
vi.mock('../DesktopApprovalCard', () => ({ DesktopApprovalCard: () => null }))
vi.mock('../DesktopTakeoverCard', () => ({ DesktopTakeoverCard: () => null }))
vi.mock('../service-requests/DesktopServiceRequestBlock', () => ({ DesktopServiceRequestBlock: () => null }))
vi.mock('../secret-requests/DesktopSecretRequestBlock', () => ({ DesktopSecretRequestBlock: () => null }))
import { DesktopWebhookHumanRequest } from './DesktopWebhookHumanRequest'

afterEach(() => { vi.unstubAllGlobals() })
describe('webhook result presentation without private-chat effects', () => {
    it('history mounting and tab switches never answer, stop or navigate', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json({ request: view }))
        vi.stubGlobal('fetch', fetcher)
        const accepted = vi.fn(async () => {}), navigate = vi.fn()
        const rendered = render(<DesktopWebhookHumanRequest initial={view} active={false} onAccepted={accepted} onOpenResult={navigate} />)
        await waitFor(() => expect(fetcher).toHaveBeenCalled())
        expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
        expect(navigate).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled()
        rendered.rerender(<DesktopWebhookHumanRequest initial={view} active onAccepted={accepted} onOpenResult={navigate} />)
        fireEvent.click(screen.getByRole('button', { name: 'Open result chat' }))
        expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: view.link.sessionId, tabUid: `trigger:${view.link.sessionId}` }))
    })
    it('a delayed accepted reply cannot mutate or navigate a different active chat', async () => {
        let resolve!: (response: Response) => void
        const delayed = new Promise<Response>(done => { resolve = done })
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? delayed : Response.json({ request: view })))
        const accepted = vi.fn(async () => {}), navigate = vi.fn()
        const rendered = render(<DesktopWebhookHumanRequest initial={view} active onAccepted={accepted} onOpenResult={navigate} />)
        fireEvent.click(screen.getByRole('button', { name: 'Answer 42' }))
        rendered.rerender(<DesktopWebhookHumanRequest initial={view} active={false} onAccepted={accepted} onOpenResult={navigate} />)
        resolve(new Response('data: [DONE]\n\n', { headers: { 'x-session-id': view.link.sessionId, 'x-run-id': view.continuationId, 'x-trigger-request-key': view.key } }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Open result chat' })).toBeDisabled())
        expect(accepted).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
    })
    it('shows unknown acknowledgement without conflicting Stop or editable answers', () => {
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ request: { ...view, phase: 'uncertain' } })))
        render(<DesktopWebhookHumanRequest initial={{ ...view, phase: 'uncertain' }} active onAccepted={async () => {}} onOpenResult={() => {}} />)
        expect(screen.getByRole('button', { name: 'Check saved outcome' })).toBeEnabled()
        expect(screen.getByRole('button', { name: 'Answer 42' })).toBeDisabled()
        expect(screen.queryByRole('button', { name: 'Stop', exact: true })).toBeNull()
    })
})
