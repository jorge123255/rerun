import 'server-only'
import type { Client } from '@libsql/client'
import type { EngineConnection } from '@/lib/engine/types'
import { getSession, getRun } from '@/lib/engine/client'
import { findDesktopAgent, sessionOf } from '../store'
import { withRosterWrite } from '../roster-writes'
import { DesktopHttpError } from '../auth'

/** Bound slow dependency implementations as well as native fetch; late reads never adopt. */
export function scheduleRead<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Scheduled history cancelled')) }
        signal.addEventListener('abort', abort, { once: true })
        work.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
        if (signal.aborted) abort()
    })
}

/** Both callback adoption and manual/history adoption use this exact ownership boundary. */
export async function adoptDesktopScheduledSession(db:Client,engine:EngineConnection,input:{agentId:string;engineAgentId:string;engineSessionId:string;runId?:string|null}, options: { signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted()
    const session=await scheduleRead(getSession(engine,input.engineAgentId,input.engineSessionId,options),options.signal)
    if(!session || session.id!==input.engineSessionId || session.agentId!==input.engineAgentId || session.source!=='schedule')throw new DesktopHttpError(409,'Not an owned scheduled conversation')
    if(input.runId) {
        const run=await scheduleRead(getRun(engine,input.engineAgentId,input.runId,options),options.signal)
        if(run.id!==input.runId || run.agentId!==input.engineAgentId || run.sessionId!==session.id || run.triggerSource!=='schedule')throw new DesktopHttpError(409,'Run belongs to another conversation')
    }
    options.signal?.throwIfAborted()
    return scheduleRead(withRosterWrite(async()=>{
        options.signal?.throwIfAborted()
        const owner=await findDesktopAgent(db,input.agentId)
        options.signal?.throwIfAborted()
        if(!owner || owner.engineAgentId!==input.engineAgentId)throw new DesktopHttpError(409,'Coworker identity changed')
        const now=new Date().toISOString()
        const results=await db.batch([{
            sql:`INSERT INTO desktop_sessions(id,agent_id,engine_session_id,title,created_at,updated_at)
                SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM desktop_agents WHERE id=? AND engine_agent_id=? AND workspace_id=1)
                AND NOT EXISTS(SELECT 1 FROM desktop_deletions WHERE agent_id=?)
                ON CONFLICT(engine_session_id) DO NOTHING`,
            args:[crypto.randomUUID(),owner.id,session.id,session.title.slice(0,80),session.createdAt,now,owner.id,input.engineAgentId,owner.id],
        },{sql:'SELECT * FROM desktop_sessions WHERE agent_id=? AND engine_session_id=?',args:[owner.id,session.id]}],'write')
        const row=results[1].rows[0]
        if(!row)throw new DesktopHttpError(409,'Conversation ownership conflict')
        const local=sessionOf(row)
        return {agentId:owner.id,engineAgentId:owner.engineAgentId,sessionId:local.id,engineSessionId:session.id,tabUid:`schedule:${local.id}`,title:local.title,runId:input.runId ?? null}
    }),options.signal)
}

/** Callback payload is authenticated/validated by root before this helper is entered. */
export async function adoptDesktopScheduleEvent(db:Client,engine:EngineConnection,event:{agentId:string;sessionId?:string|null;runId?:string|null}) {
    if(!event.sessionId)return null
    const rows=await db.execute({sql:'SELECT id FROM desktop_agents WHERE workspace_id=1 AND engine_agent_id=?',args:[event.agentId]})
    if(rows.rows.length!==1)throw new DesktopHttpError(409,'No exact local coworker for scheduled session')
    return adoptDesktopScheduledSession(db,engine,{agentId:String(rows.rows[0].id),engineAgentId:event.agentId,engineSessionId:event.sessionId,runId:event.runId})
}

/** Recover callback delivery lost during shutdown; history uses the same durable local session IDs. */
export async function recoverDesktopScheduledChats(db:Client,engine:EngineConnection,agentId:string, options: { signal?: AbortSignal; engineAgentId?: string } = {}) {
    options.signal?.throwIfAborted()
    const owner=await findDesktopAgent(db,agentId)
    if(!owner)throw new DesktopHttpError(404,'Coworker not found')
    if(options.engineAgentId && owner.engineAgentId!==options.engineAgentId)throw new DesktopHttpError(409,'Coworker identity changed')
    const {listSessions}=await import('@/lib/engine/client')
    const sessions=(await scheduleRead(listSessions(engine,owner.engineAgentId,options),options.signal)).filter(s=>s.source==='schedule').slice(0,200)
    const known=await db.execute({sql:'SELECT engine_session_id FROM desktop_sessions WHERE agent_id=?',args:[owner.id]})
    const existing=new Set(known.rows.map(row=>String(row.engine_session_id)))
    const chats=[]
    for(const session of sessions) {
        options.signal?.throwIfAborted()
        if(session.agentId!==owner.engineAgentId)throw new DesktopHttpError(409,'Scheduled history belongs to another coworker')
        if(!existing.has(session.id))chats.push(await adoptDesktopScheduledSession(db,engine,{agentId,engineAgentId:owner.engineAgentId,engineSessionId:session.id},options))
    }
    return chats
}
