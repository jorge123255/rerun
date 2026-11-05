import 'server-only'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import {authenticateDesktopEngineRequest} from '../auth'
import {abortable,boundedText} from '../mcp/remote'
import type {ServiceStore} from './store'
import type {LocalServices,ServiceRun} from './lifecycle'
const id=z.string().min(1).max(200),run=z.object({engineAgentId:id,sessionId:id,runId:id})
const bodySchema=z.discriminatedUnion('action',[
 run.extend({action:z.literal('catalog')}).strict(),run.extend({action:z.literal('call'),catalogId:z.string().uuid(),capabilityId:z.string().uuid(),toolCallId:id,arguments:z.record(z.string(),z.unknown())}).strict(),run.extend({action:z.literal('release'),catalogId:z.string().uuid().optional()}).strict(),
])
export function serviceEngineBridge(store:ServiceStore,service:LocalServices,ownerForRun:(run:ServiceRun,signal:AbortSignal,action:'catalog'|'call'|'release')=>Promise<string>){
 type Catalog={owner:string;run:string;controller:AbortController;timer:ReturnType<typeof setTimeout>;tools:Map<string,{key:string;revision:string;name:string}>}
 const catalogs=new Map<string,Catalog>(),releasedRuns=new Set<string>(),preparing=new Map<string,AbortController>();let closed=false
 const identity=(run:ServiceRun)=>JSON.stringify([run.engineAgentId,run.sessionId,run.runId])
 const release=(id:string)=>{const catalog=catalogs.get(id);if(catalog){releasedRuns.add(catalog.run);catalog.controller.abort();clearTimeout(catalog.timer);catalogs.delete(id)}}
 return {async api(request:Request){
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(125_000)])
  try{
   await abortable(authenticateDesktopEngineRequest(request),signal);if(request.method!=='POST'||closed)throw new Error('Service bridge unavailable')
   const body=bodySchema.parse(JSON.parse(await boundedText(new Response(request.body),signal,65536))),owner=await abortable(ownerForRun(body,signal,body.action),signal)
   if(body.action==='release'&&!body.catalogId){const key=identity(body);releasedRuns.add(key);preparing.get(key)?.abort();for(const [id,catalog] of catalogs)if(catalog.run===key)release(id);return Response.json({released:true})}
   if(body.action==='catalog'){
    if(releasedRuns.has(identity(body))||preparing.has(identity(body))||releasedRuns.size>=4096)throw new Error('Run catalog admission closed')
    if(catalogs.size>=32)throw new Error('Catalog limit reached')
    const catalogId=randomUUID(),controller=new AbortController(),tools=new Map<string,{key:string;revision:string;name:string}>(),timer=setTimeout(()=>release(catalogId),60*60_000);timer.unref?.()
    const catalog={owner,run:identity(body),controller,timer,tools};catalogs.set(catalogId,catalog);preparing.set(identity(body),controller)
    try{
     const output=[];const names=new Set<string>()
     for(const record of await store.list(owner)){
      if(record.state!=='ready')continue
      const active=AbortSignal.any([signal,controller.signal]),runtime=service.transport(record,body,active)
      const result=await service.discover(record,body,active)
      await service.current(owner,'use',body,active)
      for(const tool of result.tools){const name=`${record.plan.serverName}_${tool.name}`;if(names.has(name)||names.size>=256)throw new Error('Service tool collision');names.add(name);const capabilityId=randomUUID();tools.set(capabilityId,{key:record.key,revision:record.revision,name:tool.name});output.push({capabilityId,name,description:tool.description??tool.name,inputSchema:tool.inputSchema})}
     }
     if(Buffer.byteLength(JSON.stringify(output))>1024*1024)throw new Error('Catalog exceeds limit')
     if(await ownerForRun(body,signal,body.action)!==owner)throw new Error('Owner changed');signal.throwIfAborted();controller.signal.throwIfAborted()
     return Response.json({catalogId,tools:output},{headers:{'Cache-Control':'no-store'}})
    }catch(error){release(catalogId);throw error}finally{preparing.delete(identity(body))}
   }
   const catalog=catalogs.get(body.catalogId!);if(!catalog||catalog.owner!==owner||catalog.run!==identity(body))throw new Error('Catalog owner mismatch')
   if(body.action==='release'){release(body.catalogId!);return Response.json({released:true})}
   const capability=catalog.tools.get(body.capabilityId);if(!capability)throw new Error('Tool unavailable')
   const active=AbortSignal.any([signal,catalog.controller.signal]);await service.current(owner,'use',body,active)
   const record=await service.liveRecord(owner,capability.key,capability.revision,active),runtime=service.transport(record,body,active)
   const claimed=await store.db.execute({sql:'INSERT INTO desktop_service_calls(owner,run_id,call_id) VALUES(?,?,?) ON CONFLICT DO NOTHING',args:[owner,body.runId,body.toolCallId]});if(claimed.rowsAffected!==1)throw new Error('Call already submitted; it will not be replayed')
   await service.current(owner,'use',body,active);active.throwIfAborted()
   const result=await runtime.call(owner,service.idName(record),record.revision,capability.name,body.arguments,active)
   await runtime.validate(owner,service.idName(record),record.revision,active)
   if(await ownerForRun(body,active,body.action)!==owner)throw new Error('Owner changed');active.throwIfAborted()
   return Response.json({toolCallId:body.toolCallId,result:{source:'local_service',untrusted:true,result:result.result}},{headers:{'Cache-Control':'no-store'}})
  }catch{return Response.json({error:'Service tool unavailable or acknowledgement unknown. Submitted calls are not replayed.'},{status:400})}
 },releaseOwner(owner:string){for(const [id,catalog] of catalogs)if(catalog.owner===owner)release(id)},async shutdown(){closed=true;for(const id of catalogs.keys())release(id);service.shutdown();await service.drain()}}
}
