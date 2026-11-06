import 'server-only'
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process'
import {lstat,realpath} from 'node:fs/promises'
import {abortable} from '../mcp/remote'
import type {StdioConnection} from './store'
export type StdioSpawn=typeof spawn
export const stdioEnvironment=Object.freeze({PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8',NODE_ENV:'production' as const})
export async function executableIdentity(path:string,signal:AbortSignal){
 signal.throwIfAborted();if(/^(?:sh|bash|zsh|fish|csh|tcsh|ksh|env|sudo|npx|npm|pnpm|yarn|bunx|uvx|uv|pip|pip3|pipx|osascript|open|launchctl)$/.test(path.split('/').pop()??''))throw new Error('Shells and package runners are not local MCP executables');const actual=await abortable(realpath(path),signal),stat=await abortable(lstat(path,{bigint:true}),signal)
 if(actual!==path || !stat.isFile() || !(stat.mode&BigInt(0o111)) || stat.uid!==BigInt(0) && stat.uid!==BigInt(process.getuid?.()??-1))throw new Error('Choose a canonical, installed executable owned by this Mac user or root')
 return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':')
}
export function spawnStdio(connection:StdioConnection,cwd:string,stop:AbortSignal,spawnProcess:StdioSpawn=spawn,explicitEnv:Record<string,string>={}){
 stop.throwIfAborted()
 for(const [key,value] of Object.entries(explicitEnv))if(/^(?:HOME|PATH|TMPDIR|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|DYLD_.*|LD_.*)$/i.test(key)||!/^[_A-Za-z][_A-Za-z0-9]*$/.test(key)||/[\0\r\n]/.test(value))throw new Error('Local MCP environment variable is not allowed')
 const child=spawnProcess(connection.executable,connection.args,{cwd,env:{...stdioEnvironment,...explicitEnv},shell:false,detached:true,stdio:['pipe','pipe','pipe']}) as ChildProcessWithoutNullStreams
 const decoder=new TextDecoder('utf-8',{fatal:true}),pending=new Map<number,{resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void}>()
 let buffer='',bytes=0,errors=0,sequence=0,closed=false
 let killTimer:ReturnType<typeof setTimeout>|undefined
 const exited=new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.once('error',()=>{if(!child.pid)resolve()})})
 function fail(){if(closed)return;closed=true;stop.removeEventListener('abort',fail);for(const call of pending.values())call.reject(new Error('Local MCP process stopped; no call will be replayed'));pending.clear();buffer=''
  const pid=child.pid
  if(pid){try{process.kill(-pid,'SIGTERM')}catch{child.kill('SIGTERM')};killTimer=setTimeout(()=>{try{process.kill(-pid,'SIGKILL')}catch{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL')}},500);killTimer.unref?.()}
 }
 stop.addEventListener('abort',fail,{once:true})
 child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail)
 child.stderr.on('data',(chunk:Buffer)=>{errors+=chunk.length;if(errors>65536)fail()})
 child.stdout.on('data',(chunk:Buffer)=>{
  if(closed)return
  bytes+=chunk.length;if(bytes>8*1024*1024){fail();return}
  try{buffer+=decoder.decode(chunk,{stream:true})}catch{fail();return}
  if(Buffer.byteLength(buffer)>1024*1024){fail();return}
  let end:number
  while((end=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue
   try{
    const message=JSON.parse(line) as Record<string,unknown>
    if(message.jsonrpc!=='2.0')throw new Error()
    if(message.method){if(message.id!==undefined)throw new Error();continue}
    if(typeof message.id!=='number')throw new Error()
    const call=pending.get(message.id);if(!call)throw new Error();pending.delete(message.id)
    if(message.error || !message.result || typeof message.result!=='object' || Array.isArray(message.result))call.reject(new Error('Local MCP request refused'))
    else call.resolve(message.result as Record<string,unknown>)
   }catch{fail();return}
  }
 })
 if(stop.aborted)fail()
 async function rpc(method:string,params:unknown,signal:AbortSignal,notification=false){
  signal.throwIfAborted();if(closed)throw new Error('Local MCP is disconnected')
  const id=++sequence,body=JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params})+'\n'
  if(Buffer.byteLength(body)>65536)throw new Error('Local MCP request exceeds limit')
  const cancel=()=>fail();signal.addEventListener('abort',cancel,{once:true})
  try{
   let result:Promise<Record<string,unknown>>=Promise.resolve({})
   if(!notification)result=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}))
   void result.catch(()=>{})
   const written=new Promise<void>((resolve,reject)=>child.stdin.write(body,error=>error?reject(new Error('Local MCP input unavailable')):resolve()))
   await abortable(written,signal)
   return await abortable(result,signal)
  }catch(error){fail();throw error}finally{signal.removeEventListener('abort',cancel)}
 }
 return {rpc,closed:()=>closed,close:fail,async drain(){
  fail();let timer:ReturnType<typeof setTimeout>|undefined
  try{await Promise.race([exited,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Local process exit was not confirmed')),1500)})])}finally{clearTimeout(timer)}
  if(!child.pid)return
  // The direct child exiting is not evidence that its owned process group exited.
  // Keep the entry retiring until TERM/KILL has removed that group too.
  for(let attempt=0;attempt<20;attempt++){
   try{process.kill(-child.pid,0)}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH'){clearTimeout(killTimer);return}throw new Error('Local process group exit was not confirmed')}
   await new Promise<void>(resolve=>setTimeout(resolve,100))
  }
  throw new Error('Local process group exit was not confirmed')
 }}
}
