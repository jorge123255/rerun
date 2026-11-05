import {constants} from 'node:fs'
import {mkdir,realpath,readdir,link,unlink,open} from 'node:fs/promises'
import {join} from 'node:path'
import {randomBytes} from 'node:crypto'
import {dataDir} from '../../config/paths.js'
import {openWithoutLinks} from '../open-without-links.js'
import type {NativeWritebackBundle} from './capture.js'
const validName=(name:string)=>/^[a-f0-9-]{36}\.json$/.test(name)
async function directory(){
 const base=await realpath(dataDir()),canonical=join(base,'desktop-native-writeback-outbox'),parent=await openWithoutLinks(base,true)
 try{const stat=await parent.stat({bigint:true}),pinned=process.platform==='darwin'?`/.vol/${stat.dev}/${stat.ino}`:`/proc/self/fd/${parent.fd}`;await mkdir(join(pinned,'desktop-native-writeback-outbox'),{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error})}finally{await parent.close()}
 const handle=await openWithoutLinks(canonical,true)
 try{const stat=await handle.stat({bigint:true});if(await realpath(canonical)!==canonical || stat.uid!==BigInt(process.getuid?.()??-1) || (stat.mode&0o077n)!==0n)throw new Error('Invalid writeback outbox');return {canonical,handle,pinned:process.platform==='darwin'?`/.vol/${stat.dev}/${stat.ino}`:`/proc/self/fd/${handle.fd}`}}catch(error){await handle.close();throw error}
}
async function read(path:string){const handle=await openWithoutLinks(path);try{const before=await handle.stat({bigint:true});if(!before.isFile() || before.nlink!==1n || before.size>3n*1024n*1024n || before.uid!==BigInt(process.getuid?.()??-1) || (before.mode&0o077n)!==0n)throw new Error('Invalid writeback outbox file');const body=await handle.readFile('utf8'),after=await handle.stat({bigint:true});if(before.ctimeNs!==after.ctimeNs || before.size!==after.size)throw new Error('Outbox changed');return body}finally{await handle.close()}}
export async function retainNativeWriteback(bundle:NativeWritebackBundle){
 const name=bundle.id+'.json';if(!validName(name))throw new Error('Invalid capture identity')
 const folder=await directory()
 try{
  const path=join(folder.pinned,name),body=JSON.stringify(bundle)
  if(Buffer.byteLength(body)>3*1024*1024)throw new Error('Outbox limit exceeded')
  const existing=await read(path).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error})
  if(existing!==null){if(existing!==body)throw new Error('Capture identity reused');return join(folder.canonical,name)}
  if((await readdir(folder.pinned)).length>=128)throw new Error('Writeback outbox is full')
  const temp=join(folder.pinned,'.pending-'+randomBytes(16).toString('hex')),handle=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
  try{await handle.writeFile(body);await handle.sync()}finally{await handle.close()}
  try{await link(temp,path)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST' || await read(path)!==body)throw error}finally{await unlink(temp).catch(()=>{})}
  await folder.handle.sync();return join(folder.canonical,name)
 }finally{await folder.handle.close()}
}
export async function acknowledgeNativeWriteback(path:string){const folder=await directory();try{const name=path.slice(folder.canonical.length+1);if(path!==join(folder.canonical,name) || !validName(name))throw new Error('Invalid outbox acknowledgement');await unlink(join(folder.pinned,name));await folder.handle.sync()}finally{await folder.handle.close()}}
export async function recoverNativeWritebackOutbox(send:(bundle:NativeWritebackBundle)=>Promise<void>){
 const folder=await directory()
 try{const names=await readdir(folder.pinned);if(names.length>128)throw new Error('Writeback outbox is full');for(const name of names){if(!validName(name))continue;const bundle=JSON.parse(await read(join(folder.pinned,name))) as NativeWritebackBundle;if(bundle.id+'.json'!==name)throw new Error('Outbox identity mismatch');await send(bundle);await unlink(join(folder.pinned,name));await folder.handle.sync()}}finally{await folder.handle.close()}
}
