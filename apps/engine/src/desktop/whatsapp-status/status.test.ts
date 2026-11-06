import { describe, expect, it, vi } from 'vitest'
import {
    WHATSAPP_STATUS_DESCRIPTION,
    WHATSAPP_STATUS_OPERATION,
    declaredWhatsappStatusParams,
    whatsappStatusFieldCopy,
    whatsappStatusFieldOrder,
    whatsappStatusInputSchema,
    whatsappStatusSetupCopy,
} from './schema.js'
import * as published from '../../../../../packages/contracts/src/desktop-whatsapp-status.ts'
import { closedWhatsappStatusPorts, desktopWhatsappStatusTools, performWhatsappStatus, whatsappStatusCompilerGate, type WhatsappStatusPorts } from './status.js'

const ready = { phase: 'ready' as const, accountId: 'acct_1', connectionId: '11111111-1111-4111-8111-111111111111' }
const receipt = { statusId: 'status_1', audienceCount: 2, expiresAt: '2026-11-07T00:00:00.000Z' }

function ports(overrides: Partial<WhatsappStatusPorts> = {}): WhatsappStatusPorts {
    return {
        readBinding: vi.fn(async () => ready),
        dispatch: vi.fn(async () => ({ outcome: 'accepted' as const, receipt })),
        ...overrides,
    }
}

describe('WhatsApp Status', () => {
    it('matches the additive contract until root exports it from the barrel', () => {
        expect(published.WHATSAPP_STATUS_OPERATION).toEqual(WHATSAPP_STATUS_OPERATION)
        expect(published.WHATSAPP_STATUS_DESCRIPTION).toBe(WHATSAPP_STATUS_DESCRIPTION)
        expect(published.whatsappStatusFieldOrder).toEqual(whatsappStatusFieldOrder)
        expect(published.whatsappStatusFieldCopy).toEqual(whatsappStatusFieldCopy)
        expect(published.whatsappStatusSetupCopy).toEqual(whatsappStatusSetupCopy)
    })

    it('keeps only the original fields and drops an injected account id', () => {
        const input = whatsappStatusInputSchema.parse({ message: 'Open today', background_color: '#25D366', font: 0 })
        expect(declaredWhatsappStatusParams({ ...input })).toEqual({ message: 'Open today', background_color: '#25D366', font: 0 })
        expect(whatsappStatusInputSchema.safeParse({ message: 'Open today', account_id: 'someone-else' }).success).toBe(false)
    })

    it('accepts text or a public file and refuses an empty status before dispatch', async () => {
        const gate = ports()
        expect((await performWhatsappStatus({ file: 'https://example.com/promo.jpg' }, gate, new AbortController().signal)).outcome).toBe('posted')
        const empty = ports()
        expect(await performWhatsappStatus({}, empty, new AbortController().signal)).toMatchObject({ outcome: 'refused', posted: false })
        expect(empty.dispatch).not.toHaveBeenCalled()
    })

    it('does not call Linkup for a private file URL, too many numbers, or a font outside 0 to 5', async () => {
        for (const input of [{ file: 'file:///tmp/a.jpg' }, { message: 'Hi', phone_numbers: Array.from({ length: 501 }, () => '+33612345678') }, { message: 'Hi', font: 6 }, { file: 'https://user:secret@example.com/a.jpg' }]) {
            const used = ports()
            expect((await performWhatsappStatus(input, used, new AbortController().signal)).outcome).toBe('refused')
            expect(used.dispatch).not.toHaveBeenCalled()
        }
    })

    it.each(['unbound', 'capability-off', 'credential-missing', 'revoked'] as const)('stays disabled for %s and does not dispatch', async reason => {
        const used = ports({ readBinding: async () => ({ phase: 'disabled', reason }) })
        const result = await performWhatsappStatus({ message: 'Open today' }, used, new AbortController().signal)
        expect(result).toEqual({ outcome: 'refused', posted: false, message: whatsappStatusSetupCopy[reason] })
        expect(used.dispatch).not.toHaveBeenCalled()
    })

    it('posts once through content/create for the selected account', async () => {
        const used = ports()
        const result = await performWhatsappStatus({ message: 'Open today', phone_numbers: ['+33612345678'] }, used, new AbortController().signal)
        expect(result).toEqual({ outcome: 'posted', posted: true, receipt })
        expect(used.dispatch).toHaveBeenCalledTimes(1)
        expect(used.dispatch).toHaveBeenCalledWith(expect.objectContaining({
            operation: WHATSAPP_STATUS_OPERATION,
            accountId: ready.accountId,
            connectionId: ready.connectionId,
            params: { message: 'Open today', phone_numbers: ['+33612345678'] },
        }))
    })

    it('treats a thrown or incomplete receipt as uncertain and does not retry', async () => {
        const thrown = ports({ dispatch: vi.fn(async () => { throw new Error('socket reset') }) })
        expect((await performWhatsappStatus({ message: 'Open today' }, thrown, new AbortController().signal)).outcome).toBe('uncertain')
        expect(thrown.dispatch).toHaveBeenCalledTimes(1)
        const incomplete = ports({ dispatch: async () => ({ outcome: 'accepted', receipt: { statusId: 'status_1' } }) })
        expect((await performWhatsappStatus({ message: 'Open today' }, incomplete, new AbortController().signal)).outcome).toBe('uncertain')
        expect(closedWhatsappStatusPorts.dispatch).toBeTypeOf('function')
    })

    it('cancels before dispatch and becomes uncertain if stop arrives after dispatch starts', async () => {
        const early = new AbortController()
        early.abort()
        const unused = ports()
        expect((await performWhatsappStatus({ message: 'Open today' }, unused, early.signal)).outcome).toBe('cancelled')
        expect(unused.dispatch).not.toHaveBeenCalled()
        const late = new AbortController()
        const used = ports({
            dispatch: async () => {
                late.abort()
                return { outcome: 'accepted' as const, receipt }
            },
        })
        expect((await performWhatsappStatus({ message: 'Open today' }, used, late.signal)).outcome).toBe('uncertain')
    })

    it('hides the model tool until Apps is on and an account is bound, and does not authorize a local MCP method', async () => {
        const context = { agent: { config: { enabled: true, tools: { desktopToolGrants: { services: true } } } }, abortSignal: new AbortController().signal, runId: 'run' } as never
        const off = await desktopWhatsappStatusTools({ ...context, agent: { config: { enabled: true, tools: { desktopToolGrants: { services: false } } } } })
        expect(off).toEqual({})
        expect(await desktopWhatsappStatusTools(context, closedWhatsappStatusPorts)).toEqual({})
        const on = await desktopWhatsappStatusTools(context, ports())
        expect(on.whatsapp_pro_post_status).toBeTypeOf('object')
        expect(whatsappStatusCompilerGate('whatsapp')).toEqual({ slug: 'whatsapp', operation: WHATSAPP_STATUS_OPERATION, localMcpMethod: false })
        expect(whatsappStatusCompilerGate('linkedin')).toBeNull()
    })
})
