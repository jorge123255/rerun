import 'server-only'
import { emptyMcpMaterialLease, type DesktopMcpMaterialLease, type DesktopMcpMaterialSource } from '../mcp-secret-references/lease'
import {createHash} from 'node:crypto'
import {realpath} from 'node:fs/promises'
import {abortable} from '../mcp/remote'
import type {StdioConnection,StdioStore} from './store'
import {executableIdentity,spawnStdio,type StdioSpawn} from './process'
export type StdioRun={engineAgentId:string;sessionId:string;runId:string}
export type StdioAuthority=(owner:string,action:'manage'|'use',run:StdioRun|undefined,signal:AbortSignal)=>Promise<{cwd:string}>
type Tool={name:string;description?:string;inputSchema:Record<string,unknown>}
type Process=ReturnType<typeof spawnStdio>
type Entry={material?:DesktopMcpMaterialLease;owner:string;name:string;revision:string;users:Set<string>;controller:AbortController;check:()=>void;release:()=>void;opening:Promise<{process:Process;tools:Tool[];fingerprint:string;cwd:string}>;process?:Process;tail:Promise<unknown>;cwd?:string;idle?:ReturnType<typeof setTimeout>}
export function stdioRuntime(store:StdioStore,authorize:StdioAuthority,spawnProcess?:StdioSpawn,materials?:DesktopMcpMaterialSource,vaultPrograms?:(owner:string)=>Promise<StdioConnection[]>,vaultMaterials?:DesktopMcpMaterialSource){
 const entries=new Map<string,Entry>(),retired=new Set<Entry>();let closed=false
 const key=(owner:string,name:string)=>JSON.stringify([owner,name])
 const runKey=(run:StdioRun)=>JSON.stringify([run.engineAgentId,run.sessionId,run.runId])
 async function stopEntries(owner?:string,name?:string){
  const selected=[...new Set([...entries.values(),...retired])].filter(e=>(!owner||e.owner===owner)&&(!name||e.name===name))
  // Keep ownership until drain succeeds. A failed drain must block a replacement and
  // remain visible to a later shutdown instead of disappearing with the live slot.
  for(const entry of selected){retired.add(entry);entry.controller.abort();clearTimeout(entry.idle);if(entries.get(key(entry.owner,entry.name))===entry)entries.delete(key(entry.owner,entry.name))}
  await Promise.all(selected.map(async entry=>{await entry.opening.catch(()=>{});await entry.process?.drain();await entry.material?.release();entry.release();retired.delete(entry)}))
 }
 store.bindStop((owner,name)=>stopEntries(owner,name))
 function arm(entry:Entry){clearTimeout(entry.idle);entry.idle=setTimeout(()=>{void stopEntries(entry.owner,entry.name).catch(()=>{})},10*60_000);entry.idle.unref?.()}
 async function connectionsFor(owner:string,run?:StdioRun){
  const direct=await store.list(owner)
  if(!run || !vaultPrograms)return direct
  const assigned=await vaultPrograms(owner)
  if(direct.length+assigned.length>16)throw new Error('Too many local connections')
  if(assigned.some(server=>direct.some(existing=>existing.name===server.name)))throw new Error('Conflicting local connection names')
  return [...direct,...assigned]
 }
 async function guard(entry:Entry,run:StdioRun|undefined,signal:AbortSignal){
  entry.check();signal.throwIfAborted()
  try {
   await entry.material?.check()
   if(entry.process?.closed())throw new Error('Local MCP disconnected')
   const access=await abortable(authorize(entry.owner,'use',run,signal),signal)
   const connection=run
    ? (await abortable(connectionsFor(entry.owner,run),signal)).find(server=>server.name===entry.name)
    : await abortable(store.read(entry.owner,entry.name),signal)
   entry.check();signal.throwIfAborted()
   if(connection?.revision!==entry.revision || entry.cwd!==undefined && access.cwd!==entry.cwd)throw new Error('Local connection changed')
   return {access,connection}
  } catch (error) { entry.controller.abort(); throw error }
 }
 function connect(owner:string,name:string,revision:string,run:StdioRun|undefined):Entry{
  if(closed)throw new Error('Local MCP stopped')
  const slot=key(owner,name),existing=entries.get(slot)
  if(existing?.process?.closed()){existing.controller.abort();retired.add(existing);entries.delete(slot)}
  else if(existing){if(existing.revision!==revision)throw new Error('Local connection changed; disconnect before reconnecting');return existing}
  if(entries.size>=32)throw new Error('Local MCP connection limit reached')
  const controller=new AbortController(),ticket=store.lifecycle.admit(owner,name,controller)
  const entry:Entry={owner,name,revision,users:new Set(),controller,check:ticket.assertCurrent,release:ticket.release,opening:undefined as unknown as Entry['opening'],tail:Promise.resolve()}
  entries.set(slot,entry)
  entry.opening=Promise.resolve().then(async()=>{
   const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(20_000)])
   await abortable(Promise.all([...retired].filter(e=>e.owner===owner && e.name===name).map(async e=>{await e.process?.drain();await e.material?.release();e.release();retired.delete(e)})),signal)
   const first=await guard(entry,run,signal)
   const cwd=await abortable(realpath(first.access.cwd),signal)
   if(cwd!==first.access.cwd)throw new Error('Local MCP working directory must be canonical')
   const fingerprint=await executableIdentity(first.connection.executable,signal)
   const final=await guard(entry,run,signal)
   if(final.connection.approvedExecutable && final.connection.approvedExecutable!==fingerprint)throw new Error('Review the changed Vault executable before using it')
   if(final.access.cwd!==cwd)throw new Error('Local MCP owner changed')
   entry.cwd=cwd
   entry.check();signal.throwIfAborted()
   const loadMaterial=final.connection.approvedExecutable?vaultMaterials:materials
   entry.material=loadMaterial?await loadMaterial(owner,name,revision,'discovery',controller.signal):emptyMcpMaterialLease()
   await guard(entry,run,signal)
   if(final.connection.approvedExecutable && await executableIdentity(final.connection.executable,signal)!==fingerprint)throw new Error('Local executable changed')
   await guard(entry,run,signal);entry.check();signal.throwIfAborted()
   const resolved=entry.material.configured?{...first.connection,args:[...entry.material.material.args]}:first.connection
   const process=spawnStdio(resolved,cwd,controller.signal,spawnProcess,entry.material.material.env);entry.process=process
   const stop=()=>controller.abort();signal.addEventListener('abort',stop,{once:true})
   try{
    const init=await process.rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'rerun-desktop',version:'1.0.0'}},signal)
    if(init.protocolVersion!=='2025-03-26')throw new Error('Unsupported local MCP protocol')
    await process.rpc('notifications/initialized',{},signal,true)
    const tools:Tool[]=[];let cursor:string|undefined
    for(let page=0;page<8;page++){
     const response=await process.rpc('tools/list',cursor?{cursor}:{},signal)
     if(!Array.isArray(response.tools))throw new Error('Invalid local tool list')
     for(const tool of response.tools){if(!tool || typeof tool.name!=='string' || !/^[\w.-]{1,128}$/.test(tool.name) || tool.name.length+name.length+1>128 || !tool.inputSchema || tool.inputSchema.type!=='object' || tools.some(t=>t.name===tool.name))throw new Error('Invalid local tool schema');tools.push({name:tool.name,description:typeof tool.description==='string'?tool.description.slice(0,8000):undefined,inputSchema:tool.inputSchema})}
     if(tools.length>256 || Buffer.byteLength(JSON.stringify(tools))>1024*1024)throw new Error('Local tool catalog exceeds limit')
     if(!response.nextCursor)break
     if(page===7 || typeof response.nextCursor!=='string' || response.nextCursor.length>4096)throw new Error('Local tool pagination exceeds limit');cursor=response.nextCursor
    }
    await guard(entry,run,signal);entry.check();arm(entry)
    return {process,tools:entry.material.protect(tools),fingerprint,cwd}
   }finally{signal.removeEventListener('abort',stop)}
  })
  void entry.opening.catch(()=>{controller.abort();entry.process?.close();retired.add(entry);if(entries.get(slot)===entry)entries.delete(slot);void (async()=>{await entry.process?.drain();await entry.material?.release();entry.release();retired.delete(entry)})().catch(()=>{})})
  return entry
 }
 async function operation<T>(entry:Entry,run:StdioRun|undefined,stop:AbortSignal,work:(session:Awaited<Entry['opening']>,signal:AbortSignal)=>Promise<T>){
  const signal=AbortSignal.any([entry.controller.signal,stop,AbortSignal.timeout(120_000)])
  const cancel=()=>entry.controller.abort();signal.addEventListener('abort',cancel,{once:true})
  if(signal.aborted)cancel()
  const task=entry.tail.catch(()=>{}).then(async()=>{
   signal.throwIfAborted();const session=await abortable(entry.opening,signal)
   if(session.process.closed())throw new Error('Local MCP disconnected; reconnect required')
   const before=await guard(entry,run,signal)
   if(before.access.cwd!==session.cwd || await executableIdentity(before.connection.executable,signal)!==session.fingerprint)throw new Error('Local executable or working directory changed')
   await guard(entry,run,signal);entry.check();clearTimeout(entry.idle)
   const result=await work(session,signal)
   await guard(entry,run,signal);entry.check();signal.throwIfAborted();return result
  })
  entry.tail=task
  try{return await abortable(task,signal)}finally{signal.removeEventListener('abort',cancel);if(!entry.controller.signal.aborted)arm(entry);else void stopEntries(entry.owner,entry.name).catch(()=>{})}
 }
 return {
  async probe(owner:string,name:string,revision:string,signal:AbortSignal){const entry=connect(owner,name,revision,undefined);return operation(entry,undefined,signal,async session=>({tools:session.tools}))},
  async tools(owner:string,run:StdioRun,signal:AbortSignal,admissionSignal:AbortSignal=signal){
   if(closed)throw new Error('Local MCP stopped')
   const connections=await abortable(connectionsFor(owner,run),admissionSignal),definitions=[]
   for(const connection of connections){
    admissionSignal.throwIfAborted();signal.throwIfAborted()
    const previous=entries.get(key(owner,connection.name))
    if(previous && previous.revision!==connection.revision){
     await abortable(stopEntries(owner,connection.name),admissionSignal)
    }
    const entry=connect(owner,connection.name,connection.revision,run)
    entry.users.add(runKey(run))
    const listed=await operation(entry,run,admissionSignal,async session=>session.tools)
    for(const tool of listed)definitions.push({name:`${connection.name}_${tool.name}`,description:tool.description??tool.name,inputSchema:tool.inputSchema,execute:(args:Record<string,unknown>,toolCallId:string,stop:AbortSignal)=>operation(entry,run,AbortSignal.any([signal,stop]),async(session,active)=>{
     if(!toolCallId || toolCallId.length>200 || Buffer.byteLength(JSON.stringify(args))>65536)throw new Error('Local tool call exceeds limit')
     const digest=createHash('sha256').update(JSON.stringify([run,connection.revision,tool.name,args])).digest('hex')
     await store.claim(owner,run.runId,toolCallId,digest)
     await guard(entry,run,active);entry.check();active.throwIfAborted()
     const result=await session.process.rpc('tools/call',{name:tool.name,arguments:args},active)
     if(!Array.isArray(result.content) || result.isError!==undefined && typeof result.isError!=='boolean')throw new Error('Invalid local tool result')
     return {source:'local_mcp_stdio',untrusted:true,result:entry.material?.protect(result)??result}
    })})
   }
   if(definitions.length>256 || Buffer.byteLength(JSON.stringify(definitions))>1024*1024 || new Set(definitions.map(t=>t.name)).size!==definitions.length)throw new Error('Local tool catalog exceeds limit or collides')
   return definitions
  },
  async disconnect(owner:string,name?:string){store.lifecycle.disconnect(owner,name);await stopEntries(owner,name)},
  async releaseRun(owner:string,run:StdioRun){
   const names=new Set<string>()
   for(const entry of [...entries.values(),...retired])if(entry.owner===owner && entry.users.delete(runKey(run)) && !entry.users.size)names.add(entry.name)
   await Promise.all([...names].map(name=>stopEntries(owner,name)))
  },
  transitionOwner:<T>(owner:string,write:()=>Promise<T>)=>store.lifecycle.transitionOwner(owner,async()=>{await stopEntries(owner);return write()}),
  async shutdown(){closed=true;store.lifecycle.shutdown();await stopEntries()},
 }
}
