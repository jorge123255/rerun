import { describe, expect, it, vi } from 'vitest'
import { createDesktopSubscriptionModel } from './model.js'
import type { openDesktopSubscriptionTurn } from './runtime.js'

type Session = Awaited<ReturnType<typeof openDesktopSubscriptionTurn>>
const options = { provider: 'grok-build', generation: 'fixture-generation', model: 'fixture-model', reasoning: 'high' } as const
const messages = [
    { role: 'system', content: 'Answer briefly' },
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'What comes next?' }] },
] as const

function runner(prompt: Session['prompt']) {
    const session = { prompt: vi.fn(prompt), close: vi.fn(), getSelectors: () => [], selectModel: async () => [] }
    return { session, open: vi.fn(async () => session) }
}

describe('desktop subscription models', () => {
    it('streams the exact selected model and reasoning with the existing conversation', async () => {
        const fixture = runner(async ({ onText }) => {
            onText?.('First')
            onText?.(' reply')
            return { text: 'First reply', stopReason: 'end_turn' }
        })
        const { model, close } = createDesktopSubscriptionModel(options, fixture.open)
        const { stream } = await model.doStream({ prompt: structuredClone([...messages]) })
        expect(await Array.fromAsync(stream)).toMatchObject([
            { type: 'stream-start' },
            { type: 'text-start', id: 'reply' },
            { type: 'text-delta', delta: 'First' },
            { type: 'text-delta', delta: ' reply' },
            { type: 'text-end', id: 'reply' },
            { type: 'finish', finishReason: { unified: 'stop' } },
        ])
        expect(fixture.open).toHaveBeenCalledWith('grok-build', 'fixture-generation', expect.any(AbortSignal))
        const turn = fixture.session.prompt.mock.calls[0]![0]
        expect(turn).toMatchObject({ model: 'fixture-model', reasoning: 'high' })
        expect(JSON.parse(turn.text.split('\n')[1]!)).toEqual([
            { role: 'system', text: 'Answer briefly' },
            { role: 'assistant', text: 'Earlier answer' },
            { role: 'user', text: 'What comes next?' },
        ])
        await close()
    })

    it('refuses attachments before opening the runner', async () => {
        const fixture = runner(async () => { throw new Error('Unexpected prompt') })
        const { model } = createDesktopSubscriptionModel(options, fixture.open)
        await expect(model.doGenerate({ prompt: [{
            role: 'user', content: [{ type: 'file', data: new Uint8Array(), mediaType: 'image/png' }],
        }] })).rejects.toThrow('supports text messages only')
        expect(fixture.open).not.toHaveBeenCalled()
    })

    it('waits for cancellation to drain an active turn', async () => {
        let entered!: () => void
        const prompting = new Promise<void>(resolve => { entered = resolve })
        let settle!: () => void
        const teardown = new Promise<void>(resolve => { settle = resolve })
        const fixture = runner(async ({ signal }) => {
            const stopped = new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }))
            entered()
            await stopped
            await teardown
            signal!.throwIfAborted()
            throw new Error('Unexpected reply')
        })
        const { model, close } = createDesktopSubscriptionModel(options, fixture.open)
        const { stream } = await model.doStream({ prompt: structuredClone([...messages]) })
        await prompting
        const cancel = stream.cancel()
        const drained = close()
        const finished = vi.fn()
        void drained.then(finished)
        await Promise.resolve()
        expect(finished).not.toHaveBeenCalled()
        expect(fixture.session.prompt.mock.calls[0]?.[0].signal?.aborted).toBe(true)
        settle()
        await Promise.all([cancel, drained])
        expect(finished).toHaveBeenCalledOnce()
    })
})
