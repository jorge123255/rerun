import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import { z } from 'zod'
import { DESKTOP_SETUP_DEFAULT_PROMPT, desktopTemplateDetailSchema, desktopTemplateInstallResultSchema, desktopTemplateOperationSchema, desktopTemplateRevisionSchema, desktopSetupMutationResultSchema, foremanModelRefSchema, providerSchema, type DesktopTemplateOperation } from '@rerun/contracts'
import { EngineRequestError, getAgent, request } from '@/lib/engine/client'
import { installWithFocus } from '@/lib/foreman/starter-pack'
import { usableConnection } from '../../chat-model'
import type { DesktopSpaceWrite } from '../../spaces'
import { DesktopHttpError } from '../auth'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { setDesktopCoworkerEnabled } from '../coworker-enabled'
import { withRosterWrite } from '../roster-writes'
import { readDesktopRuntime, type DesktopRuntime } from '../runtime'
import { engineOf, readDesktopProviders } from '../settings'
import { desktopBoardRevisionWrite, desktopPlacementInsert, planDesktopAgentPlacement, firstVacantDesktopSpacePosition, readDesktopBoardState, writeDesktopBoardState } from '../spaces'
import { findDesktopAgent } from '../store'
import { mutateDesktopSetup, readDesktopSetupView } from '../setup/service'
import { desktopTemplateAuthority } from '../templates/authority'
import { commitDesktopTemplateInstall } from '../templates/commit'
import { prepareTemplateIntent } from '../templates/intents'
import { createDesktopTemplateServer, type DesktopTemplateEngineClient } from '../templates/server'
import { ForemanRefusal, type ForemanCreationAuthority, type ForemanSetupAuthority, type ForemanReceipt } from './authority'

// Root installs this in its numbered app.db migration. No secondary database or lazy schema.
export const DESKTOP_FOREMAN_CREATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_foreman_creation_receipts (
 request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','complete')), payload TEXT NOT NULL, result TEXT,
 created_at TEXT NOT NULL
);`
const uuid = z.uuid()
const boxBody = z.strictObject({ requestId: uuid, name: z.string().trim().min(1).max(60), order: z.number().int().nonnegative() })
const coworkerBody = z.strictObject({ requestId: uuid, spaceId: uuid, name: z.string().min(1).max(60), description: z.string().max(2000), soulMd: z.string().min(1).refine(text => Buffer.byteLength(text,'utf8') <= 24*1024), installMd: z.string().min(1).refine(text => Buffer.byteLength(text,'utf8') <= 24*1024), model: foremanModelRefSchema })
const templateBody = z.strictObject({ requestId: uuid, templateId: z.string().regex(/^[a-f0-9]{32}$/), templateRevision: desktopTemplateRevisionSchema.optional(), spaceId: uuid, focus: z.string().min(1).max(2000).optional() })
const setupBody = z.strictObject({ requestId: uuid, agentId: uuid })
const boxResult = z.strictObject({ spaceId: uuid })
const coworkerResult = z.strictObject({ agentId: uuid, spaceId: uuid, engineAgentId: z.string().min(1) })
const templateResult = z.strictObject({ agentIds: z.array(uuid).min(1), spaceId: uuid, engineAgentIds: z.array(z.string().min(1)).min(1), importReceiptId:uuid, templateId:z.string(), revision:z.string() })
const setupResult = z.strictObject({ sessionId: uuid })
const setupWire = z.object({ revision: z.string(), prompt: z.string(), required: z.boolean().nullable(), sessionId: z.string().nullable(), completedAt: z.string().nullable() })
const engineCreationReceipt = z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('present'), id: z.string(), input: z.object({ name: z.string(), displayName: z.string().optional(), description: z.string().optional(), enabled: z.boolean(), connectionId: z.string(), model: z.string() }), instructions: z.strictObject({ soulMd: z.string(), installMd: z.string() }) }),
    z.strictObject({ state: z.enum(['absent','unknown','replaced']) }),
])
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    return JSON.stringify(value)
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const changed = () => new DesktopHttpError(409, 'This saved Foreman operation changed. Its existing items were preserved.')
const uncertain = () => new DesktopHttpError(503, 'This Foreman operation was not confirmed. Retry the same attempt.')
type Saved = { requestId: string; kind: string; body: unknown; state: 'pending'|'complete'; payload: Record<string, unknown>; result: unknown }
type Reader = Pick<Client, 'execute'> | Transaction
async function saved(db: Reader, requestId: string): Promise<Saved | null> {
    const row = (await db.execute({ sql: 'SELECT * FROM desktop_foreman_creation_receipts WHERE request_id=?', args: [requestId] })).rows[0]
    if (!row) return null
    const body: unknown = JSON.parse(String(row.body))
    if (hash(body) !== row.fingerprint) throw changed()
    return { requestId, kind: String(row.kind), body, state: row.state as Saved['state'], payload: JSON.parse(String(row.payload)), result: row.result == null ? null : JSON.parse(String(row.result)) }
}
async function reserve(db: Client, kind: string, body: { requestId: string }, payload: Record<string, unknown> = {}) {
    await db.execute({ sql: "INSERT INTO desktop_foreman_creation_receipts(request_id,kind,fingerprint,body,state,payload,created_at) VALUES(?,?,?,?,'pending',?,?) ON CONFLICT(request_id) DO NOTHING", args: [body.requestId, kind, hash(body), canonical(body), JSON.stringify(payload), new Date().toISOString()] })
    const row = await saved(db, body.requestId)
    if (!row || row.kind !== kind || canonical(row.body) !== canonical(body)) throw changed()
    return row
}
async function payload(db: Reader, row: Saved, next: Record<string, unknown>) {
    const result = await db.execute({ sql: "UPDATE desktop_foreman_creation_receipts SET payload=? WHERE request_id=? AND state='pending' AND payload=?", args: [JSON.stringify(next), row.requestId, JSON.stringify(row.payload)] })
    if (result.rowsAffected !== 1) throw changed()
    row.payload = next
}
async function complete(db: Reader, row: Saved, value: unknown) {
    const result = await db.execute({ sql: "UPDATE desktop_foreman_creation_receipts SET state='complete',result=? WHERE request_id=? AND state='pending'", args: [JSON.stringify(value), row.requestId] })
    if (result.rowsAffected !== 1) throw changed()
    row.state = 'complete'; row.result = value
}
const LOCKS = Symbol.for('rerun.desktop.foreman.creation.v1')
const locks = () => ((globalThis as unknown as Record<symbol,Map<string,Promise<unknown>>>)[LOCKS] ??= new Map())
function exclusive<T>(root: string, id: string, action: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([root,id]), result = (locks().get(key) ?? Promise.resolve()).catch(() => {}).then(action)
    locks().set(key,result)
    const clear = () => { if (locks().get(key) === result) locks().delete(key) }
    void result.then(clear,clear); return result
}
function stableId(requestId: string, role: string) {
    const raw = hash([requestId,role]); return `${raw.slice(0,8)}-${raw.slice(8,12)}-4${raw.slice(13,16)}-a${raw.slice(17,20)}-${raw.slice(20,32)}`
}

export async function createDesktopForemanCreationAuthority(runtime: DesktopRuntime, db: Client): Promise<{ creation: ForemanCreationAuthority; setup: ForemanSetupAuthority }> {
    const engine = engineOf(runtime)
    const engineClient: DesktopTemplateEngineClient = {
        get: (path,signal) => request(engine,path,{ method:'GET',signal }, value => value),
        post: (path,body,signal) => request(engine,path,{ method:'POST',body:JSON.stringify(body),signal }, value => value),
    }
    async function current() {
        const now = await readDesktopRuntime()
        if (canonical(now) !== canonical(runtime)) throw new ForemanRefusal('workspace_changed','The workspace changed. Reopen the Foreman.')
    }
    async function templateDetail(templateId: string, revision?: string) {
        const path = '/desktop/templates/' + encodeURIComponent(templateId) + (revision ? '?revision=' + encodeURIComponent(revision) : '')
        const replaced = () => new ForemanRefusal('template_failed', 'The selected template revision is unavailable. Review the current template before installing it.')
        const detail = await engineClient.get(path).then(data => desktopTemplateDetailSchema.parse(data)).catch(error => {
            if (revision && error instanceof EngineRequestError && (error.status === 404 || error.status === 409)) throw replaced()
            throw error
        })
        if (!revision && detail.templateId !== templateId) throw changed()
        if (detail.templateId !== templateId || (revision && detail.revision !== revision)) throw replaced()
        return detail
    }
    async function exactAgent(agentId: string, engineAgentId: string) {
        await assertCoworkerNotDeleting(db,agentId)
        const agent = await findDesktopAgent(db,agentId)
        if (!agent || agent.engineAgentId !== engineAgentId) return false
        const detail = await getAgent(engine,engineAgentId)
        return detail.id === engineAgentId
    }
    async function lookupBox(requestId: string): Promise<ForemanReceipt<{spaceId:string}>> {
        await current()
        const row = await saved(db,uuid.parse(requestId))
        if (!row) return {state:'absent'}
        if (row.kind !== 'box') return {state:'replaced'}
        if (row.state !== 'complete') return {state:'unknown'}
        const result = boxResult.parse(row.result)
        return (await db.execute({sql:'SELECT id FROM desktop_spaces WHERE id=? AND workspace_id=1',args:[result.spaceId]})).rows.length ? {state:'present',value:result} : {state:'replaced'}
    }
    async function lookupCoworker(requestId: string): Promise<ForemanReceipt<{agentId:string;spaceId:string}>> {
        await current()
        const row = await saved(db,uuid.parse(requestId))
        if (!row) return {state:'absent'}
        if (row.kind !== 'coworker') return {state:'replaced'}
        if (row.state !== 'complete') return {state:'unknown'}
        const value = coworkerResult.parse(row.result), body = coworkerBody.parse(row.body)
        try {
            const receipt = engineCreationReceipt.parse(await engineClient.get(`/desktop/agents/foreman-create/${requestId}`))
            if (receipt.state !== 'present' || receipt.id !== value.engineAgentId || receipt.instructions.soulMd !== body.soulMd || receipt.instructions.installMd !== body.installMd || receipt.input.connectionId !== body.model.connectionId || receipt.input.model !== body.model.model) return {state:receipt.state === 'unknown' ? 'unknown' : 'replaced'}
            return await exactAgent(value.agentId,value.engineAgentId) ? {state:'present',value:{agentId:value.agentId,spaceId:value.spaceId}} : {state:'replaced'}
        } catch { return {state:'unknown'} }
    }
    async function lookupTemplateInstall(requestId: string): Promise<ForemanReceipt<{agentIds:string[];spaceId:string}>> {
        await current()
        const row = await saved(db,uuid.parse(requestId))
        if (!row) return {state:'absent'}
        if (row.kind !== 'template') return {state:'replaced'}
        if (row.state !== 'complete') return {state:'unknown'}
        const value = templateResult.parse(row.result), body = templateBody.parse(row.body)
        if (value.agentIds.length !== value.engineAgentIds.length || value.templateId !== body.templateId
            || (body.templateRevision && value.revision !== body.templateRevision)) return {state:'replaced'}
        try {
            const canonicalReceipt = (await db.execute({sql:"SELECT receipt_id,status FROM desktop_template_requests WHERE request_id=? AND operation='install'",args:[requestId]})).rows[0]
            if (canonicalReceipt?.receipt_id !== value.importReceiptId || canonicalReceipt.status !== 'installed') return {state:'replaced'}
            for (let i=0;i<value.agentIds.length;i++) {
                if (!await exactAgent(value.agentIds[i]!,value.engineAgentIds[i]!)) return {state:'replaced'}
                const proof = z.object({state:z.enum(['present','absent','unknown','replaced']),engineAgentId:z.string().optional(),importReceiptId:z.string().optional(),templateId:z.string().optional(),revision:z.string().optional()}).parse(await engineClient.get(`/desktop/templates/foreman-import/${encodeURIComponent(value.engineAgentIds[i]!)}/${value.importReceiptId}`))
                if (proof.state !== 'present' || proof.engineAgentId !== value.engineAgentIds[i] || proof.importReceiptId !== value.importReceiptId || proof.templateId !== value.templateId || proof.revision !== value.revision) return {state:proof.state === 'unknown' ? 'unknown' : 'replaced'}
            }
        }
        catch { return {state:'unknown'} }
        return {state:'present',value:{agentIds:value.agentIds,spaceId:value.spaceId}}
    }
    async function ownedCreatedAgent(agentId: string) {
        const rows = await db.execute("SELECT request_id,kind,result FROM desktop_foreman_creation_receipts WHERE state='complete' AND kind IN ('coworker','template')")
        for (const row of rows.rows) {
            const result: unknown = JSON.parse(String(row.result))
            if (row.kind === 'coworker' && coworkerResult.parse(result).agentId === agentId) {
                if ((await lookupCoworker(String(row.request_id))).state !== 'present') throw changed()
                return coworkerResult.parse(result).engineAgentId
            }
            if (row.kind === 'template') {
                const value = templateResult.parse(result), index = value.agentIds.indexOf(agentId)
                if (index >= 0) {
                    if ((await lookupTemplateInstall(String(row.request_id))).state !== 'present') throw changed()
                    return value.engineAgentIds[index]!
                }
            }
        }
        throw new ForemanRefusal('deleted','This coworker was not created by this saved Foreman build.')
    }
    async function lookupSetup(requestId: string): Promise<ForemanReceipt<{sessionId:string}>> {
        await current()
        const row = await saved(db,uuid.parse(requestId))
        if (!row) return {state:'absent'}
        if (row.kind !== 'setup') return {state:'replaced'}
        const body = setupBody.parse(row.body)
        const engineAgentId = z.string().parse(row.payload.engineAgentId)
        try { if (!await exactAgent(body.agentId,engineAgentId)) return {state:'replaced'} } catch { return {state:'unknown'} }
        let result: {sessionId:string}
        if (row.state === 'complete') result = setupResult.parse(row.result)
        else {
            const canonicalReceipt = (await db.execute({sql:"SELECT agent_id,result FROM desktop_setup_intents WHERE request_id=? AND status='complete'",args:[requestId]})).rows[0]
            if (!canonicalReceipt) return {state:'unknown'}
            if (canonicalReceipt.agent_id !== body.agentId) return {state:'replaced'}
            const canonicalResult = desktopSetupMutationResultSchema.parse(JSON.parse(String(canonicalReceipt.result)))
            result = setupResult.parse({sessionId:canonicalResult.sessionId})
        }
        const session = (await db.execute({sql:'SELECT agent_id FROM desktop_sessions WHERE id=?',args:[result.sessionId]})).rows[0]
        return session?.agent_id === body.agentId ? {state:'present',value:result} : {state:'replaced'}
    }
    const creation: ForemanCreationAuthority = {
        resumePending: async requestId => {
            await current()
            const row = await saved(db,uuid.parse(requestId))
            if (!row || row.state === 'complete') return
            if (row.kind === 'box') await creation.ensureBox(boxBody.parse(row.body))
            else if (row.kind === 'coworker') await creation.createCoworker(coworkerBody.parse(row.body))
            else if (row.kind === 'template') await creation.installTemplate(templateBody.parse(row.body))
            else if (row.kind === 'setup') await setup.startSetup(setupBody.parse(row.body))
            else throw changed()
        },
        lookupBox, lookupCoworker, lookupTemplateInstall,
        async assertTemplateRevision(templateId, revision) {
            await current()
            await templateDetail(templateId, revision)
        },
        ensureBox: raw => exclusive(runtime.dataRoot,raw.requestId,async () => {
            await current(); const body = boxBody.parse(raw)
            let row = await saved(db,body.requestId)
            if (!row) row = await withRosterWrite(async () => {
                const board = await readDesktopBoardState(db), existing = board.spaces.find(space => space.name.trim().toLowerCase() === body.name.toLowerCase())
                const next = await reserve(db,'box',body,existing ? {existingSpaceId:existing.id} : {})
                if (existing && next.state === 'pending') await complete(db,next,{spaceId:existing.id})
                return next
            })
            if (row.kind !== 'box' || canonical(row.body) !== canonical(body)) throw changed()
            if (row.state === 'pending' && row.payload.existingSpaceId) {
                const id = uuid.parse(row.payload.existingSpaceId)
                if (!(await db.execute({sql:'SELECT id FROM desktop_spaces WHERE id=? AND workspace_id=1',args:[id]})).rows.length) throw new ForemanRefusal('replaced','The selected Box was removed.')
                await complete(db,row,{spaceId:id})
            }
            if (row.state === 'complete') {
                const found = await lookupBox(body.requestId)
                if (found.state !== 'present') throw new ForemanRefusal('replaced','The saved Box was removed.')
                return found.value
            }
            // A rejected revision has no board write. The stable request ID and hook ensure an
            // ACK loss always finds the exact committed ID, never a later Box with the same name.
            for (let attempt=0;attempt<3;attempt++) {
                const board = await readDesktopBoardState(db)
                const change: DesktopSpaceWrite = {requestId:body.requestId,expectedRevision:board.revision,command:{kind:'create',name:body.name}}
                await payload(db,row,{change})
                try {
                    await current()
                    await writeDesktopBoardState(db,change,async (tx,before,after) => {
                        const made = after.spaces.filter(space => !before.spaces.some(prior => prior.id === space.id))
                        if (made.length !== 1 || made[0]!.name !== body.name) throw changed()
                        await complete(tx,row!,{spaceId:made[0]!.id})
                    })
                    const found = await lookupBox(body.requestId)
                    if (found.state !== 'present') throw uncertain()
                    return found.value
                } catch (error) {
                    const found = await lookupBox(body.requestId)
                    if (found.state === 'present') return found.value
                    if (!(error instanceof DesktopHttpError) || error.status !== 409 || !error.message.includes('board changed')) throw error
                }
            }
            throw uncertain()
        }),
        createCoworker: raw => exclusive(runtime.dataRoot,raw.requestId,async () => {
            await current(); const body = coworkerBody.parse(raw)
            const row = await reserve(db,'coworker',body,{agentId:randomUUID(),engineAgentId:`new-${body.requestId}`})
            if (row.state === 'complete') {
                const found = await lookupCoworker(body.requestId)
                if (found.state !== 'present') throw changed()
                return {agentId:found.value.agentId}
            }
            const agentId = uuid.parse(row.payload.agentId), engineAgentId = z.string().parse(row.payload.engineAgentId)
            return withRosterWrite(async () => {
                const plan = await planDesktopAgentPlacement(db,body.spaceId).catch(error => {
                    // This capacity check precedes any engine effect. A full/deleted Box is a
                    // definite refusal, not a lost creation acknowledgement.
                    if (!row.payload.input && error instanceof DesktopHttpError && [404,409].includes(error.status)) throw new ForemanRefusal('creation_failed',error.message)
                    throw error
                })
                const board = await readDesktopBoardState(db)
                const occupied = board.placements.filter(item => item.spaceId === body.spaceId).map(item => ({col:item.col,row:item.row}))
                const reservations = await db.execute({sql:"SELECT board_col AS col,board_row AS row FROM desktop_duplicates WHERE completed=0 AND space_id=? UNION ALL SELECT board_col AS col,board_row AS row FROM desktop_creations WHERE phase='reserved' AND space_id=?",args:[body.spaceId,body.spaceId]})
                occupied.push(...reservations.rows.map(item=>({col:Number(item.col),row:Number(item.row)})))
                const intents = await db.execute("SELECT i.operation FROM desktop_template_intents i LEFT JOIN desktop_template_requests r ON r.request_id=i.request_id WHERE r.status IS NULL OR r.status NOT IN ('installed','refused')")
                for (const intent of intents.rows) {
                    const operation = desktopTemplateOperationSchema.parse(JSON.parse(String(intent.operation)))
                    if (operation.operation === 'install' && operation.spaceId === body.spaceId) occupied.push(...operation.positions)
                }
                const pending = await db.execute("SELECT payload FROM desktop_template_requests WHERE operation='install' AND status NOT IN ('installed','refused')")
                for (const item of pending.rows) {
                    const reserved = z.object({spaceId:uuid,coworkers:z.array(z.object({position:z.object({col:z.number(),row:z.number()})}))}).parse(JSON.parse(String(item.payload)))
                    if (reserved.spaceId === body.spaceId) occupied.push(...reserved.coworkers.map(item=>item.position))
                }
                const position = firstVacantDesktopSpacePosition(plan.space,occupied)
                if (!position) {
                    if (row.payload.input) throw uncertain()
                    throw new ForemanRefusal('creation_failed','That Box has no room left. Free a cell in it first.')
                }
                let input = row.payload.input
                if (!input) {
                    const connection = usableConnection((await readDesktopProviders(runtime)).connections,body.model)
                    if (!connection) throw new ForemanRefusal('model_unavailable','The selected model is unavailable. Choose a connected model.')
                    input = {requestId:body.requestId,config:{name:`foreman-${body.requestId}`,displayName:body.name,description:body.description,enabled:false,connectionId:body.model.connectionId,provider:connection.provider,model:body.model.model},instructions:{soulMd:body.soulMd,installMd:body.installMd}}
                    await payload(db,row,{...row.payload,input})
                }
                const exactInput = z.strictObject({requestId:uuid,config:z.strictObject({name:z.string(),displayName:z.string(),description:z.string(),enabled:z.literal(false),connectionId:z.string(),provider:providerSchema,model:z.string()}),instructions:z.strictObject({soulMd:z.string(),installMd:z.string()})}).parse(input)
                const expectedInput = {requestId:body.requestId,config:{name:`foreman-${body.requestId}`,displayName:body.name,description:body.description,enabled:false,connectionId:body.model.connectionId,provider:exactInput.config.provider,model:body.model.model},instructions:{soulMd:body.soulMd,installMd:body.installMd}}
                if (canonical(exactInput) !== canonical(expectedInput)) throw changed()
                await current()
                const created = z.object({id:z.string(),config:z.object({enabled:z.boolean(),connectionId:z.string(),model:z.string(),setup:z.object({required:z.boolean(),completedAt:z.null(),sessionId:z.null()})}),soul:z.string(),install:z.string()}).parse(await engineClient.post('/desktop/agents/foreman-create',exactInput))
                if (created.id !== engineAgentId || created.config.enabled || created.config.connectionId !== body.model.connectionId || created.config.model !== body.model.model || !created.config.setup.required || created.soul !== body.soulMd || created.install !== body.installMd) throw changed()
                await current()
                const tx = await db.transaction('write')
                try {
                    const prior = (await tx.execute({sql:'SELECT engine_agent_id FROM desktop_agents WHERE id=?',args:[agentId]})).rows[0]
                    if (prior) throw changed()
                    const now = new Date().toISOString()
                    await tx.execute({sql:'INSERT INTO desktop_agents(id,workspace_id,engine_agent_id,name,description,enabled,created_at,updated_at) VALUES(?,1,?,?,?,0,?,?)',args:[agentId,engineAgentId,body.name,body.description,now,now]})
                    await tx.execute(desktopPlacementInsert({agentId,spaceId:body.spaceId,...position}))
                    await tx.execute(desktopBoardRevisionWrite)
                    await complete(tx,row,{agentId,engineAgentId,spaceId:body.spaceId})
                    await tx.commit()
                } finally {tx.close()}
                return {agentId}
            })
        }),
        installTemplate: raw => exclusive(runtime.dataRoot,raw.requestId,async () => {
            await current(); const body = templateBody.parse(raw), row = await reserve(db,'template',body)
            if (row.state === 'complete') {
                const found = await lookupTemplateInstall(body.requestId)
                if (found.state !== 'present') throw changed()
                return {agentIds:found.value.agentIds}
            }
            let operation: DesktopTemplateOperation
            if (row.payload.operation) operation = desktopTemplateOperationSchema.parse(row.payload.operation)
            else {
                const reserved = (await db.execute({sql:'SELECT key,operation FROM desktop_template_intents WHERE request_id=?',args:[body.requestId]})).rows[0]
                if (reserved) {
                    operation = desktopTemplateOperationSchema.parse(JSON.parse(String(reserved.operation)))
                    if (operation.operation !== 'install' || reserved.key !== hash({body:{operation:'install',templateId:body.templateId,revision:operation.revision,spaceId:body.spaceId},scopeKey:`foreman:${body.requestId}`})) throw changed()
                }
                else {
                const detail = await templateDetail(body.templateId, body.templateRevision)
                operation = await prepareTemplateIntent(db,engineClient,{operation:{operation:'install',templateId:body.templateId,revision:detail.revision,spaceId:body.spaceId}}, {requestId:body.requestId,scopeKey:`foreman:${body.requestId}`})
                }
                await payload(db,row,{...row.payload,operation})
            }
            if (operation.operation !== 'install' || operation.requestId !== body.requestId || operation.spaceId !== body.spaceId || operation.templateId !== body.templateId
                || (body.templateRevision && operation.revision !== body.templateRevision)) throw changed()
            const canonicalAuthority = desktopTemplateAuthority(runtime)
            const templateServer = createDesktopTemplateServer({db,engine:engineClient,foremanDisabled:true,
                initializeImportedSetup: async input => {
                    await current()
                    await canonicalAuthority.initializeImportedSetup(input)
                    const path = `/agents/${encodeURIComponent(input.engineAgentId)}/setup`
                    const key = `setup:${input.engineAgentId}`
                    let setupInput = row.payload[key]
                    if (!setupInput) {
                        const view = setupWire.parse(await engineClient.get(path))
                        const prompt = input.prompt.trim() || DESKTOP_SETUP_DEFAULT_PROMPT
                        setupInput = {requestId:stableId(body.requestId,key),expectedRevision:view.revision,prompt:body.focus ? installWithFocus(prompt,body.focus) : prompt,required:true}
                        await payload(db,row,{...row.payload,[key]:setupInput})
                    }
                    const result = setupWire.parse(await engineClient.post(`${path}/save`,setupInput))
                    if (result.required !== true || result.completedAt !== null || result.sessionId !== null) throw changed()
                    return {revision:result.revision}
                },
                commitInstalled: async input => {
                    await current()
                    for (const coworker of input.coworkers) {
                        const detail = await getAgent(engine,coworker.engineAgentId)
                        const view = setupWire.parse(await engineClient.get(`/agents/${encodeURIComponent(coworker.engineAgentId)}/setup`))
                        const savedSetup = z.object({prompt:z.string()}).parse(row.payload[`setup:${coworker.engineAgentId}`])
                        if (detail.id !== coworker.engineAgentId || detail.config.enabled || view.required !== true || view.completedAt !== null || view.sessionId !== null || view.prompt.trim() !== savedSetup.prompt.trim()) throw changed()
                    }
                    // Existing transaction checks exact slots and import identities. Every engine
                    // config was already imported disabled; no transient runnable local agent.
                    return commitDesktopTemplateInstall(db,input,{enabled:false,onCommit:tx => complete(tx,row,{agentIds:input.coworkers.map(agent=>agent.agentId),engineAgentIds:input.coworkers.map(agent=>agent.engineAgentId),spaceId:body.spaceId,importReceiptId:input.receiptId,templateId:input.templateId,revision:input.revision})})
                },
            })
            const result = desktopTemplateInstallResultSchema.parse(await templateServer.handle(operation))
            if (result.status !== 'installed' || result.requestId !== body.requestId) throw uncertain()
            const found = await lookupTemplateInstall(body.requestId)
            if (found.state !== 'present') throw uncertain()
            return {agentIds:result.coworkers.map(agent=>agent.id)}
        }),
    }
    const setup: ForemanSetupAuthority = {
        lookupSetup,
        startSetup: raw => exclusive(runtime.dataRoot,raw.requestId,async () => {
            await current(); const body = setupBody.parse(raw)
            let row = await saved(db,body.requestId)
            if (!row) row = await reserve(db,'setup',body,{engineAgentId:await ownedCreatedAgent(body.agentId),enable:'reserved'})
            if (row.kind !== 'setup' || canonical(row.body) !== canonical(body)) throw changed()
            if (row.state === 'complete') {
                const found = await lookupSetup(body.requestId)
                if (found.state !== 'present') throw changed()
                return found.value
            }
            const engineAgentId = z.string().parse(row.payload.engineAgentId)
            if (!await exactAgent(body.agentId,engineAgentId)) throw changed()
            if (row.payload.enable === 'reserved') {
                await payload(db,row,{...row.payload,enable:'submitted'})
                await current()
                await setDesktopCoworkerEnabled(db,engine,body.agentId,true)
                await payload(db,row,{...row.payload,enable:'confirmed'})
            } else {
                const detail = await getAgent(engine,engineAgentId)
                // Never re-enable after an ambiguous first transition: a later human Disable
                // must win. Inspect a successful enable, or leave the action uncertain.
                if (detail.id !== engineAgentId || !detail.config.enabled) throw uncertain()
                if (row.payload.enable !== 'confirmed') await payload(db,row,{...row.payload,enable:'confirmed'})
            }
            let mutation = row.payload.mutation
            if (!mutation) {
                const view = await readDesktopSetupView(runtime,body.agentId)
                if (!view.pending) throw new ForemanRefusal('creation_failed','This coworker no longer has pending setup.')
                mutation = {action:view.sessionId ? 'continue' : 'start',requestId:body.requestId,expectedRevision:view.revision}
                await payload(db,row,{...row.payload,mutation})
            }
            const parsed = z.strictObject({action:z.enum(['start','continue']),requestId:uuid,expectedRevision:z.string()}).parse(mutation)
            await current()
            const result = await mutateDesktopSetup(runtime,body.agentId,parsed)
            if (!result.sessionId) throw uncertain()
            await complete(db,row,{sessionId:result.sessionId})
            return {sessionId:result.sessionId}
        }),
    }
    return {creation,setup}
}
