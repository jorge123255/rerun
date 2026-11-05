import {dynamicTool,type ToolSet} from 'ai'
import {z} from 'zod'
import {env} from '../../config/env.js'
import type {RunContext} from '../../runtime/context.js'
import {abortable} from '../web-fetch/transport.js'
const catalogSchema=z.object({catalogId:z.string().uuid(),tools:z.array(z.object({capabilityId:z.string().uuid(),name:z.string().min(1).max(128),description:z.string().max(8000),inputSchema:z.record(z.string(),z.unknown())})).max(256)})
const marked=new WeakSet<object>()
export function isDesktopStdioTool(value:unknown):boolean{return typeof value==='object' && value!==null && marked.has(value)}
const resultSchema=z.object({toolCallId:z.string(),result:z.object({source:z.literal('local_mcp_stdio'),untrusted:z.literal(true),result:z.record(z.string(),z.unknown())})})
function inputSchema(value:Record<string,unknown>){
 const pending=[{value:value as unknown,depth:0}];let count=0
 while(pending.length){const current=pending.pop()!;if(++count>10_000 || current.depth>32)throw new Error('Local MCP schema exceeds limit');if(current.value&&typeof current.value==='object')for(const nested of Object.values(current.value))pending.push({value:nested,depth:current.depth+1})}
 if(value.type!=='object')throw new Error('Local MCP arguments must be an object')
 return z.fromJSONSchema(value as Parameters<typeof z.fromJSONSchema>[0])
}
export async function desktopStdioTools(ctx:RunContext,authorize:()=>Promise<void>):Promise<{tools:ToolSet;close:()=>Promise<void>}>{
 if(!ctx.runId || !ctx.abortSignal)throw new Error('Local subprocess tools require an active cancellable run')
 const runSignal=ctx.abortSignal,config=env(),base=new URL(config.RERUN_HUB_BASE_URL??''),identity={engineAgentId:ctx.agent.id,sessionId:ctx.sessionId,runId:ctx.runId}
 if(base.protocol!=='http:' || base.hostname!=='127.0.0.1' || !base.port || base.pathname!=='/' || base.username || base.password || base.search || base.hash || !config.RERUN_API_KEY)throw new Error('Local MCP bridge unavailable')
 async function post(body:Record<string,unknown>,signal:AbortSignal){
  const bytes=JSON.stringify({...identity,...body});if(Buffer.byteLength(bytes)>65536)throw new Error('Local MCP input exceeds limit')
  const response=await abortable(fetch(`${base.origin}/api/desktop/engine/mcp-stdio`,{method:'POST',body:bytes,signal,redirect:'error',credentials:'omit',headers:{Authorization:`Bearer ${config.RERUN_API_KEY}`,'Content-Type':'application/json'}}),signal)
  const reader=response.body?.getReader();if(!reader)throw new Error('Local MCP acknowledgement unavailable')
  try{
   const chunks:Uint8Array[]=[];let count=0
   for(;;){const part=await abortable(reader.read(),signal);if(part.done)break;if((count+=part.value.length)>1024*1024+8192)throw new Error('Local MCP output exceeds limit');chunks.push(part.value)}
   if(!response.ok)throw new Error('Local MCP failed or acknowledgement is unknown. Do not replay this call.')
   return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>
  }finally{void reader.cancel().catch(()=>{})}
 }
 let catalogId:string|undefined,closing:Promise<void>|undefined
 const close=()=>closing??=post({action:'release',...(catalogId?{catalogId}:{})},AbortSignal.timeout(5000)).then(()=>{})
 const stop=()=>{void close().catch(()=>{})}
 runSignal.addEventListener('abort',stop,{once:true})
 try{
 await abortable(authorize(),runSignal);runSignal.throwIfAborted()
 const catalog=catalogSchema.parse(await post({action:'catalog'},AbortSignal.any([runSignal,AbortSignal.timeout(125_000)]))),tools:ToolSet=Object.create(null)
 catalogId=catalog.catalogId
 await abortable(authorize(),runSignal);runSignal.throwIfAborted()
 for(const definition of catalog.tools){
  if(Object.hasOwn(tools,definition.name))throw new Error('Local MCP tool name collision')
  const executable=dynamicTool({description:definition.description,inputSchema:inputSchema(definition.inputSchema),execute:async(args,options)=>{
   const signal=AbortSignal.any([runSignal,...(options.abortSignal?[options.abortSignal]:[]),AbortSignal.timeout(125_000)])
   await abortable(authorize(),signal);signal.throwIfAborted()
   if(!options.toolCallId)throw new Error('Exact local tool call identity required')
   if(!args || typeof args!=='object' || Array.isArray(args))throw new Error('Local MCP arguments must be an object')
   const result=resultSchema.parse(await post({action:'call',catalogId:catalog.catalogId,capabilityId:definition.capabilityId,toolCallId:options.toolCallId,arguments:args},signal))
   await abortable(authorize(),signal);signal.throwIfAborted()
   if(result.toolCallId!==options.toolCallId)throw new Error('Local MCP call identity mismatch')
   if(result.result.result.isError===true)throw new Error(JSON.stringify(result.result))
   return JSON.stringify(result.result)
  }})
  marked.add(executable);tools[definition.name]=executable
 }
 return {tools,close:async()=>{runSignal.removeEventListener('abort',stop);await close()}}
 }catch(error){runSignal.removeEventListener('abort',stop);await close().catch(()=>{});throw error}
}
