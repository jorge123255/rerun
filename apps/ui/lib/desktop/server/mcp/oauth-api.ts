import 'server-only'
import {z} from 'zod'
import {authenticateDesktopRequest} from '../auth'
import {abortable,boundedText,type McpAccess} from './remote'
import type {loopbackMcpOAuth} from './oauth-loopback'
const input=z.object({name:z.string().min(1).max(64),revision:z.string().uuid(),action:z.enum(['start','status','cancel'])}).strict()
export function loopbackOAuthApi(oauth:ReturnType<typeof loopbackMcpOAuth>,access:McpAccess) {
 return async(request:Request,agent:string)=>{
  try {
   await authenticateDesktopRequest(request)
   if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405})
   const signal=AbortSignal.any([request.signal,AbortSignal.timeout(30_000)])
   signal.throwIfAborted()
   const permission=await abortable(access(agent),signal)
   if(!permission.enabled || !permission.granted)throw new Error('Permission unavailable')
   const body=input.parse(JSON.parse(await boundedText(new Response(request.body),signal,4096)))
   let result:unknown
   if(body.action==='cancel'){
    await oauth.cancel(agent,body.name,body.revision,signal);result={state:'idle'}
   }else if(body.action==='start')result=await oauth.start(agent,body.name,body.revision,signal)
   else result=await oauth.status(agent,body.name,body.revision,signal)
   signal.throwIfAborted()
   return Response.json(result,{headers:{'Cache-Control':'no-store'}})
  }catch{return Response.json({state:'error',message:'Authorization unavailable. Check configuration and current permission.'},{status:400})}
 }
}
