import { describe, expect, it } from 'vitest'
import { createVoiceConversation, VOICE_FILLER, VOICE_SENTENCES, type VoiceSendRefusal } from './conversation'
import type { AgentResponse } from './relay-protocol'
import { delay, fakeChief, until } from './voice.test-support'

const CHAT = { workspaceId: '1', chatId: 'fmc_conversation1' }
const said = (responses: AgentResponse[], eventId?: number) => responses.filter(item => eventId === undefined || item.event_id === eventId).map(item => item.content).join('')
const finals = (responses: AgentResponse[]) => responses.filter(item => item.is_final)

function start(script: Parameters<typeof fakeChief>[0], options: { refusals?: Parameters<typeof fakeChief>[1]; fillerMs?: number } = {}) {
    const fake = fakeChief(script, options.refusals)
    const responses: AgentResponse[] = []
    const conversation = createVoiceConversation({ chat: CHAT, chief: fake.chief, respond: message => responses.push(message), fillerMs: options.fillerMs ?? 40, retryMs: 5 })
    return { ...fake, responses, conversation }
}

describe('a spoken conversation with the Chief of Staff', () => {
    it('sends the last thing the person said through the send path and speaks the reply, ending with an empty final', async () => {
        const { conversation, responses, sent } = start(({ emit, end }) => { emit({ type: 'text', partId: 't1', delta: 'Sure. ' }); emit({ type: 'text', partId: 't1', delta: 'It is done.' }); end() })
        await conversation.transcript([{ role: 'user', content: 'Earlier.' }, { role: 'agent', content: 'Reply.' }, { role: 'user', content: '  Book the room.  ' }], 1)
        await until(() => finals(responses).length === 1)
        expect(sent).toEqual([{ chat: CHAT, requestId: expect.any(String), text: 'Book the room.' }])
        expect(said(responses)).toBe('Sure. It is done. ')
        expect(responses.at(-1)).toEqual({ type: 'agent_response', content: '', event_id: 1, is_final: true })
        expect(responses.every(item => item.event_id === 1)).toBe(true)
    })

    it('says "One moment." when no words come within the wait, and only once', async () => {
        const { conversation, responses } = start(async ({ emit, end }) => { await delay(120); emit({ type: 'text', partId: 'a', delta: 'Here it is.' }); end() })
        await conversation.transcript([{ role: 'user', content: 'Slow one.' }], 4)
        await until(() => finals(responses).length === 1)
        expect(responses[0].content).toBe(VOICE_FILLER)
        expect(said(responses)).toBe(`${VOICE_FILLER}Here it is. `)
    })

    it('speaks plain sentences while the conversation keeps the full markdown', async () => {
        const markdown = '## Summary\nThe **budget** is fine; see [the sheet](https://docs.example.com/x).\n```sql\nselect * from secrets;\n```\nAll good.'
        const { conversation, responses, replies } = start(({ emit, end }) => {
            for (const piece of markdown.match(/[\s\S]{1,7}/g)!) emit({ type: 'text', partId: 'p', delta: piece })
            end()
        })
        await conversation.transcript([{ role: 'user', content: 'Status?' }], 2)
        await until(() => finals(responses).length === 1)
        expect(replies[0]).toBe(markdown)
        expect(said(responses)).toBe('Summary The budget is fine; see the sheet. Code block omitted. All good. ')
        expect(said(responses)).not.toMatch(/##|\*\*|https|select|```/)
    })

    it('a newer utterance stops the run like Stop does and drops what the old run still says', async () => {
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const { conversation, responses, stops, sent } = start(async ({ text, emit, end }) => {
            if (text === 'First question.') {
                emit({ type: 'text', partId: 'a', delta: 'Starting the long answer. ' })
                await gate
                emit({ type: 'text', partId: 'a', delta: 'STALE words that must not be spoken.' })
                end()
                return
            }
            emit({ type: 'text', partId: 'b', delta: 'Answer to the second.' })
            end()
        }, { refusals: [], fillerMs: 1_000 })
        await conversation.transcript([{ role: 'user', content: 'First question.' }], 1)
        await until(() => said(responses, 1).includes('Starting'))
        await conversation.transcript([{ role: 'user', content: 'First question.' }, { role: 'user', content: 'Actually, second.' }], 2)
        release()
        await until(() => finals(responses).some(item => item.event_id === 2))
        await delay(20)
        expect(stops).toEqual([CHAT])
        expect(sent.map(item => item.text)).toEqual(['First question.', 'Actually, second.'])
        expect(responses.some(item => item.content.includes('STALE'))).toBe(false)
        expect(said(responses, 2)).toBe('Answer to the second. ')
        // The interrupted turn never gets a final of its own: ElevenLabs drops its event anyway.
        expect(finals(responses).map(item => item.event_id)).toEqual([2])
    })

    it('waits for a stopped run to settle before sending the next utterance', async () => {
        const refusals: VoiceSendRefusal[] = []
        const { conversation, responses, sent, stops } = start(async ({ text, emit, end }) => {
            if (text === 'One.') { emit({ type: 'text', partId: 'a', delta: 'Working. ' }); return }
            emit({ type: 'text', partId: 'b', delta: 'Two done.' }); end()
        }, { refusals })
        await conversation.transcript([{ role: 'user', content: 'One.' }], 1)
        await until(() => said(responses, 1).length > 0)
        // The app answers "wait for the current message to settle" twice, then takes the message.
        refusals.push('busy', 'busy')
        await conversation.transcript([{ role: 'user', content: 'Two.' }], 2)
        await until(() => finals(responses).some(item => item.event_id === 2))
        expect(stops).toEqual([CHAT])
        expect(sent.map(item => item.text)).toEqual(['One.', 'Two.'])
        expect(said(responses, 2)).toBe('Two done. ')
    })

    it('a repeated or older event changes nothing', async () => {
        const { conversation, responses, sent } = start(({ emit, end }) => { emit({ type: 'text', partId: 'a', delta: 'Once.' }); end() })
        await conversation.transcript([{ role: 'user', content: 'Hi.' }], 5)
        await until(() => finals(responses).length === 1)
        await conversation.transcript([{ role: 'user', content: 'Hi.' }], 5)
        await conversation.transcript([{ role: 'user', content: 'Old.' }], 3)
        expect(sent).toHaveLength(1)
    })

    it('a question card mid-turn is named in one sentence and the response ends; nothing else changes', async () => {
        const { conversation, responses, stops } = start(({ emit, end }) => {
            emit({ type: 'text', partId: 'a', delta: 'Let me check one thing.\n' })
            emit({ type: 'card', card: 'question' })
            emit({ type: 'text', partId: 'b', delta: 'Text after the card is not spoken.' })
            end()
        })
        await conversation.transcript([{ role: 'user', content: 'Set it up.' }], 7)
        await until(() => finals(responses).length === 1)
        await delay(10)
        expect(said(responses)).toBe(`Let me check one thing. ${VOICE_SENTENCES.question}`)
        expect(finals(responses)).toHaveLength(1)
        expect(stops).toEqual([])
    })

    it('an approval card is named the same way', async () => {
        const { conversation, responses } = start(({ emit }) => { emit({ type: 'card', card: 'approval' }) })
        await conversation.transcript([{ role: 'user', content: 'Send it.' }], 1)
        await until(() => finals(responses).length === 1)
        expect(said(responses)).toBe(VOICE_SENTENCES.approval)
    })

    it('a refused send is spoken as one plain sentence', async () => {
        for (const refusal of ['busy', 'waiting', 'model', 'failed'] as const) {
            const { conversation, responses } = start(() => {}, { refusals: [refusal] })
            await conversation.transcript([{ role: 'user', content: 'Hello.' }], 1)
            await until(() => finals(responses).length === 1)
            expect(said(responses)).toBe(VOICE_SENTENCES[refusal])
        }
    })

    it('after the call ends nothing more is said', async () => {
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const { conversation, responses, stops } = start(async ({ emit, end }) => { await gate; emit({ type: 'text', partId: 'a', delta: 'Late.' }); end() }, { fillerMs: 5_000 })
        await conversation.transcript([{ role: 'user', content: 'Hello.' }], 1)
        conversation.close()
        release()
        await delay(20)
        expect(responses).toEqual([])
        expect(stops).toEqual([])
    })
})
