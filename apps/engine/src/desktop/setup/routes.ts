import { Hono } from 'hono'
import { z } from 'zod'
import { DESKTOP_TEMPLATE_LIMITS } from '@rerun/contracts'
import { agentExists } from '../../agents/loader.js'
import { notFound } from '../../lib/errors.js'
import { claimDesktopSetupSession, continueDesktopSetupSession, DesktopSetupMutationRejected, initializeImportedSetup, readDesktopSetup, saveDesktopSetup } from './service.js'

const mutationInput = z.strictObject({ requestId: z.uuid(), expectedRevision: z.string().min(1) })
const saveInput = mutationInput.extend({ prompt: z.string().max(100_000), required: z.boolean().nullable() })
const importInput = z.strictObject({ agentId: z.uuid(), importReceiptId: z.uuid(), prompt: z.string().max(DESKTOP_TEMPLATE_LIMITS.maxFileBytes), required: z.boolean() })

export const desktopSetupRoutes = new Hono()

desktopSetupRoutes.use('*', async (c, next) => {
    if (!agentExists(c.req.param('id')!)) throw notFound('agent')
    await next()
})

desktopSetupRoutes.get('/', async c => c.json(await readDesktopSetup(c.req.param('id')!)))

desktopSetupRoutes.post('/save', async c => {
    const body = saveInput.parse(await c.req.json().catch(() => null))
    try { return c.json(await saveDesktopSetup(c.req.param('id')!, body)) }
    catch (error) {
        if (error instanceof DesktopSetupMutationRejected) return c.json({ error: error.message, code: 'setup_mutation_rejected' }, 409)
        throw error
    }
})

desktopSetupRoutes.post('/claim', async c => {
    const body = mutationInput.parse(await c.req.json().catch(() => null))
    try {
        const claim = await claimDesktopSetupSession(c.req.param('id')!, body)
        return c.json({ sessionId: 'inFlight' in claim ? claim.inFlight : claim.session.id })
    } catch (error) {
        if (error instanceof DesktopSetupMutationRejected) return c.json({ error: error.message, code: 'setup_mutation_rejected' }, 409)
        throw error
    }
})

// Only the authenticated local template server calls this boundary. The service independently
// proves the immutable manifest and indexed import binding; caller-supplied IDs are not authority.
desktopSetupRoutes.post('/import', async c => {
    const body = importInput.parse(await c.req.json().catch(() => null))
    return c.json(await initializeImportedSetup({ ...body, engineAgentId: c.req.param('id')!, signal: c.req.raw.signal }))
})

desktopSetupRoutes.post('/continue', async c => {
    try {
        const session = await continueDesktopSetupSession(c.req.param('id')!)
        return c.json({ sessionId: session.id })
    } catch {
        return c.json({ error: 'no setup chat is claimed', code: 'no_setup_chat' }, 409)
    }
})
