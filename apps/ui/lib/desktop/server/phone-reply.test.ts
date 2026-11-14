import { expect, test } from 'vitest'
import { phoneReplyStream } from './phone-reply'

test('only the selected run’s visible text is sent to the phone', async () => {
    const chunks = [
        { type: 'start', messageId: 'another-run' },
        { type: 'text-delta', id: 'a', delta: 'Another reply' },
        { type: 'start', messageId: 'phone-run' },
        { type: 'reasoning-delta', id: 'a', delta: 'Private reasoning' },
        { type: 'text-delta', id: 'answer', delta: 'Here ' },
        { type: 'tool-input-start', toolCallId: 'tool', toolName: 'private tool' },
        { type: 'text-delta', id: 'answer', delta: 'is the answer.' },
        { type: 'text-delta', id: 'next', delta: 'A second paragraph.' },
        { type: 'error', errorText: 'Private provider error' },
    ]
    const data = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    const response = new Response(phoneReplyStream(new Response(data).body!, 'phone-run'))
    expect((await response.text()).trim().split('\n').map(line => JSON.parse(line))).toEqual([
        { reset: true }, { delta: 'Here ' }, { delta: 'is the answer.' }, { delta: '\n\nA second paragraph.' },
    ])
})
