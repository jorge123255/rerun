import {createHash} from 'node:crypto'
import {assertTarget} from '../isolated-screen/identity.js'
import type {ScreenTarget} from '../isolated-screen/types.js'
import type {LauncherAttemptStore,LauncherInvocation,LauncherPorts} from './ports.js'
import {launcherRequestSchema,launcherOperationSchema,guestLauncherReplySchema,LauncherRefusal} from './contract.js'
import type {DesktopComputerLauncherOutcome as Outcome} from '@rerun/contracts'
export const LAUNCHER_LIMITS={operationMs:25_000,guestMs:12_000,settleMs:2_000,attemptsPerGeneration:256} as const
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sameTarget=(a:ScreenTarget,b:ScreenTarget)=>a.engineAgentId===b.engineAgentId&&a.launchNonce===b.launchNonce&&a.sessionGeneration===b.sessionGeneration
export function createComputerLaunchers(ports:LauncherPorts,store:LauncherAttemptStore){
    async function open(invocation:LauncherInvocation,raw:unknown,stop:AbortSignal):Promise<Outcome>{
        const request=launcherRequestSchema.parse(raw)
        assertTarget(invocation.target)
        const operation=launcherOperationSchema.parse({requestId:invocation.requestId,agentId:invocation.agentId,sessionId:invocation.sessionId,runId:invocation.runId,generation:invocation.target.sessionGeneration,app:request.app})
        const fingerprint=hash([operation.requestId,operation.agentId,operation.sessionId,operation.runId,operation.generation,operation.app,invocation.target.engineAgentId,invocation.target.launchNonce]),operationId=hash(['computer-launcher-v1',operation.requestId])
        const signal=AbortSignal.any([stop,AbortSignal.timeout(LAUNCHER_LIMITS.operationMs)])
        const authorize=async()=>{signal.throwIfAborted();await ports.authorize(invocation,request.app,signal);signal.throwIfAborted()}
        await authorize()
        const reservation=await store.reserve({version:1,operation,fingerprint,operationId,phase:'reserved',outcome:null})
        const attempt=reservation.attempt
        if(attempt.fingerprint!==fingerprint||attempt.operationId!==operationId)throw new LauncherRefusal('refused','This launcher request belongs to another operation.')
        await authorize()
        return ports.withControl(invocation,signal,async(control,active)=>{
            const check=async()=>{active.throwIfAborted();await authorize();if(!sameTarget(control.target,invocation.target))throw new LauncherRefusal('interrupted','The isolated screen has changed.');await control.check(active);active.throwIfAborted()}
            await check()
            // Reserve submission durably before sending. Uncertain attempts only reconcile.
            const mode=reservation.created?'launch':'reconcile'
            if(reservation.created)await store.submitted(attempt)
            await check()
            const reply=guestLauncherReplySchema.parse(await control.guest({op:'computer-launcher',operationId,fingerprint,app:request.app,mode},active))
            await check()
            if(reply.operationId!==operationId||reply.fingerprint!==fingerprint||reply.app!==request.app)throw new LauncherRefusal('interrupted','The launcher acknowledgement is stale.')
            if((reply.status==='opened'||reply.status==='focused')&&!reply.windowId)throw new LauncherRefusal('interrupted','No visible app window was acknowledged.')
            const outcome:Outcome={requestId:operation.requestId,app:request.app,status:reply.status,acknowledged:true}
            // Outcome is durable before screenshot publication. Screenshots are never replayed.
            await store.settle(attempt,outcome)
            if(reply.status==='opened'||reply.status==='focused'){
                const frame=await control.capture(active)
                await check()
                const visible=guestLauncherReplySchema.parse(await control.guest({op:'computer-launcher',operationId,fingerprint,app:request.app,mode:'verify'},active))
                await check()
                if(visible.operationId!==operationId||visible.fingerprint!==fingerprint||visible.app!==request.app||visible.status!=='focused'||visible.windowId!==reply.windowId)throw new LauncherRefusal('interrupted','The app window changed before its screenshot could be published.')
                if(frame.mediaType!=='image/jpeg'||!frame.image.length||frame.image.length>8*1024*1024||!Number.isInteger(frame.width)||!Number.isInteger(frame.height)||frame.width<1||frame.height<1||frame.width>1280||frame.height>720)throw new LauncherRefusal('interrupted','The launcher frame is invalid.')
                const screenshotId=await ports.publish(invocation,frame,active)
                await check()
                return {...outcome,frame:{screenshotId,width:frame.width,height:frame.height,mediaType:frame.mediaType}}
            }
            return outcome
        })
    }
    return {open}
}
