import 'server-only'
import {randomUUID} from 'node:crypto'
import type {Client} from '@libsql/client'
import {z} from 'zod'
import {remoteMcpLifecycle} from '../mcp/lifecycle'
export const stdioInput=z.object({name:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),executable:z.string().min(1).max(4096).refine(p=>p.startsWith('/')&&!/[\x00-\x1f\x7f]/.test(p)),args:z.array(z.string().max(4096).refine(s=>!s.includes('\0'))).max(64),revision:z.string().uuid().optional()}).strict()
export type StdioConnection=z.infer<typeof stdioInput>&{revision:string;transport:'stdio'}
export {stdioSchema} from './schema'
export function stdioStore(db:Client){
 const lifecycle=remoteMcpLifecycle()
 let stop:((owner:string,name:string)=>Promise<void>)|undefined
 const stopCurrent=async(owner:string,name:string)=>{if(!stop)throw new Error('Local MCP runtime is not bound');await stop(owner,name)}
 async function list(owner:string):Promise<StdioConnection[]>{const result=await db.execute({sql:'SELECT * FROM desktop_mcp_stdio WHERE owner=? ORDER BY name',args:[owner]});if(result.rows.length>16)throw new Error('Too many local connections');return result.rows.map(r=>({...stdioInput.parse({name:String(r.name),executable:String(r.executable),args:JSON.parse(String(r.args)),revision:String(r.revision)}),revision:String(r.revision),transport:'stdio'}))}
 async function read(owner:string,name:string){const row=(await list(owner)).find(s=>s.name===name);if(!row)throw new Error('Local connection unavailable');return row}
 return {lifecycle,list,read,bindStop:(callback:(owner:string,name:string)=>Promise<void>)=>{if(stop)throw new Error('Local MCP runtime already bound');stop=callback},
  save:(owner:string,input:z.infer<typeof stdioInput>)=>{const value=stdioInput.parse(input);if(Buffer.byteLength(JSON.stringify(value))>32768)throw new Error('Local configuration exceeds limit');return lifecycle.mutate(owner,value.name,async()=>{
   await stopCurrent(owner,value.name)
   const revision=randomUUID()
   if(value.revision){const changed=await db.execute({sql:'UPDATE desktop_mcp_stdio SET executable=?,args=?,revision=? WHERE owner=? AND name=? AND revision=?',args:[value.executable,JSON.stringify(value.args),revision,owner,value.name,value.revision]});if(changed.rowsAffected!==1)throw new Error('Local connection changed')}
   else{if((await list(owner)).length>=16)throw new Error('Too many local connections');await db.execute({sql:'INSERT INTO desktop_mcp_stdio(owner,name,executable,args,revision) VALUES(?,?,?,?,?)',args:[owner,value.name,value.executable,JSON.stringify(value.args),revision]})}
   return list(owner)
  })},
  remove:(owner:string,name:string,revision:string)=>lifecycle.mutate(owner,name,async()=>{await stopCurrent(owner,name);const result=await db.execute({sql:'DELETE FROM desktop_mcp_stdio WHERE owner=? AND name=? AND revision=?',args:[owner,name,revision]});if(result.rowsAffected!==1)throw new Error('Local connection changed');return list(owner)}),
  async claim(owner:string,runId:string,callId:string,digest:string){const result=await db.execute({sql:'INSERT INTO desktop_mcp_stdio_calls(owner,run_id,call_id,digest) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',args:[owner,runId,callId,digest]});if(result.rowsAffected!==1)throw new Error('Local tool call already submitted; acknowledgement unavailable. It will not be replayed.')},
 }
}
export type StdioStore=ReturnType<typeof stdioStore>
