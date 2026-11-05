import {dynamicTool,jsonSchema,type ToolSet} from 'ai'
import {z} from 'zod'
import {env} from '../../config/env.js'
import type {RunContext} from '../../runtime/context.js'
import {abortable} from '../web-fetch/transport.js'
const catalogSchema=z.object({catalogId:z.string().uuid(),tools:z.array(z.object({capabilityId:z.string().uuid(),name:z.string().min(1).max(128),description:z.string().max(8000),inputSchema:z.record(z.string(),z.unknown())})).max(256)})
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
 await abortable(authorize(),runSignal);runSignal.throwIfAborted()
 const catalog=catalogSchema.parse(await post({action:'catalog'},AbortSignal.any([runSignal,AbortSignal.timeout(125_000)]))),tools:ToolSet={}
 for(const definition of catalog.tools){
  if(tools[definition.name])throw new Error('Local MCP tool name collision')
  tools[definition.name]=dynamicTool({description:definition.description,inputSchema:jsonSchema(definition.inputSchema),execute:async(args,options)=>{
   const signal=AbortSignal.any([runSignal,...(options.abortSignal?[options.abortSignal]:[]),AbortSignal.timeout(125_000)])
   await abortable(authorize(),signal);signal.throwIfAborted()
   if(!options.toolCallId)throw new Error('Exact local tool call identity required')
   const result=await post({action:'call',catalogId:catalog.catalogId,capabilityId:definition.capabilityId,toolCallId:options.toolCallId,arguments:args},signal)
   await abortable(authorize(),signal);signal.throwIfAborted()
   if(result.toolCallId!==options.toolCallId)throw new Error('Local MCP call identity mismatch')
   return result.result
  }})
 }
 return {tools,close:async()=>{await post({action:'release',catalogId:catalog.catalogId},AbortSignal.timeout(5000))}}
}
