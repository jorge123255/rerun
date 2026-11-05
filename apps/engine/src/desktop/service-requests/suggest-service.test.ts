import { describe, expect, it } from 'vitest'
import { desktopServiceRequestFingerprint, findDesktopServiceRequest, parseDesktopServiceRequestInput, type DesktopServiceRequestRow } from '@rerun/contracts'
import type { RunContext } from '../../runtime/context.js'
import { HITL_ACK } from '../../tools/builtin/hitl.js'
import { decideDesktopServiceRequestTurn, desktopServicePendingMessage } from './admission.js'
import { desktopSuggestServiceTools } from './suggest-service.js'

const options = { messages: [], toolCallId: 'service-test' }
const granted = { enabled: true, tools: { suggestService: true, desktopToolGrants: { suggestService: true, services: false } } }

function context(config = granted, abortSignal?: AbortSignal): RunContext {
    return { agent: { id: 'alpha', config }, turnOrder: 'call-first', abortSignal } as RunContext
}

function call(input: unknown, name = 'suggest_service'): DesktopServiceRequestRow {
    return { id: 'message-1', role: 'assistant', createdAt: '2026-04-01T00:00:00.000Z', contentJson: JSON.stringify([{ type: 'tool-call', toolCallId: 'call-1', toolName: name, input }]) }
}

function delivered(ok = true): DesktopServiceRequestRow {
    return { id: 'result-1', role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolCallId: 'call-1', output: ok ? { status: 'delivered' } : { type: 'error-text', value: 'Rejected' } }]) }
}

describe('desktop suggest_service', () => {
    it('rejects duplicate slugs before the acknowledgement and does not enable Apps', async () => {
        expect(desktopSuggestServiceTools(context({ ...granted, tools: { suggestService: true, desktopToolGrants: { services: true } } }))).toEqual({})
        expect(desktopSuggestServiceTools(context({ ...granted, enabled: false }))).toEqual({})
        const tools = desktopSuggestServiceTools(context(), async () => granted)
        const suggest = tools.suggest_service!
        await expect(suggest.execute!({ services: [{ slug: 'notion' }, { slug: 'notion', reason: 'again' }] }, options)).rejects.toThrow('Duplicate slugs were not delivered')
        await expect(suggest.execute!({ services: [{ slug: 'notion@abcdef' }] }, options)).rejects.toThrow('exact catalog slugs')
        expect(await suggest.execute!({ services: [{ slug: 'notion', reason: 'pages' }, { slug: 'slack' }] }, options)).toEqual(HITL_ACK)
        expect(suggest.description).toContain('END YOUR TURN')
    })

    it('stops when the turn is aborted or the grant is no longer on', async () => {
        const aborted = new AbortController()
        aborted.abort()
        const stopped = desktopSuggestServiceTools(context(granted, aborted.signal), async () => granted)
        await expect(stopped.suggest_service!.execute!({ services: [{ slug: 'notion' }] }, options)).rejects.toThrow(/abort/i)
        const during = new AbortController()
        const mid = desktopSuggestServiceTools(context(granted, during.signal), async () => { during.abort(); return granted })
        await expect(mid.suggest_service!.execute!({ services: [{ slug: 'notion' }] }, options)).rejects.toThrow(/abort/i)
        const revoked = desktopSuggestServiceTools(context(), async () => ({ enabled: true, tools: { desktopToolGrants: { suggestService: false, services: true } } }))
        await expect(revoked.suggest_service!.execute!({ services: [{ slug: 'notion' }] }, options)).rejects.toThrow('turned off')
        const disabled = desktopSuggestServiceTools(context(), async () => ({ ...granted, enabled: false }))
        await expect(disabled.suggest_service!.execute!({ services: [{ slug: 'notion' }] }, options)).rejects.toThrow('turned off')
        const missing = desktopSuggestServiceTools(context(), async () => null)
        await expect(missing.suggest_service!.execute!({ services: [{ slug: 'notion' }] }, options)).rejects.toThrow('turned off')
    })

    it('admits one matching follow-up and blocks an ordinary turn while the card is waiting', () => {
        const input = { services: [{ slug: 'notion', reason: 'pages' }] }
        const rows = [call(input), delivered()]
        const pending = findDesktopServiceRequest(rows)!
        expect(pending.fingerprint).toBe(desktopServiceRequestFingerprint(pending.services))
        expect(parseDesktopServiceRequestInput({ services: [{ slug: 'notion' }, { slug: 'notion' }] })).toEqual({ ok: false, reason: 'duplicate-slug' })
        expect(findDesktopServiceRequest([call({ services: [{ slug: 'notion' }, { slug: 'notion' }] }), delivered()])).toBeNull()
        expect(findDesktopServiceRequest([call(input)])).toBeNull()
        expect(findDesktopServiceRequest([call(input), delivered(false)])).toBeNull()
        expect(findDesktopServiceRequest([...rows, { id: 'later', role: 'user', contentJson: JSON.stringify([{ type: 'text', text: 'stop' }]) }])).toBeNull()
        expect(findDesktopServiceRequest([...rows, call({ name: 'keep' }, 'skill_propose'), delivered()])?.toolCallId).toBe('call-1')
        const service = { sourceMessageId: pending.sourceMessageId, toolCallId: pending.toolCallId, fingerprint: pending.fingerprint }
        expect(decideDesktopServiceRequestTurn({ rows, queued: { service } })).toEqual({ kind: 'admit' })
        expect(decideDesktopServiceRequestTurn({ rows, queued: { service, question: {} } }).kind).toBe('reject')
        expect(decideDesktopServiceRequestTurn({ rows, queued: { service: { ...service, fingerprint: 'other' } } })).toMatchObject({ status: 409, code: 'service_mismatch' })
        expect(decideDesktopServiceRequestTurn({ rows, queued: {} })).toMatchObject({ kind: 'block', code: 'service_pending', error: desktopServicePendingMessage })
        expect(decideDesktopServiceRequestTurn({ rows: [], queued: {} })).toEqual({ kind: 'not-service' })
    })
})
