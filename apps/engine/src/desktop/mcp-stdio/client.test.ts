import {afterEach,expect,it,vi} from 'vitest'
vi.mock('../../config/env.js',()=>({env:()=>({RERUN_HUB_BASE_URL:'http://127.0.0.1:32100/',RERUN_API_KEY:'test-engine-key'})}))
import {desktopStdioTools,isDesktopStdioTool} from './client.js'
import type {RunContext} from '../../runtime/context.js'
const catalogId='883b9f07-796b-43c8-a05b-e7459cfaf89d',capabilityId='a5f82ac4-8d36-402c-b1ea-329297599cc8'
const catalog={catalogId,tools:[{capabilityId,name:'fixture_echo',description:'Echo fixture',inputSchema:{type:'object'}}]}
const context=(signal:AbortSignal)=>({runId:'run',sessionId:'session',agent:{id:'engine'},abortSignal:signal}) as RunContext
afterEach(()=>vi.unstubAllGlobals())
it('marks actual adapters only and preserves local MCP error failure state',async()=>{
 const calls:Record<string,unknown>[]=[]
 vi.stubGlobal('fetch',vi.fn(async(_url:unknown,input:RequestInit)=>{
  const body=JSON.parse(String(input.body));calls.push(body)
  return Response.json(body.action==='catalog'?catalog:body.action==='release'?{released:true}:{toolCallId:body.toolCallId,result:{source:'local_mcp_stdio',untrusted:true,result:{content:[{type:'text',text:'refused'}],isError:true}}})
 }))
 const controller=new AbortController(),built=await desktopStdioTools(context(controller.signal),async()=>{})
 const tool=built.tools.fixture_echo
 expect(isDesktopStdioTool(tool)).toBe(true)
 expect(isDesktopStdioTool({...tool})).toBe(false)
 await expect(tool.execute!({}, {toolCallId:'call',messages:[],abortSignal:controller.signal})).rejects.toThrow('refused')
 await built.close()
 expect(calls.filter(call=>call.action==='call')).toHaveLength(1)
 expect(calls.at(-1)).toMatchObject({action:'release',catalogId,engineAgentId:'engine',sessionId:'session',runId:'run'})
})
it('releases exact run before receiving a catalog ID when discovery is stopped',async()=>{
 const controller=new AbortController(),calls:Record<string,unknown>[]=[]
 let started!:()=>void;const requested=new Promise<void>(resolve=>{started=resolve})
 vi.stubGlobal('fetch',vi.fn(async(_url:unknown,input:RequestInit)=>{
  const body=JSON.parse(String(input.body));calls.push(body)
  if(body.action==='catalog'){started();return new Promise<Response>(()=>{})}
  return Response.json({released:true})
 }))
 const building=desktopStdioTools(context(controller.signal),async()=>{})
 const failed=expect(building).rejects.toThrow()
 await requested;controller.abort();await failed
 expect(calls.filter(call=>call.action==='release')).toEqual([{engineAgentId:'engine',sessionId:'session',runId:'run',action:'release'}])
})
