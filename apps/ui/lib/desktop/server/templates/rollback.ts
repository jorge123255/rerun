import 'server-only'
import { createHash } from 'node:crypto'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { desktopTemplateIdSchema,desktopTemplateRevisionSchema } from '@rerun/contracts'
import { DesktopHttpError,authenticateDesktopEngineRequest } from '../auth'
import { openDesktopDatabase } from '../database'
import { withRosterWrite } from '../roster-writes'
import { withTemplateRequestWrite,type DesktopTemplateEngineClient } from './server'
const member=z.object({agentId:z.uuid(),engineAgentId:z.string().regex(/^i[a-f0-9]{31}$/),agentKey:z.string().regex(/^c[0-9]{2}$/),phase:z.enum(['reserved','folder','indexed','placed'])})
const payloadSchema=z.object({coworkers:z.array(member).min(1).max(12),rollback:z.object({requestId:z.uuid(),complete:z.boolean()}).optional()}).passthrough()
const engineBody=z.strictObject({requestId:z.uuid(),importReceiptId:z.uuid(),templateId:desktopTemplateIdSchema,revision:desktopTemplateRevisionSchema,coworkers:z.array(member.pick({engineAgentId:true,agentKey:true}).strict()).min(1).max(12)})
const rollbackId=(id:string,receipt:string)=>{const hash=createHash('sha256').update('template-cleanup\0'+id+'\0'+receipt).digest('hex');return`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`}
async function record(db:Client,requestId:string){
 const row=(await db.execute({sql:"SELECT * FROM desktop_template_requests WHERE request_id=? AND operation='install'",args:[requestId]})).rows[0]
 if(!row)throw new DesktopHttpError(404,'Installation not found')
 return{row,payload:payloadSchema.parse(JSON.parse(String(row.payload)))}
}
async function unpublished(db:Client,payload:z.infer<typeof payloadSchema>){
 if(payload.coworkers.some(row=>row.phase==='placed'))throw new DesktopHttpError(409,'An installed coworker cannot use interrupted-import cleanup')
 for(const coworker of payload.coworkers){
  const rows=await db.execute({sql:'SELECT id FROM desktop_agents WHERE id=? OR engine_agent_id=?',args:[coworker.agentId,coworker.engineAgentId]})
  if(rows.rows.length)throw new DesktopHttpError(409,'A coworker from this import is already in the workspace')
 }
}
/** Explicit whole-attempt cancellation; the saved intent stays cancelled even if cleanup is interrupted. */
export async function rollbackDesktopTemplateRequest(db:Client,engine:DesktopTemplateEngineClient,raw:unknown){
 const input=z.strictObject({requestId:z.uuid()}).parse(raw)
 return withTemplateRequestWrite(input.requestId,()=>withRosterWrite(async()=>{
  const {row,payload}=await record(db,input.requestId)
  if(row.status==='installed')throw new DesktopHttpError(409,'This template was already installed')
  await unpublished(db,payload)
  const requestId=rollbackId(input.requestId,String(row.receipt_id))
  if(payload.rollback&&payload.rollback.requestId!==requestId)throw new DesktopHttpError(409,'Import cleanup identity changed')
  if(payload.rollback?.complete)return{status:'rolled-back' as const,requestId:input.requestId}
  // UI receipts reserve template/revision after engine admission, so the immutable intent is
  // the source of identity if the first engine acknowledgement was lost.
  const intent=(await db.execute({sql:'SELECT operation FROM desktop_template_intents WHERE request_id=?',args:[input.requestId]})).rows[0]
  const operation=intent?JSON.parse(String(intent.operation)):null
  const templateId=desktopTemplateIdSchema.parse(row.template_id??operation?.templateId),revision=desktopTemplateRevisionSchema.parse(row.revision??operation?.revision)
  payload.rollback={requestId,complete:false}
  await db.execute({sql:"UPDATE desktop_template_requests SET status='rolling-back',payload=?,updated_at=? WHERE request_id=? AND receipt_id=? AND status!='installed'",args:[JSON.stringify(payload),new Date().toISOString(),input.requestId,String(row.receipt_id)]})
  const body=engineBody.parse({requestId,importReceiptId:String(row.receipt_id),templateId,revision,coworkers:payload.coworkers.map(({engineAgentId,agentKey})=>({engineAgentId,agentKey}))})
  const result=z.strictObject({status:z.literal('rolled-back'),requestId:z.uuid(),importReceiptId:z.uuid()}).parse(await engine.post('/desktop/templates/rollback-install',body))
  if(result.requestId!==requestId||result.importReceiptId!==row.receipt_id)throw new DesktopHttpError(502,'Import cleanup acknowledgement changed')
  await unpublished(db,payload)
  payload.rollback={requestId,complete:true}
  await db.execute({sql:"UPDATE desktop_template_requests SET status='refused',payload=?,updated_at=? WHERE request_id=? AND receipt_id=? AND status='rolling-back'",args:[JSON.stringify(payload),new Date().toISOString(),input.requestId,String(row.receipt_id)]})
  return{status:'rolled-back' as const,requestId:input.requestId}
 }))
}
export async function handleDesktopTemplateRollbackAuthority(request:Request){
 try{
  const runtime=await authenticateDesktopEngineRequest(request)
  const text=await request.text();if(Buffer.byteLength(text)>8192)throw new DesktopHttpError(413,'Cleanup request too large')
  const input=engineBody.parse(JSON.parse(text)),db=await openDesktopDatabase(runtime.dataRoot)
  const rows=(await db.execute({sql:"SELECT request_id FROM desktop_template_requests WHERE receipt_id=? AND operation='install' AND status='rolling-back'",args:[input.importReceiptId]})).rows
  if(rows.length!==1)throw new DesktopHttpError(409,'Cleanup claim is unavailable')
  const {row,payload}=await record(db,String(rows[0].request_id));await unpublished(db,payload)
  const intent=(await db.execute({sql:'SELECT operation FROM desktop_template_intents WHERE request_id=?',args:[String(row.request_id)]})).rows[0]
  const operation=intent?JSON.parse(String(intent.operation)):null
  if(payload.rollback?.requestId!==input.requestId||payload.rollback.complete||input.templateId!==(row.template_id??operation?.templateId)||input.revision!==(row.revision??operation?.revision)||JSON.stringify(input.coworkers)!==JSON.stringify(payload.coworkers.map(({engineAgentId,agentKey})=>({engineAgentId,agentKey}))))throw new DesktopHttpError(409,'Cleanup source changed')
  return Response.json({requestId:input.requestId,importReceiptId:input.importReceiptId,unpublished:true},{headers:{'cache-control':'no-store'}})
 }catch{return Response.json({error:'Could not verify this unpublished installation.'},{status:409})}
}
