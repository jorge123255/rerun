import { describe, expect, it, vi } from 'vitest'
import { createStarterTextAnswerAdapter, type StarterRequest, type StarterReceipt } from './starter-answer'

const request: StarterRequest = { workspaceId: 'workspace-a', chatId: 'chat-a', requestId: 'starter-a', revision: '1' }
const receipt: StarterReceipt = { ...request, receiptId: 'receipt-a', answer: { answered: true, custom: 'Bookkeeping' } }

describe('starter text answer adapter (offline authority fixtures)', () => {
    it('has no restoration effects and stays unavailable without authority', async () => {
        const read = vi.fn(() => request)
        const submit = createStarterTextAnswerAdapter(read)
        expect(read).not.toHaveBeenCalled()
        expect(await submit(request, 'Bookkeeping')).toEqual({ status: 'unavailable' })
    })
    it('submits the exact saved request and trimmed text; recovers identical receipt', async () => {
        const ports = { receipt: vi.fn(async () => null as StarterReceipt | null), answer: vi.fn(async () => receipt) }
        const submit = createStarterTextAnswerAdapter(() => request, ports)
        expect((await submit(request, ' Bookkeeping ')).status).toBe('confirmed')
        expect(ports.answer).toHaveBeenCalledWith(request, receipt.answer)
        ports.receipt.mockResolvedValue(receipt)
        expect((await submit(request, 'Bookkeeping')).status).toBe('confirmed')
        expect(ports.answer).toHaveBeenCalledTimes(1)
    })
    it('refuses stale workspace, chat, revision and stopped submissions', async () => {
        for (const active of [null, { ...request, workspaceId: 'other' }, { ...request, chatId: 'other' }, { ...request, revision: '2' }]) {
            const ports = { receipt: vi.fn(async () => null), answer: vi.fn(async () => receipt) }
            expect((await createStarterTextAnswerAdapter(() => active, ports)(request, 'Bookkeeping')).status).toBe('stale')
            expect(ports.receipt).not.toHaveBeenCalled()
            expect(ports.answer).not.toHaveBeenCalled()
        }
    })
    it('refuses supersession during receipt lookup before any write', async () => {
        let active = request
        const ports = { receipt: vi.fn(async () => { active = { ...request, requestId: 'new' }; return null }), answer: vi.fn(async () => receipt) }
        expect((await createStarterTextAnswerAdapter(() => active, ports)(request, 'Bookkeeping')).status).toBe('stale')
        expect(ports.answer).not.toHaveBeenCalled()
    })
    it('does not retry an ambiguous write and refuses conflicting receipts', async () => {
        const ports = { receipt: vi.fn(async () => null as StarterReceipt | null), answer: vi.fn(async (): Promise<StarterReceipt> => { throw new Error('lost acknowledgement') }) }
        const submit = createStarterTextAnswerAdapter(() => request, ports)
        expect((await submit(request, 'Bookkeeping')).status).toBe('uncertain')
        expect((await submit(request, 'Bookkeeping')).status).toBe('uncertain')
        expect(ports.answer).toHaveBeenCalledTimes(1)
        ports.receipt.mockResolvedValue({ ...receipt, chatId: 'other' })
        expect((await submit(request, 'Bookkeeping')).status).toBe('uncertain')
        ports.receipt.mockResolvedValue(receipt)
        expect((await submit(request, 'Different')).status).toBe('uncertain')
    })
    it('locks concurrent text submissions while a receipt is being read', async () => {
        let finish!: (value: StarterReceipt | null) => void
        const ports = { receipt: () => new Promise<StarterReceipt | null>(resolve => { finish = resolve }), answer: vi.fn(async () => receipt) }
        const submit = createStarterTextAnswerAdapter(() => request, ports)
        const first = submit(request, 'Bookkeeping')
        expect((await submit(request, 'Bookkeeping')).status).toBe('duplicate')
        finish(receipt)
        expect((await first).status).toBe('confirmed')
        expect(ports.answer).not.toHaveBeenCalled()
    })
})
