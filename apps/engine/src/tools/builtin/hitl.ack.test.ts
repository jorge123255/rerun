import { describe, expect, it } from 'vitest'
import { createDesktopSecretRequestTool } from '../../desktop/secret-requests/request-secret.js'
import { HITL_ACK, HITL_ACK_CALL_FIRST, hitlAck } from './hitl.js'

describe('the acknowledgement of a card', () => {
    it('tells a model that calls first to write its message now, and leaves a message-first model to judge', () => {
        expect(hitlAck('call-first')).toBe(HITL_ACK_CALL_FIRST)
        expect(hitlAck('message-first')).toBe(HITL_ACK)
        expect(HITL_ACK_CALL_FIRST.instruction).toContain('Write your message now')
        expect(HITL_ACK.instruction).toContain('If you wrote nothing to the user before this call')
    })

    it('reaches the Mac credential request with the order of its run', async () => {
        const run = (ack?: ReturnType<typeof hitlAck>) => {
            const tools = createDesktopSecretRequestTool({ authorize: async () => {} }, ack)
            return (tools.request_secret as { execute: (input: unknown, options: unknown) => Promise<unknown> })
                .execute({ secrets: [{ key: 'API_KEY', label: 'API key' }] }, { toolCallId: 'call-1' })
        }
        expect(await run(hitlAck('call-first'))).toBe(HITL_ACK_CALL_FIRST)
        expect(await run()).toBe(HITL_ACK)
    })
})
