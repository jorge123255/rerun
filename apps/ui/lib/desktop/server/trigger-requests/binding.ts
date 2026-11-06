import 'server-only'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { desktopTriggerDeliveryReceiptSchema } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { findDesktopAgent,findDesktopSession } from '../store'
import type { DesktopRuntime } from '../runtime'
import { desktopTriggerEngine } from '../triggers/engine'
import { desktopSecretRequestPorts,probeDesktopSecretAdmission } from '../secret-requests/binding'
import type { TriggerRequestLink,TriggerRequestDecision } from '../../trigger-requests/types'
import { createDesktopTriggerRequests } from './runtime'
import { stopRequestId } from './identity'
import { interceptCanonicalTriggerDecision } from './intercept'
const claims = new Map<string,Promise<unknown>>()
const eventResult = z.strictObject({event:desktopTriggerDeliveryReceiptSchema.nullable()})
const source = (link:TriggerRequestLink) => ({eventId:link.eventId,sessionId:link.engineSessionId,sourceRunId:link.sourceRunId,sourceMessageId:link.sourceMessageId,toolCallId:link.toolCallId,kind:link.kind})
export async function openDesktopTriggerRequests(runtime:DesktopRuntime) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await db.execute({sql:'INSERT INTO desktop_trigger_workspace_identity(id,value) VALUES(1,?) ON CONFLICT(id) DO NOTHING',args:[randomUUID()]})
    const workspaceIdentity = String((await db.execute('SELECT value FROM desktop_trigger_workspace_identity WHERE id=1')).rows[0]?.value ?? '')
    async function owner(engineAgentId:string) {
        const rows = (await db.execute({sql:'SELECT id FROM desktop_agents WHERE workspace_id=1 AND engine_agent_id=?',args:[engineAgentId]})).rows
        if(rows.length!==1) throw new DesktopHttpError(409,'Webhook coworker ownership changed')
        return String(rows[0].id)
    }
    async function command(engineAgentId:string,op:string,input:unknown,signal?:AbortSignal) {
        return desktopTriggerEngine(runtime,{op,localAgentId:await owner(engineAgentId),engineAgentId,input},signal)
    }
    return createDesktopTriggerRequests(runtime,db,{
        workspaceIdentity,
        async readContinuationRuns(link,signal) { return z.strictObject({runs:z.array(z.string().min(1)).max(64)}).parse(await command(link.engineAgentId,'continuations',{eventId:link.eventId,sessionId:link.engineSessionId},signal)).runs },
        async resolveSessionSource(sessionId,signal) {
            const session=await findDesktopSession(db,sessionId),agent=session&&await findDesktopAgent(db,session.agentId)
            if(!session||!agent||agent.workspaceId!==1) throw new DesktopHttpError(404,'Conversation not found')
            const {event}=eventResult.parse(await command(agent.engineAgentId,'session',{sessionId:session.engineSessionId},signal))
            if(!event) return {kind:'ordinary'}
            if(event.localAgentId!==agent.id||event.localSessionId!==session.id||event.engineSessionId!==session.engineSessionId||!event.runId) throw new DesktopHttpError(409,'Webhook conversation mapping changed')
            return {kind:'trigger',target:{workspaceId:workspaceIdentity,agentId:agent.id,engineAgentId:agent.engineAgentId,eventId:event.eventId,slug:event.slug,sessionId:session.id,engineSessionId:session.engineSessionId,triggerRunId:event.runId}}
        },
        async readDelivery(id,eventId,signal) { return eventResult.parse(await command(id,'event',{eventId},signal)).event },
        async withDecisionClaim(link,work) {
            const key=JSON.stringify([runtime.dataRoot,link.agentId,link.engineSessionId]),previous=claims.get(key)??Promise.resolve()
            const pending=previous.catch(()=>{}).then(work); claims.set(key,pending)
            try{return await pending}finally{if(claims.get(key)===pending)claims.delete(key)}
        },
        async assertCurrentRequestPermission(link,signal) { await command(link.engineAgentId,'human-authorize',source(link),signal) },
        async stop(row,signal) { const value=await command(row.link.engineAgentId,'human-stop',{source:source(row.link),requestId:stopRequestId(row.link)},signal); z.strictObject({status:z.literal('stopped')}).parse(value) },
        async stopReceipt(row,signal) { return z.strictObject({status:z.enum(['stopped','unknown'])}).parse(await command(row.link.engineAgentId,'human-stop-receipt',{source:source(row.link),requestId:stopRequestId(row.link)},signal)).status },
        secret:{
            read:(id,signal)=>desktopSecretRequestPorts(runtime,id).read(id,signal),
            probe:(row,signal)=>probeDesktopSecretAdmission(runtime,row.link.sessionId,row.link.requestId,signal),
            decide:(id,input,signal)=>desktopSecretRequestPorts(runtime,id).decide(id,input,signal),
        },
    })
}
export async function interceptDesktopWebhookDecision(runtime:DesktopRuntime,sessionId:string,decision:TriggerRequestDecision) {
    const db=await openDesktopDatabase(runtime.dataRoot)
    return interceptCanonicalTriggerDecision(db,await openDesktopTriggerRequests(runtime),sessionId,decision)
}

export async function recoverDesktopWebhookSecret(runtime: DesktopRuntime, sessionId: string, input: import('@rerun/contracts').DesktopSecretRequestRecovery, signal: AbortSignal) {
    const service = await openDesktopTriggerRequests(runtime), db = await openDesktopDatabase(runtime.dataRoot)
    if (!await service.captureForSession(sessionId)) return desktopSecretRequestPorts(runtime, sessionId).recover(sessionId, input, signal)
    const rows = (await db.execute({ sql: "SELECT link_key FROM desktop_trigger_request_links_v1 WHERE session_id=? AND json_extract(source_json,'$.kind')='secret' AND json_extract(source_json,'$.requestId')=? LIMIT 2", args: [sessionId,input.requestId] })).rows
    if (rows.length !== 1) throw new DesktopHttpError(409, 'The saved webhook credential request could not be linked')
    return service.lifecycle.recoverCanonical(String(rows[0].link_key),input.attemptId,()=>desktopSecretRequestPorts(runtime,sessionId).recover(sessionId,input,signal))
}
