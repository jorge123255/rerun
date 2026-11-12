import 'server-only'
import { z } from 'zod'
import { desktopScheduleRevisionSchema } from '@rerun/contracts'
import { Cron } from 'croner'
import type { Client } from '@libsql/client'
import { authenticateDesktopRequest, DesktopHttpError } from '../auth'
import { engineOf } from '../settings'
import { desktopProvider } from '../../settings'
import { findDesktopAgent } from '../store'
import { createSchedule,updateSchedule,deleteSchedule,listSchedules,listRuns,listLatestScheduleRuns,getAgent,EngineRequestError } from '@/lib/engine/client'
import { nextRunAt } from '@/lib/schedules/cron'
import { adoptDesktopScheduledSession } from './adoption'

const input=z.object({name:z.string().trim().min(1).max(120),description:z.string().max(4000).default(''),body:z.string().trim().min(1).max(64000),cron:z.string().max(120).nullable(),runAt:z.string().datetime({offset:true}).nullable(),timezone:z.string().min(1).max(100),enabled:z.boolean(),
    connectionId:z.string().trim().min(1).max(256).nullable().default(null),provider:desktopProvider.nullable().default(null),model:z.string().trim().min(1).max(256).nullable().default(null),
}).strict().superRefine((value,ctx)=>{
    try {new Intl.DateTimeFormat('en',{timeZone:value.timezone});if(Boolean(value.cron)===Boolean(value.runAt))throw new Error();if(value.cron)new Cron(value.cron,{timezone:value.timezone}).nextRun()}catch{ctx.addIssue({code:'custom',message:'Choose a valid cron or one-shot time and timezone'})}
}).superRefine((value,ctx)=>{
    const fields=[value.connectionId,value.provider,value.model]
    if(fields.every(field=>field===null)||fields.every(field=>field!==null))return
    ctx.addIssue({code:'custom',message:'Choose a connected provider and model, or follow the coworker default'})
})
const scheduleSlug = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/)
export type DesktopScheduleInput=z.infer<typeof input>
export type ScheduleAccess=(engineAgentId:string)=>Promise<void>
export const SCHEDULE_BODY_TIMEOUT_MS=10_000
export const SCHEDULE_BODY_CLEANUP_MS=1_000

function abortableRead<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
    return new Promise((resolve,reject)=>{
        const cancel=()=>{signal.removeEventListener('abort',cancel);reject(signal.reason ?? new Error('Task request cancelled'))}
        signal.addEventListener('abort',cancel,{once:true})
        work.then(value=>{signal.removeEventListener('abort',cancel);if(signal.aborted)cancel();else resolve(value)},error=>{signal.removeEventListener('abort',cancel);reject(error)})
        if(signal.aborted)cancel()
    })
}

async function readScheduleBody(request:Request):Promise<unknown> {
    request.signal.throwIfAborted()
    const reader=request.body?.getReader()
    if(!reader)throw new DesktopHttpError(400,'Task body required')
    const deadline=new AbortController(),signal=AbortSignal.any([request.signal,deadline.signal])
    const timer=setTimeout(()=>deadline.abort(new DesktopHttpError(408,'Task request timed out')),SCHEDULE_BODY_TIMEOUT_MS)
    const cancel=()=>{void reader.cancel().catch(()=>{})}
    signal.addEventListener('abort',cancel,{once:true})
    const chunks:Uint8Array[]=[]
    let size=0
    try {
        while(true) {
            signal.throwIfAborted()
            const value=await abortableRead(reader.read(),signal)
            signal.throwIfAborted()
            if(value.done)break
            size+=value.value.byteLength
            if(size>70_000)throw new DesktopHttpError(413,'Task is too large')
            chunks.push(value.value)
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally {
        clearTimeout(timer);signal.removeEventListener('abort',cancel)
        // A hostile/stalled source may never settle cancellation. Cleanup must not turn the
        // bounded body read into an unbounded wait, and late rejection is always observed.
        await new Promise<void>(resolve=>{
            const cleanup=setTimeout(resolve,SCHEDULE_BODY_CLEANUP_MS)
            const done=()=>{clearTimeout(cleanup);resolve()}
            reader.cancel().then(done,done)
        })
    }
}

export function desktopSchedulesApi(db:Client,authorize:ScheduleAccess) {
    return async(request:Request,agentId:string):Promise<Response>=>{
        try {
            const runtime=await authenticateDesktopRequest(request),engine=engineOf(runtime)
            const owner=await findDesktopAgent(db,agentId)
            if(!owner)throw new DesktopHttpError(404,'Coworker not found')
            // Root reader must check current exact identity/enabled/grant, not cached UI settings.
            await authorize(owner.engineAgentId)
            const detail=await getAgent(engine,owner.engineAgentId)
            if(detail.id!==owner.engineAgentId)throw new DesktopHttpError(409,'Coworker identity mismatch')
            let result:unknown
            if(request.method==='GET') {
                const history = new URL(request.url).searchParams.get('history')
                if (history !== null) {
                    const slug = scheduleSlug.parse(history)
                    const runs = await listRuns(engine, owner.engineAgentId, { scheduleSlug: slug }, { signal: request.signal })
                    await authorize(owner.engineAgentId)
                    request.signal.throwIfAborted()
                    result = runs.filter(run => run.agentId === owner.engineAgentId && run.triggerSource === 'schedule' && run.triggerSlug === slug)
                        .map(({ id, status, startedAt }) => ({ id, status, startedAt }))
                } else {
                    const [schedules, runs] = await Promise.all([
                        listSchedules(engine, owner.engineAgentId, { signal: request.signal }),
                        listLatestScheduleRuns(engine, owner.engineAgentId, request.signal),
                    ])
                    await authorize(owner.engineAgentId)
                    request.signal.throwIfAborted()
                    const setup = detail.config.setup
                    const setupPending = setup?.required === true && setup.completedAt === null && detail.install.trim().length > 0
                    result=await Promise.all(schedules.map(async schedule=>{
                        const last = runs.find(run => run.agentId === owner.engineAgentId && run.triggerSource === 'schedule' && run.triggerSlug === schedule.slug)
                        const chat = last ? await adoptDesktopScheduledSession(db, engine, {
                            agentId, engineAgentId: owner.engineAgentId, scheduleSlug: schedule.slug, runId: last.id,
                        }, { signal: request.signal }) : null
                        return { ...schedule, setupPending, nextRunAt: nextRunAt(schedule, new Date()), lastResult: last ? { status: last.status, runId: last.id, chat } : null }
                    }))
                }
            } else {
                const body=await readScheduleBody(request) as {slug?:unknown;input?:unknown;action?:unknown;requestId?:unknown;runId?:unknown;expectedRevision?:unknown}
                request.signal.throwIfAborted()
                await authorize(owner.engineAgentId)
                request.signal.throwIfAborted()
                if(!body || typeof body!=='object')throw new DesktopHttpError(400,'Invalid schedule request')
                const slug=body.slug===undefined ? undefined : scheduleSlug.parse(body.slug)
                if(request.method==='PUT') {
                    const value=input.parse(body.input)
                    result=slug ? await updateSchedule(engine,owner.engineAgentId,slug,value as unknown as Parameters<typeof updateSchedule>[3]) : await createSchedule(engine,owner.engineAgentId,{...value,cron:value.cron ?? undefined,runAt:value.runAt ?? undefined})
                } else if (request.method === 'DELETE' && slug) {
                    if (body.expectedRevision === undefined) {
                        await deleteSchedule(engine, owner.engineAgentId, slug)
                    } else {
                        const expectedRevision = desktopScheduleRevisionSchema.parse(body.expectedRevision)
                        try {
                            await deleteSchedule(engine, owner.engineAgentId, slug, { expectedRevision, signal: request.signal })
                        } catch (error) {
                            if (error instanceof EngineRequestError) {
                                const message = error.status === 412 ? 'This routine changed. Refresh it before deleting.' : 'Could not delete this routine.'
                                throw new DesktopHttpError(error.status, message)
                            }
                            throw error
                        }
                    }
                    result = { deleted: slug }
                }
                else if (request.method === 'POST' && slug && body.action === 'open-run') {
                    const runId = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/).parse(body.runId)
                    result = await adoptDesktopScheduledSession(db, engine, { agentId, engineAgentId: owner.engineAgentId, runId, scheduleSlug: slug }, {
                        signal: request.signal, authorize: () => authorize(owner.engineAgentId),
                    })
                }
                else if(request.method==='POST' && slug && body.action==='run') {
                    const requestId=z.string().uuid().parse(body.requestId)
                    const expectedRevision = desktopScheduleRevisionSchema.optional().parse(body.expectedRevision)
                    const response = await fetch(`${engine.baseUrl}/agents/${encodeURIComponent(owner.engineAgentId)}/schedules/${encodeURIComponent(slug)}/run`, {
                        method: 'POST', redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(120000)]),
                        headers: {
                            Authorization: `Bearer ${engine.apiKey}`,
                            'x-desktop-schedule-request-id': requestId,
                            ...(expectedRevision && { 'x-desktop-schedule-revision': expectedRevision }),
                        },
                    })
                    if (!response.ok) {
                        const message = response.status === 412 ? 'This routine changed. Refresh it before running.' : 'Task could not start'
                        throw new DesktopHttpError(response.status, message)
                    }
                    const ids=z.object({sessionId:z.string(),runId:z.string()}).parse(await response.json())
                    result = await adoptDesktopScheduledSession(db, engine, {
                        agentId, engineAgentId: owner.engineAgentId, engineSessionId: ids.sessionId, runId: ids.runId, scheduleSlug: slug,
                    }, { signal: request.signal, authorize: () => authorize(owner.engineAgentId) })
                } else throw new DesktopHttpError(400,'Invalid schedule action')
            }
            return Response.json(result,{headers:{'Cache-Control':'no-store'}})
        } catch(error) {return Response.json({error:error instanceof DesktopHttpError ? error.message : 'Schedule request failed'}, {status:error instanceof DesktopHttpError ? error.status : 400,headers:{'Cache-Control':'no-store'}})}
    }
}
