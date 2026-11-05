import 'server-only'
import {createHash} from 'node:crypto'
import {relative} from 'node:path'
import type {Client} from '@libsql/client'
import {z} from 'zod'
import {saveCoworkerFile,importCoworkerFile} from '../coworker-files'
import {privateFileLocation,readPrivateSnapshot} from '../private-file-tools/snapshot'
import {boundedPrivateText,privateTextPath} from '../private-file-tools/semantics'
import {abortable} from '../mcp/remote'
import type {DesktopRuntime} from '../runtime'
const id=z.string().min(1).max(200),hash=z.string().regex(/^[a-f0-9]{64}$/)
const before=z.object({text:z.string().max(65536),sha256:hash,identity:id,version:z.string().max(512)}).strict()
const file=z.object({path:z.string().max(1024),before:before.nullable(),after:z.string().max(65536),afterHash:hash,parents:z.array(z.object({path:z.string().max(1024),identity:id}).strict()).min(1).max(8)}).strict()
export const nativeBundle=z.object({id:z.string().uuid(),engineAgentId:id,sessionId:id,runId:id,files:z.array(file).min(1).max(64)}).strict()
export type NativeBundle=z.infer<typeof nativeBundle>
export type NativeReview={id:string;digest:string;path:string;before:string|null;after:string;state:string}
export type WritebackAuthority=(identity:{engineAgentId:string;sessionId:string;runId:string},action:'capture'|'read'|'apply'|'reject',signal:AbortSignal)=>Promise<{owner:string;runtime:DesktopRuntime;workspaceRoot:string;cancelled?:boolean}>
export {nativeWritebackSchema} from './schema'
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
export function nativeWritebackService(db:Client,authorize:WritebackAuthority){
 async function capture(input:NativeBundle,signal:AbortSignal){
  const bundle=nativeBundle.parse(input),identity={engineAgentId:bundle.engineAgentId,sessionId:bundle.sessionId,runId:bundle.runId}
  if(Buffer.byteLength(JSON.stringify(bundle))>3*1024*1024)throw new Error('Proposal exceeds limit')
  const authority=await abortable(authorize(identity,'capture',signal),signal)
  const seen=new Set<string>()
  for(const item of bundle.files){
   privateTextPath(item.path);boundedPrivateText(item.after);if(Buffer.byteLength(item.after)>65536)throw new Error('Proposal file exceeds limit');if(item.before)boundedPrivateText(item.before.text)
   if(seen.has(item.path) || sha(item.after)!==item.afterHash || item.before && (sha(item.before.text)!==item.before.sha256 || Buffer.byteLength(item.before.text)>32768))throw new Error('Invalid immutable proposal')
   seen.add(item.path)
   const parents=[''];const parts=item.path.split('/').slice(0,-1);for(let i=1;i<=parts.length;i++)parents.push(parts.slice(0,i).join('/'))
   if(JSON.stringify(item.parents.map(p=>p.path))!==JSON.stringify(parents))throw new Error('Invalid proposal parent identities')
  }
  const digest=sha(JSON.stringify(bundle)),transaction=await db.transaction('write')
  try{
   const old=(await transaction.execute({sql:'SELECT * FROM desktop_native_writeback WHERE id=?',args:[bundle.id]})).rows[0]
   if(old){if(old.owner!==authority.owner || old.digest!==digest)throw new Error('Proposal identity reused')}
   else {
    await transaction.execute({sql:'INSERT INTO desktop_native_writeback(id,owner,engine_id,session_id,run_id,digest) VALUES(?,?,?,?,?,?)',args:[bundle.id,authority.owner,bundle.engineAgentId,bundle.sessionId,bundle.runId,digest]})
    for(const item of bundle.files)await transaction.execute({sql:'INSERT INTO desktop_native_writeback_files(proposal_id,path,digest,payload) VALUES(?,?,?,?)',args:[bundle.id,item.path,sha(JSON.stringify(item)),JSON.stringify(item)]})
   }
   const current=await abortable(authorize(identity,'capture',signal),signal);signal.throwIfAborted();if(current.owner!==authority.owner)throw new Error('Proposal owner changed')
   await transaction.commit()
  }catch(error){await transaction.rollback();throw error}finally{transaction.close()}
  return {proposalId:bundle.id}
 }
 async function engineSession(owner:string,sessionId:string,signal:AbortSignal){
  id.parse(sessionId)
  const rows=(await abortable(db.execute({sql:'SELECT engine_session_id FROM desktop_sessions WHERE id=? AND agent_id=?',args:[sessionId,owner]}),signal)).rows
  if(rows.length!==1)throw new Error('Conversation unavailable')
  return String(rows[0].engine_session_id)
 }
 async function owned(owner:string,sessionId:string,proposalId:string,action:'read'|'apply'|'reject',signal:AbortSignal){
  const expectedSession=await engineSession(owner,sessionId,signal)
  const proposal=(await abortable(db.execute({sql:'SELECT * FROM desktop_native_writeback WHERE id=? AND owner=?',args:[proposalId,owner]}),signal)).rows[0]
  if(!proposal || proposal.session_id!==expectedSession)throw new Error('Proposal unavailable in this conversation')
  const identity={engineAgentId:String(proposal.engine_id),sessionId:String(proposal.session_id),runId:String(proposal.run_id)}
  const current=await abortable(authorize(identity,action,signal),signal)
  if(current.owner!==owner)throw new Error('Proposal owner changed')
  return {identity,current}
 }
 async function list(owner:string,sessionId:string,signal:AbortSignal,cursor?:string){
  const expectedSession=await engineSession(owner,sessionId,signal)
  if(cursor && (!/^[1-9]\d{0,14}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))))throw new Error('Invalid review cursor')
  const rows=(await abortable(db.execute({sql:`SELECT f.rowid AS cursor,f.* FROM desktop_native_writeback_files f JOIN desktop_native_writeback p ON p.id=f.proposal_id WHERE p.owner=? AND p.session_id=? ${cursor?'AND f.rowid<?':''} ORDER BY f.rowid DESC LIMIT 65`,args:[owner,expectedSession,...(cursor?[Number(cursor)]:[])]}),signal)).rows
  const result:NativeReview[]=[];let bytes=0,last:string|undefined
  for(const row of rows){
   if(result.length>=64)break
   const authority=await owned(owner,sessionId,String(row.proposal_id),'read',signal)
   const item=file.parse(JSON.parse(String(row.payload))),size=Buffer.byteLength(item.after)+Buffer.byteLength(item.before?.text??'')
   if(bytes+size>3*1024*1024)break
   bytes+=size;last=String(row.cursor)
   result.push({id:String(row.proposal_id),digest:String(row.digest),path:item.path,before:item.before?.text??null,after:item.after,state:row.state==='pending' && authority.current.cancelled?'cancelled':String(row.state)})
  }
  signal.throwIfAborted();return {files:result,nextCursor:result.length<rows.length?last:undefined}
 }
 async function decide(owner:string,sessionId:string,proposalId:string,path:string,digest:string,decision:'apply'|'reject',signal:AbortSignal){
  const auth=await owned(owner,sessionId,proposalId,decision,signal)
  const row=(await abortable(db.execute({sql:'SELECT * FROM desktop_native_writeback_files WHERE proposal_id=? AND path=? AND digest=?',args:[proposalId,path,digest]}),signal)).rows[0]
  if(!row)throw new Error('Reviewed bytes do not match proposal')
  if(row.state!=='pending')return {state:String(row.state)}
  const guard=async()=>{const current=await owned(owner,sessionId,proposalId,decision,signal);signal.throwIfAborted();if(current.current.runtime.dataRoot!==auth.current.runtime.dataRoot || current.current.runtime.launchNonce!==auth.current.runtime.launchNonce || current.current.workspaceRoot!==auth.current.workspaceRoot)throw new Error('Publication authority changed')}
  await guard()
  const claimed=await db.execute({sql:'UPDATE desktop_native_writeback_files SET state=? WHERE proposal_id=? AND path=? AND digest=? AND state=\'pending\'',args:[decision==='reject'?'rejected':'claimed',proposalId,path,digest]})
  if(claimed.rowsAffected!==1)return {state:'unavailable'}
  if(decision==='reject')return {state:'rejected'}
  let state='unknown',publicationStarted=false
  try{
   const item=file.parse(JSON.parse(String(row.payload)))
   const location=await privateFileLocation(auth.current.workspaceRoot,path)
   const parents=location.directories.map(dir=>({path:relative(auth.current.workspaceRoot,dir.path).split('\\').join('/'),identity:`${dir.dev}:${dir.ino}`}))
   if(JSON.stringify(parents)!==JSON.stringify(item.parents))throw new Error('Original directory changed')
   const snapshot=item.before?await readPrivateSnapshot(location):undefined
   if(item.before && (!snapshot || snapshot.version!==item.before.version || snapshot.identity!==item.before.identity || sha(snapshot.content)!==item.before.sha256))throw new Error('Original file changed')
   await guard()
   const publication={beforePublish:guard,existingDirectoryOnly:true as const,snapshot}
   publicationStarted=true
   if(snapshot)await saveCoworkerFile(auth.current.runtime,owner,path,item.after,snapshot.hash,snapshot.identity,publication)
   else {const slash=path.lastIndexOf('/');await importCoworkerFile(auth.current.runtime,owner,slash<0?'':path.slice(0,slash),path.slice(slash+1),Buffer.from(item.after),publication)}
   state='saved'
  }catch{state=publicationStarted?'unknown':'conflict'}
  const recorded=await db.execute({sql:'UPDATE desktop_native_writeback_files SET state=? WHERE proposal_id=? AND path=? AND state=\'claimed\'',args:[state,proposalId,path]})
  await guard()
  return {state:recorded.rowsAffected===1?state:'unknown'}
 }
 return {capture,list,decide}
}
