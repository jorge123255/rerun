import { Hono } from 'hono'
import { z } from 'zod'
import { agentExists } from '../../agents/loader.js'
import { notFound } from '../../lib/errors.js'
import { claimDesktopSetupSession, continueDesktopSetupSession, readDesktopSetup, saveDesktopSetup } from './service.js'

const saveInput = z.strictObject({ prompt: z.string().max(100_000), required: z.boolean().nullable() })

export const desktopSetupRoutes = new Hono()

desktopSetupRoutes.use('*', async (c, next) => {
    if (!agentExists(c.req.param('id')!)) throw notFound('agent')
    await next()
})

desktopSetupRoutes.get('/', async c => c.json(await readDesktopSetup(c.req.param('id')!)))

desktopSetupRoutes.post('/save', async c => {
    const body = saveInput.parse(await c.req.json().catch(() => null))
    return c.json(await saveDesktopSetup(c.req.param('id')!, body))
})

desktopSetupRoutes.post('/claim', async c => {
    const claim = await claimDesktopSetupSession(c.req.param('id')!)
    if ('inFlight' in claim) return c.json({ error: 'the installation is already under way in another conversation', code: 'install_in_flight', sessionId: claim.inFlight }, 409)
    return c.json({ sessionId: claim.session.id })
})

desktopSetupRoutes.post('/continue', async c => {
    try {
        const session = await continueDesktopSetupSession(c.req.param('id')!)
        return c.json({ sessionId: session.id })
    } catch {
        return c.json({ error: 'no setup chat is claimed', code: 'no_setup_chat' }, 409)
    }
})
