import 'server-only'
import {z} from 'zod'
import {authenticateDesktopRequest,authenticateDesktopEngineRequest} from '../auth'
import {abortable,boundedText} from '../mcp/remote'
import {nativeBundle,type nativeWritebackService} from './service'
const decision=z.object({sessionId:z.string().min(1).max(200),proposalId:z.string().uuid(),path:z.string().min(1).max(1024),digest:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['apply','reject'])}).strict()
export function nativeWritebackApi(service:ReturnType<typeof nativeWritebackService>){
 return {
  capture:async(request:Request)=>{
   const signal=AbortSignal.any([request.signal,AbortSignal.timeout(30_000)])
   try{await abortable(authenticateDesktopEngineRequest(request),signal);if(request.method!=='POST')throw new Error();const body=nativeBundle.parse(JSON.parse(await boundedText(new Response(request.body),signal,3*1024*1024)));return Response.json(await service.capture(body,signal),{headers:{'Cache-Control':'no-store'}})}
   catch{return Response.json({error:'Proposal not acknowledged. Retry the same immutable capture identity.'},{status:400})}
  },
  review:async(request:Request,owner:string)=>{
   const signal=AbortSignal.any([request.signal,AbortSignal.timeout(30_000)])
   try{
    await abortable(authenticateDesktopRequest(request),signal)
    if(request.method==='GET'){const params=new URL(request.url).searchParams;return Response.json(await service.list(owner,z.string().min(1).max(200).parse(params.get('sessionId')),signal,params.get('cursor')??undefined),{headers:{'Cache-Control':'no-store'}})}
    if(request.method!=='POST')throw new Error()
    const body=decision.parse(JSON.parse(await boundedText(new Response(request.body),signal,4096)))
    return Response.json(await service.decide(owner,body.sessionId,body.proposalId,body.path,body.digest,body.decision,signal),{headers:{'Cache-Control':'no-store'}})
   }catch{return Response.json({state:'unknown',error:'No publication acknowledgement. Refresh the durable proposal receipt.'},{status:400})}
  },
 }
}
