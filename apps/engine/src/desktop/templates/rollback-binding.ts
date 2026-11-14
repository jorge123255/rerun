import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { desktopTemplateIdSchema, desktopTemplateRevisionSchema } from '@rerun/contracts'
import { raw } from '../../db/client.js'
import { checkpointAndCloseSystemDb } from '../../db/systemDb.js'
import { withAgentLock } from '../../agents/lock.js'
import { unloadAgent } from '../../agents/registry.js'
import { withDesktopAgentDeletion } from '../agent-lifecycle.js'
import { rollbackFreshTemplateCoworker } from './fidelity-recovery.js'
import { readManifest } from './install.js'
import { readOwnJson,writeOwnJson,requestHome } from './store.js'
import { withPortableLibraryLease } from './portable-lock.js'
import { canonicalJson,sha256 } from './hash.js'
import { TemplateRequestError } from './errors.js'
export const rollbackInstallSchema=z.strictObject({requestId:z.uuid(),importReceiptId:z.uuid(),templateId:desktopTemplateIdSchema,revision:desktopTemplateRevisionSchema,coworkers:z.array(z.strictObject({engineAgentId:z.string().regex(/^i[a-f0-9]{31}$/),agentKey:z.string().regex(/^c[0-9]{2}$/)})).min(1).max(12)})
export type RollbackInstall=z.infer<typeof rollbackInstallSchema>
function childId(input:RollbackInstall,id:string){const hex=createHash('sha256').update(input.requestId+'\0'+id).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`}
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT'
async function assertUnpublished(input:RollbackInstall){
 const origin=new URL(process.env.RERUN_HUB_BASE_URL??''),token=process.env.RERUN_API_KEY
 if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||!origin.port||origin.pathname!=='/'||origin.username||origin.password||!token)throw new TemplateRequestError(503,'Import cleanup authority is unavailable')
 const response=await fetch(`${origin.origin}/api/desktop/internal/template-rollback`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(10000)})
 if(!response.ok)throw new TemplateRequestError(409,'The import is no longer an unpublished cleanup attempt')
 const reader=response.body?.getReader();if(!reader)throw new TemplateRequestError(503,'Import cleanup acknowledgement is missing')
 const chunks:Uint8Array[]=[];let size=0
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>8192)throw new TemplateRequestError(409,'Invalid import cleanup acknowledgement');chunks.push(part.value)}
 const result=z.strictObject({requestId:z.uuid(),importReceiptId:z.uuid(),unpublished:z.literal(true)}).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
 if(result.requestId!==input.requestId||result.importReceiptId!==input.importReceiptId)throw new TemplateRequestError(409,'Import cleanup identity changed')
 }finally{void reader.cancel().catch(()=>{})}
}
/** Only the unpublished exact import can enter this destructive recovery path. */
export async function rollbackDesktopTemplateInstall(rawInput:unknown,roots:{dataRoot:string;agentsRoot:string}){
 const input=rollbackInstallSchema.parse(rawInput),fingerprint=sha256(canonicalJson(input))
 await assertUnpublished(input)
 await withPortableLibraryLease(roots.dataRoot,async()=>{
  const manifest=await readManifest(roots.dataRoot,input.templateId,input.revision)
  if(input.coworkers.length!==manifest.coworkers.length||new Set(input.coworkers.map(row=>row.engineAgentId)).size!==input.coworkers.length||manifest.coworkers.some(row=>input.coworkers.filter(item=>item.agentKey===row.agentKey).length!==1))throw new TemplateRequestError(409,'Cleanup must match the complete saved import')
  const prior=await readOwnJson(requestHome(roots.dataRoot),`cancel-install-${input.importReceiptId}.json`)
  if(prior&&canonicalJson(prior)!==canonicalJson({version:1,fingerprint,input}))throw new TemplateRequestError(409,'Import cleanup belongs to a different request')
  await writeOwnJson(requestHome(roots.dataRoot),`cancel-install-${input.importReceiptId}.json`,{version:1,fingerprint,input})
 })
 const manifest = await readManifest(roots.dataRoot,input.templateId,input.revision)
 for(const member of input.coworkers){
  const request={requestId:childId(input,member.engineAgentId),importReceiptId:input.importReceiptId,templateId:input.templateId,revision:input.revision,...member}
  const receipt=await readOwnJson(requestHome(roots.dataRoot),`rollback-${request.requestId}.json`) as {phase?:string;fingerprint?:string;dev?:string;ino?:string}|null
  if(receipt&&receipt.fingerprint!==sha256(canonicalJson(request)))throw new TemplateRequestError(409,'Cleanup receipt changed')
  if(receipt?.phase==='removed')continue
  await withAgentLock(member.engineAgentId,()=>withDesktopAgentDeletion(member.engineAgentId,async()=>{
   await assertUnpublished(input)
   const folder=join(roots.agentsRoot,member.engineAgentId),quarantine=join(roots.agentsRoot,`.template-rollback-${request.requestId}`)
   const present=await lstat(folder,{bigint:true}).catch(error=>{if(missing(error))return null;throw error}),queued=await lstat(quarantine,{bigint:true}).catch(error=>{if(missing(error))return null;throw error})
   const index=(await raw().execute({sql:'SELECT name,status,created_at FROM agents WHERE id=?',args:[member.engineAgentId]})).rows[0]
   if(!present&&!queued&&!receipt){if(index)throw new TemplateRequestError(409,'Missing import folder has an existing index');return}
   const marker=await readOwnJson(present?folder:quarantine,'.desktop-template-import.json') as {foremanDisabled?:boolean;shareDisabled?:boolean;indexCreatedAt?:string;folder?:{dev:string;ino:string}}|null
   const pinned = present ?? queued
   const identity = marker?.folder ?? (receipt?.phase==='index-removed' && receipt.dev && receipt.ino ? {dev:receipt.dev,ino:receipt.ino}:null)
   if(marker?.foremanDisabled || marker?.shareDisabled || !identity || (pinned && (String(pinned.dev)!==identity.dev||String(pinned.ino)!==identity.ino)))throw new TemplateRequestError(409,'This import has no exact fresh-folder cleanup proof')
   if(index&&(index.name!==manifest.coworkers.find(row=>row.agentKey===member.agentKey)?.name||index.status!=='idle'||!marker?.indexCreatedAt||index.created_at!==marker.indexCreatedAt))throw new TemplateRequestError(409,'The imported coworker has changed or started working')
   const initial=index?{name:String(index.name),createdAt:String(index.created_at)}:null
   // Startup may have initialized an empty system DB. Close its writer under the
   // deletion lease before taking the byte snapshot or renaming the owned folder.
   await checkpointAndCloseSystemDb(member.engineAgentId)
   await rollbackFreshTemplateCoworker(request,{...roots,withFreshImportLease:async(_request,work)=>{
    // The enclosing config lock + deletion lease excludes live work throughout this callback.
    await assertUnpublished(input); return work()
   },removeOwnedIndex:async()=>{
    await assertUnpublished(input)
    const current=(await raw().execute({sql:'SELECT name,status,created_at FROM agents WHERE id=?',args:[member.engineAgentId]})).rows[0]
    if(!current)return'absent'
    if(!initial||current.name!==initial.name||current.created_at!==initial.createdAt||current.status!=='idle')return'changed'
    const changed=await raw().execute({sql:"DELETE FROM agents WHERE id=? AND name=? AND created_at=? AND status='idle'",args:[member.engineAgentId,initial.name,initial.createdAt]})
    return changed.rowsAffected===1?'removed':'changed'
   }})
   unloadAgent(member.engineAgentId)
  }))
 }
 return {status:'rolled-back' as const,requestId:input.requestId,importReceiptId:input.importReceiptId}
}
