import {constants} from 'node:fs'
import {mkdir,realpath,readdir,unlink,open,lstat} from 'node:fs/promises'
import {join} from 'node:path'
import {randomBytes} from 'node:crypto'
import {dataDir} from '../../config/paths.js'
import {openWithoutLinks} from '../open-without-links.js'
import {acquireSkillLease,renameSkillEntry} from '../skill-publication-native.js'
import type {NativeWritebackBundle} from './capture.js'

const validName=(name:string)=>/^[a-f0-9-]{36}\.json$/.test(name)
async function directory(){
 const base=await realpath(dataDir()),canonical=join(base,'desktop-native-writeback-outbox'),parent=await openWithoutLinks(base,true)
 try{const stat=await parent.stat({bigint:true}),pinned=process.platform==='darwin'?`/.vol/${stat.dev}/${stat.ino}`:`/proc/self/fd/${parent.fd}`;await mkdir(join(pinned,'desktop-native-writeback-outbox'),{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error})}finally{await parent.close()}
 const handle=await openWithoutLinks(canonical,true)
 try{
  const stat=await handle.stat({bigint:true})
  if(await realpath(canonical)!==canonical || stat.uid!==BigInt(process.getuid?.()??-1) || (stat.mode&0o077n)!==0n)throw new Error('Invalid writeback outbox')
  return {canonical,handle,identity:{dev:stat.dev,ino:stat.ino},pinned:process.platform==='darwin'?`/.vol/${stat.dev}/${stat.ino}`:`/proc/self/fd/${handle.fd}`}
 }catch(error){await handle.close();throw error}
}
type Folder=Awaited<ReturnType<typeof directory>>
async function locked<T>(work:(folder:Folder,guard:()=>void)=>Promise<T>):Promise<T>{
 const folder=await directory()
 try{
  let lease:Awaited<ReturnType<typeof acquireSkillLease>>
  try{lease=await acquireSkillLease(folder.canonical,folder.identity)}catch{throw new Error('The safe writeback outbox is unavailable.')}
  try{return await work(folder,lease.assertCurrent)}finally{await lease.release()}
 }finally{await folder.handle.close()}
}
async function read(path:string){
 const handle=await openWithoutLinks(path)
 try{
  const before=await handle.stat({bigint:true})
  if(!before.isFile() || before.nlink!==1n || before.size>3n*1024n*1024n || before.uid!==BigInt(process.getuid?.()??-1) || (before.mode&0o077n)!==0n)throw new Error('Invalid writeback outbox file')
  const body=await handle.readFile('utf8'),after=await handle.stat({bigint:true}),named=await lstat(path,{bigint:true})
  if(before.ctimeNs!==after.ctimeNs || before.size!==after.size || before.dev!==named.dev || before.ino!==named.ino || before.ctimeNs!==named.ctimeNs)throw new Error('Outbox changed')
  return {body,identity:{dev:before.dev,ino:before.ino}}
 }finally{await handle.close()}
}
async function move(folder:Folder,source:string,identity:{dev:bigint;ino:bigint},destination:string){
 try{await renameSkillEntry(folder.canonical,folder.identity,source,identity,destination)}catch{throw new Error('Writeback outbox publication is unconfirmed; retained bytes were preserved.')}
}
export async function retainNativeWriteback(bundle:NativeWritebackBundle){
 const name=bundle.id+'.json';if(!validName(name))throw new Error('Invalid capture identity')
 return locked(async(folder,guard)=>{
  const path=join(folder.pinned,name),body=JSON.stringify(bundle)
  if(Buffer.byteLength(body)>3*1024*1024)throw new Error('Outbox limit exceeded')
  const existing=await read(path).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error})
  if(existing){if(existing.body!==body)throw new Error('Capture identity reused');return join(folder.canonical,name)}
  if((await readdir(folder.pinned)).filter(value=>validName(value)||value.startsWith('.pending-')).length>=128)throw new Error('Writeback outbox is full')
  const tempName='.pending-'+randomBytes(16).toString('hex'),temp=join(folder.pinned,tempName)
  const handle=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
  let identity:{dev:bigint;ino:bigint}
  try{await handle.writeFile(body);await handle.sync();const stat=await handle.stat({bigint:true});identity={dev:stat.dev,ino:stat.ino}}finally{await handle.close()}
  // Atomic no-replace rename has no hard-link crash window. An uncertain helper
  // acknowledgement leaves the exact file for restart recovery.
  guard();await move(folder,tempName,identity,name);guard()
  await folder.handle.sync();return join(folder.canonical,name)
 })
}
async function acknowledge(folder:Folder,name:string,expected:NativeWritebackBundle,guard:()=>void){
 const current=await read(join(folder.pinned,name))
 if(current.body!==JSON.stringify(expected))throw new Error('Writeback acknowledgement does not match retained bytes')
 const tombstone='.acknowledged-'+randomBytes(16).toString('hex')
 guard();await move(folder,name,current.identity,tombstone);guard()
 await folder.handle.sync()
 // A crash here retains acknowledged bytes but cannot replay the capture.
 await unlink(join(folder.pinned,tombstone));await folder.handle.sync()
}
export async function acknowledgeNativeWriteback(path:string,bundle:NativeWritebackBundle){
 await locked(async(folder,guard)=>{
  const name=path.slice(folder.canonical.length+1)
  if(path!==join(folder.canonical,name) || !validName(name) || name!==bundle.id+'.json')throw new Error('Invalid outbox acknowledgement')
  await acknowledge(folder,name,bundle,guard)
 })
}
export type NativeWritebackRecovery={recovered:string[];retained:string[]}
export async function recoverNativeWritebackOutbox(send:(bundle:NativeWritebackBundle)=>Promise<void>):Promise<NativeWritebackRecovery>{
 return locked(async(folder,guard)=>{
  const report:NativeWritebackRecovery={recovered:[],retained:[]}
  const names=(await readdir(folder.pinned)).filter(validName)
  if(names.length>128)throw new Error('Writeback outbox is full')
  for(const name of names){
   guard()
   try{
    const bundle=JSON.parse((await read(join(folder.pinned,name))).body) as NativeWritebackBundle
    if(bundle.id+'.json'!==name)throw new Error('Outbox identity mismatch')
    await send(bundle);await acknowledge(folder,name,bundle,guard);report.recovered.push(bundle.id)
   }catch{report.retained.push(name.slice(0,-5))}
  }
  // One denied/deleted owner's capture must not prevent other owners recovering
  // or prevent app startup. Root surfaces retained IDs without exposing text.
  return report
 })
}
