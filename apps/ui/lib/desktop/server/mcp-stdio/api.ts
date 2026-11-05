import 'server-only'
import {z} from 'zod'
import {authenticateDesktopRequest} from '../auth'
import {abortable,boundedText} from '../mcp/remote'
import {stdioInput,type StdioStore} from './store'
import type {stdioRuntime,StdioAuthority} from './runtime'
const action=z.object({name:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),revision:z.string().uuid(),action:z.enum(['probe','disconnect']).optional()}).strict()
export function stdioApi(store:StdioStore,runtime:ReturnType<typeof stdioRuntime>,authorize:StdioAuthority){
 return async(request:Request,owner:string)=>{
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(30_000)])
  try{
   await abortable(authenticateDesktopRequest(request),signal)
   await abortable(authorize(owner,'manage',undefined,signal),signal);signal.throwIfAborted()
   let result:unknown
   if(request.method==='GET')result=await abortable(store.list(owner),signal)
   else {
    const body=JSON.parse(await boundedText(new Response(request.body),signal,32768));signal.throwIfAborted()
    if(request.method==='PUT')result=await store.save(owner,stdioInput.parse(body))
    else {
     const input=action.parse(body),current=store.lifecycle.watch(owner,input.name),connection=await abortable(store.read(owner,input.name),signal)
     signal.throwIfAborted();current();if(connection.revision!==input.revision)throw new Error('Local connection changed')
     if(request.method==='DELETE')result=await store.remove(owner,input.name,input.revision)
     else if(request.method==='POST' && input.action==='probe')result=await runtime.probe(owner,input.name,input.revision,signal)
     else if(request.method==='POST' && input.action==='disconnect'){await runtime.disconnect(owner,input.name);result={disconnected:true}}
     else throw new Error('Unsupported local operation')
    }
   }
   return Response.json(result,{headers:{'Cache-Control':'no-store'}})
  }catch{return Response.json({error:'Local MCP operation unavailable. Check current permission, installed executable and configuration. A submitted call is never replayed.'},{status:400})}
 }
}
