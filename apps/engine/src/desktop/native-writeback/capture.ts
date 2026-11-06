import {createHash,randomUUID} from 'node:crypto'
import {lstat,opendir} from 'node:fs/promises'
import {join} from 'node:path'
import {openWithoutLinks} from '../open-without-links.js'
import {workspaceRoot} from '../workspace-read.js'
import type {RunContext} from '../../runtime/context.js'
export type ParentIdentity={path:string;identity:string}
export type BeforeFile={text:string;sha256:string;identity:string;version:string}
export type ProposedFile={path:string;before:BeforeFile|null;after:string;afterHash:string;parents:readonly ParentIdentity[]}
/** Review-only receipt for scratch paths that cannot enter portable/live text publish. Never carries file bytes. */
export type UnsupportedNativeFile={path:string;reason:'binary-or-non-text';parents:readonly ParentIdentity[]}
export type NativeWritebackBundle={id:string;engineAgentId:string;sessionId:string;runId:string;files:readonly ProposedFile[];unsupported:readonly UnsupportedNativeFile[]}
export type NativeBaseline={id:string;files:ReadonlyMap<string,BeforeFile>;parents:ReadonlyMap<string,string>}
export const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
export function pathSafe(path:string){return !!path && path.length<=1024 && !/[\\\p{Cc}]/u.test(path) && path.split('/').every(p=>!!p && !p.startsWith('.') && p!=='node_modules')}
export function allowedTextPath(path:string){return pathSafe(path) && /\.(txt|md)$/i.test(path)}
function text(bytes:Buffer){const value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw new Error('Only bounded plain text can be proposed');return value}
function stampOf(s:{dev:bigint;ino:bigint;uid:bigint;nlink:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint}){return [s.dev,s.ino,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':')}
async function read(path:string,max=64*1024):Promise<BeforeFile>{
 const handle=await openWithoutLinks(path)
 try{
  const before=await handle.stat({bigint:true})
  if(!before.isFile() || before.nlink!==1n || before.uid!==BigInt(process.getuid?.()??-1) || before.size>BigInt(max))throw new Error('Invalid proposal file')
  const bytes=Buffer.alloc(Number(before.size)+1);let used=0
  while(used<bytes.length){const part=await handle.read(bytes,used,bytes.length-used,used);if(!part.bytesRead)break;used+=part.bytesRead}
  const after=await handle.stat({bigint:true}),named=await lstat(path,{bigint:true})
  if(used!==Number(before.size) || stampOf(before)!==stampOf(after) || stampOf(before)!==stampOf(named) || !named.isFile())throw new Error('Proposal file changed during capture')
  const value=text(bytes.subarray(0,used))
  return {text:value,sha256:digest(value),identity:`${before.dev}:${before.ino}`,version:stampOf(before)}
 }finally{await handle.close()}
}
/** Metadata-only stamp for unsupported paths. Never reads file bytes into the proposal. */
async function nonTextMeta(path:string):Promise<{version:string;size:bigint}|null>{
 try{
  const handle=await openWithoutLinks(path)
  try{
   const before=await handle.stat({bigint:true})
   if(!before.isFile() || before.nlink!==1n || before.uid!==BigInt(process.getuid?.()??-1))return null
   const after=await handle.stat({bigint:true}),named=await lstat(path,{bigint:true})
   if(stampOf(before)!==stampOf(after) || stampOf(before)!==stampOf(named) || !named.isFile())return null
   return {version:stampOf(before),size:before.size}
  }finally{await handle.close()}
 }catch{return null}
}
async function scan(root:string){
 const files:string[]=[],unsupported:string[]=[],dirs=[''];let visited=0
 for(let i=0;i<dirs.length;i++){
  const handle=await openWithoutLinks(join(root,dirs[i]),true)
  try{
   const info=await handle.stat({bigint:true}),pinned=process.platform==='darwin'?`/.vol/${info.dev}/${info.ino}`:`/proc/self/fd/${handle.fd}`
   for await(const entry of await opendir(pinned)){
    if(++visited>512)throw new Error('Proposal scan limit exceeded')
    if(entry.name.startsWith('.') || entry.name==='node_modules')continue
    const path=dirs[i]?dirs[i]+'/'+entry.name:entry.name
    if(entry.isSymbolicLink())continue
    if(entry.isDirectory()){if(dirs.length>=32 || path.split('/').length>=8)continue;dirs.push(path)}
    else if(entry.isFile() && pathSafe(path)){
     if(allowedTextPath(path)){if(files.length>=64)throw new Error('Proposal file limit exceeded');files.push(path)}
     else {if(unsupported.length>=64)throw new Error('Proposal unsupported limit exceeded');unsupported.push(path)}
    }
   }
   const current=await openWithoutLinks(join(root,dirs[i]),true)
   try{const now=await current.stat({bigint:true});if(now.dev!==info.dev || now.ino!==info.ino)throw new Error('Proposal directory moved')}finally{await current.close()}
  }finally{await handle.close()}
 }
 return {files,unsupported,dirs}
}
export async function captureNativeBaseline(ctx:RunContext,scratch:string,guard:()=>Promise<void>):Promise<NativeBaseline>{
 const root=await workspaceRoot(ctx.agent.id),listing=await scan(scratch),files=new Map<string,BeforeFile>(),parents=new Map<string,string>();let bytes=0
 for(const folder of listing.dirs){await guard();const handle=await openWithoutLinks(join(root,folder),true);try{const stat=await handle.stat({bigint:true});parents.set(folder,`${stat.dev}:${stat.ino}`)}finally{await handle.close()}}
 for(const path of listing.files){await guard();const [original,copied]=await Promise.all([read(join(root,path),32*1024),read(join(scratch,path),32*1024)]);if(original.sha256!==copied.sha256)throw new Error('Source changed during native snapshot');bytes+=Buffer.byteLength(original.text);if(bytes>1024*1024)throw new Error('Proposal snapshot limit exceeded');files.set(path,Object.freeze(original))}
 await guard()
 return {id:randomUUID(),files,parents}
}
function parentChain(path:string,baseline:NativeBaseline){
 const parts=path.split('/').slice(0,-1),folders=[''];for(let i=1;i<=parts.length;i++)folders.push(parts.slice(0,i).join('/'))
 if(folders.some(folder=>!baseline.parents.has(folder)))return null
 return Object.freeze(folders.map(path=>Object.freeze({path,identity:baseline.parents.get(path)!})))
}
export async function captureNativeChanges(ctx:RunContext,scratch:string,baseline:NativeBaseline):Promise<NativeWritebackBundle>{
 if(!ctx.runId)throw new Error('Proposal requires exact run identity')
 const root=await workspaceRoot(ctx.agent.id),listing=await scan(scratch),files:ProposedFile[]=[],unsupported:UnsupportedNativeFile[]=[];let bytes=0
 for(const path of listing.files){
  const before=baseline.files.get(path)??null,parents=parentChain(path,baseline)
  if(!parents)continue
  const after=await read(join(scratch,path))
  if(before?.sha256===after.sha256)continue
  bytes+=Buffer.byteLength(after.text)+Buffer.byteLength(before?.text??'');if(bytes>2*1024*1024)throw new Error('Proposal content limit exceeded')
  files.push(Object.freeze({path,before,after:after.text,afterHash:after.sha256,parents}))
 }
 for(const path of listing.unsupported){
  const parents=parentChain(path,baseline)
  if(!parents)continue
  const scratchMeta=await nonTextMeta(join(scratch,path))
  if(!scratchMeta)continue
  const originalMeta=await nonTextMeta(join(root,path))
  // Added or metadata-changed non-text only. Unchanged copies stay silent. No bytes retained.
  if(originalMeta && originalMeta.version===scratchMeta.version && originalMeta.size===scratchMeta.size)continue
  unsupported.push(Object.freeze({path,reason:'binary-or-non-text' as const,parents}))
 }
 return Object.freeze({id:baseline.id,engineAgentId:ctx.agent.id,sessionId:ctx.sessionId,runId:ctx.runId,files:Object.freeze(files),unsupported:Object.freeze(unsupported)})
}
