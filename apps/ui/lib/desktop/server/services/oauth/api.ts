import 'server-only'
import {authenticateDesktopRequest} from '../../auth'
import {boundedText} from '../../mcp/remote'
import {desktopServiceOAuthActionSchema} from '@rerun/contracts'
import type {serviceOAuthLifecycle} from './lifecycle'
export function serviceOAuthApi(lifecycle:ReturnType<typeof serviceOAuthLifecycle>,authorizeOwner:(request:Request,owner:string)=>Promise<void>){
 return async(request:Request,owner:string)=>{
  try{
   if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405})
   await authenticateDesktopRequest(request);await authorizeOwner(request,owner)
   const signal=AbortSignal.any([request.signal,AbortSignal.timeout(45000)])
   const body=desktopServiceOAuthActionSchema.parse(JSON.parse(await boundedText(new Response(request.body),signal,8192)))
   const snapshot=await lifecycle.action(owner,body,signal)
   signal.throwIfAborted()
   return Response.json({snapshot},{headers:{'Cache-Control':'no-store'}})
  }catch{return Response.json({error:'OAuth unavailable or account changed. Refresh this account and retry.'},{status:409,headers:{'Cache-Control':'no-store'}})}
 }
}
