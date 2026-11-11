import { Hono } from 'hono'
import { RERUN_CONNECTION_ID, boxDefaultUpdateSchema, connectionReasoningOptions, createConnectionSchema, parseDesktopSubscriptionConnectionId, updateConnectionKeysSchema, updateConnectionSchema } from '@rerun/contracts'
import { connectionExists, isConnected, toSummary } from '../../connections/loader.js'
import { findConnection, getConnection, listConnections } from '../../connections/registry.js'
import { assertConnectionDeletable, createConnection, deleteConnection, patchConnection, updateConnectionKeys } from '../../connections/store.js'
import { connectionUsage, releaseConnection } from '../../connections/release.js'
import { clearBoxDefault, readBoxDefault, updateBoxDefault, writeBoxDefault } from '../../connections/default.js'
import { withConnectionLock } from '../../connections/lock.js'
import { servesModel } from '../../connections/resolve.js'
import { defaultModelOf } from '../../agents/availability.js'
import { refreshStaleCodexPlanLimits } from '../../connections/codex-plan-limits.js'
import type { LoadedConnection } from '../../connections/types.js'
import { sendNotification } from '../../runtime/notify.js'
import { assertDesktopProvider, desktopApp, desktopProviderAllowed } from '../../desktop/policy.js'
import { DESKTOP_CODEX_ID } from '../../desktop/codex-runtime.js'
import { selectRegisteredCustomDefault } from '../../desktop/custom-providers/binding.js'
import { badRequest, HttpError } from '../../lib/errors.js'

export const connectionRoutes = new Hono()
const namedDesktopConnection = (id: string) => desktopApp() && /^cnx_/i.test(id)
const NAMED_CONNECTION_REFUSAL = 'Use the named API connection settings. This legacy route cannot change its revision or receipt.'

// Tells the hub the box now runs on the workspace's own AI, which ticks its getting-started step.
// Fire and forget: an unreachable hub never fails the write that just succeeded.
function announceConnected(connection: LoadedConnection): void {
    if (connection.id === RERUN_CONNECTION_ID || !isConnected(connection)) return
    void sendNotification({ event: 'box.connection.connected', kind: 'info', agentId: null, message: connection.config.provider })
}

connectionRoutes.get('/', async c => {
    const all = await listConnections()
    const connections = desktopApp() ? all.filter(connection => desktopProviderAllowed(connection.config.provider, connection.id)) : all
    refreshStaleCodexPlanLimits(connections)
    return c.json({ connections: connections.map(toSummary), default: await readBoxDefault() })
})

// Registered before `/:id`: Hono matches same-method routes in registration order, so `/default`
// would otherwise be read as a connection id.
connectionRoutes.put('/default', async c => {
    const { connectionId, model, reasoningEffort, customReasoningRevision } = boxDefaultUpdateSchema.parse(await c.req.json())
    if (namedDesktopConnection(connectionId)) return c.json({ error: 'Named API model selection is unavailable. The workspace default was not changed.' }, 409)
    const subscription = parseDesktopSubscriptionConnectionId(connectionId)
    if (desktopApp() && (connectionId === DESKTOP_CODEX_ID || subscription)) {
        return withConnectionLock(connectionId, async () => {
            const connection = await findConnection(connectionId)
            if (!connection) return c.json({ error: 'connection not found' }, 404)
            assertDesktopProvider(connection.config.provider, connectionId)
            if (connection.config.provider !== (subscription?.provider ?? 'codex') || !isConnected(connection) || !servesModel(connection, model)) {
                return c.json({ error: subscription ? 'Choose a model from the connected subscription.' : 'Choose a model from the connected Codex account.' }, 400)
            }
            const supported = connectionReasoningOptions(connection.config, model)?.supported ?? []
            return c.json(await updateBoxDefault(current => {
                if (reasoningEffort !== undefined) {
                    if (current?.connectionId !== connectionId || current.model !== model) throw new HttpError(409, 'The selected model has changed. Choose the effort for the current model.')
                    if (reasoningEffort && !supported.includes(reasoningEffort)) throw badRequest('Choose a reasoning effort supported by this model.')
                }
                const effort = reasoningEffort === undefined && current?.connectionId === connectionId ? current.reasoningEffort : reasoningEffort
                return { connectionId, model, ...(effort && supported.includes(effort) && { reasoningEffort: effort }) }
            }))
        })
    }
    return selectRegisteredCustomDefault(connectionId, async () => {
        const connection = await findConnection(connectionId)
        if (!connection) return c.json({ error: 'connection not found' }, 404)
        assertDesktopProvider(connection.config.provider, connection.id)
        if (desktopApp() && !isConnected(connection)) return c.json({ error: 'Connect this provider first.' }, 400)
        if (!servesModel(connection, model)) return c.json({ error: `This connection does not offer ${model}` }, 400)
        if (reasoningEffort !== undefined) {
            if (!desktopApp() || !connection.custom) return c.json({ error: 'This connection does not offer reasoning controls.' }, 400)
            const revision = connection.custom.revision
            if (customReasoningRevision !== revision) return c.json({ error: 'The provider connection changed. Refresh its models before choosing an effort.' }, 409)
            if (reasoningEffort !== null && !connectionReasoningOptions(connection.config, model)?.supported.includes(reasoningEffort))
                return c.json({ error: 'Choose a reasoning effort supported by this model.' }, 400)
            return c.json(await updateBoxDefault(current => {
                if (current?.connectionId !== connectionId || current.model !== model)
                    throw new HttpError(409, 'The selected model has changed. Choose the effort for the current model.')
                return { connectionId, model, ...(reasoningEffort && { reasoningEffort, customReasoningRevision: revision }) }
            }))
        }
        return c.json(await writeBoxDefault({ connectionId, model }))
    })
})

connectionRoutes.delete('/default', async c => {
    await clearBoxDefault()
    return c.json({ default: null })
})

connectionRoutes.post('/', async c => {
    const body = createConnectionSchema.parse(await c.req.json())
    const connection = await createConnection(body)
    await adoptBoxDefault(connection)
    announceConnected(connection)
    return c.json(toSummary(connection), 201)
})

connectionRoutes.patch('/:id', async c => {
    const id = c.req.param('id')
    if (namedDesktopConnection(id)) return c.json({ error: NAMED_CONNECTION_REFUSAL }, 409)
    if (!connectionExists(id)) return c.json({ error: 'connection not found' }, 404)
    const patch = updateConnectionSchema.parse(await c.req.json())
    const connection = await patchConnection(id, patch)
    // Switching off the model the box default names would leave every agent that picked nothing
    // dropping to Rerun with nothing on screen saying so. This is the one write that can see it.
    const boxDefault = await readBoxDefault()
    if (boxDefault?.connectionId === id && !servesModel(connection, boxDefault.model)) await writeBoxDefault({ connectionId: id, model: defaultModelOf(connection) })
    return c.json(toSummary(connection))
})

connectionRoutes.patch('/:id/keys', async c => {
    const id = c.req.param('id')
    if (namedDesktopConnection(id)) return c.json({ error: NAMED_CONNECTION_REFUSAL }, 409)
    if (!connectionExists(id)) return c.json({ error: 'connection not found' }, 404)
    if (desktopApp() && (await getConnection(id)).config.provider === 'codex') return c.json({ error: 'Use ChatGPT sign-in in Settings.' }, 400)
    const body = updateConnectionKeysSchema.parse(await c.req.json())
    const keys = await updateConnectionKeys(id, body)
    const connection = await getConnection(id)
    await adoptBoxDefault(connection)
    announceConnected(connection)
    return c.json({ keys })
})

// What a delete would move back onto the box default, so the UI can name it before it happens.
connectionRoutes.get('/:id/usage', async c => {
    const id = c.req.param('id')
    if (!connectionExists(id)) return c.json({ error: 'connection not found' }, 404)
    return c.json(await connectionUsage(id))
})

connectionRoutes.delete('/:id', async c => {
    const id = c.req.param('id')
    if (namedDesktopConnection(id)) return c.json({ error: NAMED_CONNECTION_REFUSAL }, 409)
    if (!connectionExists(id)) return c.json({ error: 'connection not found' }, 404)
    // Before the release, not after: detaching every agent and then refusing the delete would leave
    // the box worse off than a plain refusal.
    assertConnectionDeletable(id)
    const released = await releaseConnection(id)
    await deleteConnection(id)
    return c.json({ deleted: id, released })
})

// Plugging the first credential into a box is the whole setup, and on its own it changes nothing:
// with no default written, the resolution ladder keeps every agent on the keyless Rerun connection
// until someone finds the star in the connection detail. So the first one adopts the default.
//
// Only while nothing else is plugged in — moving the default onto a connection added next to a
// working one would move the bill without anyone asking.
async function adoptBoxDefault(connection: LoadedConnection): Promise<void> {
    if (connection.id === RERUN_CONNECTION_ID || !isConnected(connection)) return
    if (await readBoxDefault()) return
    const others = (await listConnections()).filter(c => c.id !== connection.id && c.id !== RERUN_CONNECTION_ID)
    if (others.some(isConnected)) return
    const model = defaultModelOf(connection)
    // `defaultModelOf` falls back to the provider default on a connection offering nothing, and a
    // pair no list serves would star a row the UI never shows.
    if (!servesModel(connection, model)) return
    await writeBoxDefault({ connectionId: connection.id, model })
}
