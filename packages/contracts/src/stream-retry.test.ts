import { expect, it } from 'vitest'
import { reconnectingProvider, STREAM_RETRY_PART } from './stream-retry.js'

const part = (data: unknown) => ({ type: STREAM_RETRY_PART, id: 'stream-retry-run', data })

it('names the provider only while the last retry part says reconnecting', () => {
    expect(reconnectingProvider([])).toBeNull()
    expect(reconnectingProvider([part({ status: 'reconnecting', provider: 'Anthropic', attempt: 1, of: 3 })])).toBe('Anthropic')
    expect(reconnectingProvider([part({ status: 'reconnecting', provider: 'Anthropic', attempt: 1, of: 3 }), { type: 'reasoning', text: '' }, part({ status: 'resumed', provider: 'Anthropic' })])).toBeNull()
    expect(reconnectingProvider([part({ status: 'failed', provider: 'Anthropic' })])).toBeNull()
})

it('ignores a part that is not what the engine writes', () => {
    expect(reconnectingProvider([part({ status: 'reconnecting', provider: '', attempt: 1, of: 3 })])).toBeNull()
    expect(reconnectingProvider([part({ status: 'reconnecting', provider: 'Anthropic', attempt: 0, of: 3 })])).toBeNull()
    expect(reconnectingProvider([part(null), { type: 'text', text: 'Reconnecting to Anthropic' }])).toBeNull()
})
