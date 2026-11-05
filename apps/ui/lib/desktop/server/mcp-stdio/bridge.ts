import 'server-only'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import {authenticateDesktopEngineRequest} from '../auth'
import {abortable,boundedText} from '../mcp/remote'
import type {stdioRuntime,StdioRun} from './runtime'
const id=z.string().min(1).max(200),run=z.object({engineAgentId:id,sessionId:id,runId:id})
const requestSchema=z.discriminatedUnion('action',[
 run.extend({action:z.literal('catalog')}).strict(),
 run.extend({action:z.literal('call'),catalogId:z.string().uuid(),capabilityId:z.string().uuid(),toolCallId:id,arguments:z.record(z.string(),z.unknown())}).strict(),
 run.extend({action:z.literal('release'),catalogId:z.string().uuid().optional()}).strict(),
])
type Definition=Awaited<ReturnType<ReturnType<typeof stdioRuntime>['tools']>>[number]
export function stdioEngineBridge(runtime:ReturnType<typeof stdioRuntime>,authorizeRun:(run:StdioRun,signal:AbortSignal,action:'catalog'|'call'|'release')=>Promise<string>){
 const catalogs=new Map<string,{owner:string;run:StdioRun;controller:AbortController;tools:Map<string,Definition>;timer:ReturnType<typeof setTimeout>}>()
 const identity=(run:StdioRun)=>JSON.stringify([run.engineAgentId,run.sessionId,run.runId])
 const releasedRuns=new Map<string,number>();let closed=false
 const release=async(id:string)=>{const catalog=catalogs.get(id);if(catalog){catalog.controller.abort();clearTimeout(catalog.timer);catalogs.delete(id);await runtime.releaseRun(catalog.owner,catalog.run)}}
 return {
  async api(request:Request){
   const signal=AbortSignal.any([request.signal,AbortSignal.timeout(125_000)])
   try{
    await abortable(authenticateDesktopEngineRequest(request),signal);if(request.method!=='POST')throw new Error()
    const body=requestSchema.parse(JSON.parse(await boundedText(new Response(request.body),signal,65536)))
    const owner=await abortable(authorizeRun(body,signal,body.action),signal);signal.throwIfAborted()
    for(const [key,until] of releasedRuns)if(until<Date.now())releasedRuns.delete(key)
    if(body.action==='release'){
     const catalog=body.catalogId?catalogs.get(body.catalogId):undefined
     if(catalog && (catalog.owner!==owner || identity(catalog.run)!==identity(body)))throw new Error('Catalog belongs to another run')
     // Release by exact run also covers Stop before the catalog response arrives.
     // Retain admission invalidation beyond the bounded catalog request lifetime.
     releasedRuns.set(identity(body),Date.now()+300_000)
     await Promise.all([...catalogs].filter(([,value])=>value.owner===owner && identity(value.run)===identity(body)).map(([id])=>release(id)))
     await runtime.releaseRun(owner,body)
     return Response.json({released:true})
    }
    if(closed || releasedRuns.has(identity(body)) || releasedRuns.size>8192)throw new Error('Local run is closed')
    if(body.action==='catalog'){
     if(catalogs.size>=32)throw new Error('Local catalog limit reached')
     const controller=new AbortController(),catalogId=randomUUID(),tools=new Map<string,Definition>()
     const timer=setTimeout(()=>{void release(catalogId).catch(()=>{})},60*60_000);timer.unref?.()
     const catalog={owner,run:{engineAgentId:body.engineAgentId,sessionId:body.sessionId,runId:body.runId},controller,tools,timer};catalogs.set(catalogId,catalog)
     try{
      const definitions=await runtime.tools(owner,body,controller.signal,AbortSignal.any([signal,controller.signal]))
      if(await abortable(authorizeRun(body,signal,body.action),signal)!==owner)throw new Error('Owner changed')
      controller.signal.throwIfAborted();signal.throwIfAborted()
      const publicTools=definitions.map(definition=>{const capabilityId=randomUUID();tools.set(capabilityId,definition);return {capabilityId,name:definition.name,description:definition.description,inputSchema:definition.inputSchema}})
      if(Buffer.byteLength(JSON.stringify(publicTools))>1024*1024)throw new Error('Local catalog exceeds limit')
      return Response.json({catalogId,tools:publicTools},{headers:{'Cache-Control':'no-store'}})
     }catch(error){await release(catalogId).catch(()=>{});throw error}
    }
    const catalog=catalogs.get(body.catalogId)
    if(!catalog || catalog.owner!==owner || identity(catalog.run)!==identity(body))throw new Error('Catalog belongs to another run')
    const definition=catalog.tools.get(body.capabilityId);if(!definition)throw new Error('Local tool unavailable')
    const result=await definition.execute(body.arguments,body.toolCallId,AbortSignal.any([signal,catalog.controller.signal]))
    if(await abortable(authorizeRun(body,signal,body.action),signal)!==owner)throw new Error('Owner changed')
    signal.throwIfAborted();catalog.controller.signal.throwIfAborted()
    return Response.json({toolCallId:body.toolCallId,result},{headers:{'Cache-Control':'no-store'}})
   }catch{return Response.json({error:'Local tool unavailable or acknowledgement unknown; the call will not be replayed.'},{status:400})}
  },
  async shutdown(){closed=true;const releases=Promise.allSettled([...catalogs.keys()].map(release));await runtime.shutdown();const results=await releases;const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason},
  async releaseOwner(owner:string){await Promise.all([...catalogs].filter(([,catalog])=>catalog.owner===owner).map(([id])=>release(id)))},
 }
}
