import 'server-only'
import type {Client,Row} from '@libsql/client'
import type {OwnedSkill,ServiceInstall,ServiceStore} from './store'
import {createHash} from 'node:crypto'
export type SkillReservation={owner:string;engineId:string;installationId:string;index:number;slug:string;stageSlug:string;hash:string;state:'reserved'|'staged'|'published'|'acknowledged'|'removed';resource:OwnedSkill|null}
export const serviceSkillMigrationSql=`CREATE TABLE desktop_service_skill_resources(owner TEXT NOT NULL, engine_id TEXT NOT NULL, installation_id TEXT NOT NULL, ordinal INTEGER NOT NULL, slug TEXT NOT NULL, stage_slug TEXT NOT NULL, content_hash TEXT NOT NULL, state TEXT NOT NULL, resource TEXT, PRIMARY KEY(owner,installation_id,ordinal), UNIQUE(owner,slug), UNIQUE(owner,stage_slug))`
const decode=(r:Row):SkillReservation=>({owner:String(r.owner),engineId:String(r.engine_id),installationId:String(r.installation_id),index:Number(r.ordinal),slug:String(r.slug),stageSlug:String(r.stage_slug),hash:String(r.content_hash),state:String(r.state) as SkillReservation['state'],resource:r.resource?JSON.parse(String(r.resource)):null})
export function serviceSkillJournal(db:Client){
 const read=async(owner:string,id:string,index:number)=>{const row=(await db.execute({sql:'SELECT * FROM desktop_service_skill_resources WHERE owner=? AND installation_id=? AND ordinal=?',args:[owner,id,index]})).rows[0];return row?decode(row):null}
 return {read,
  async reserve(record:ServiceInstall,index:number,hash:string){
   if(!/^[a-f0-9-]{36}$/.test(record.id)||!Number.isInteger(index)||index<0||index>=8||!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid skill reservation')
   const prefix=createHash('sha256').update(record.id).digest('hex').slice(0,24),slug=`svc-${prefix}-${index}`,stageSlug=`${slug}-pending`
   await db.execute({sql:"INSERT INTO desktop_service_skill_resources(owner,engine_id,installation_id,ordinal,slug,stage_slug,content_hash,state) VALUES(?,?,?,?,?,?,?,'reserved') ON CONFLICT(owner,installation_id,ordinal) DO NOTHING",args:[record.owner,record.engineId,record.id,index,slug,stageSlug,hash]})
   const reservation=await read(record.owner,record.id,index)
   if(!reservation||reservation.hash!==hash||reservation.engineId!==record.engineId||reservation.slug!==slug||reservation.state==='removed')throw new Error('Skill reservation changed; preserved')
   return reservation
  },
  async update(r:SkillReservation,state:SkillReservation['state'],resource:OwnedSkill|null){
   const result=await db.execute({sql:'UPDATE desktop_service_skill_resources SET state=?,resource=? WHERE owner=? AND engine_id=? AND installation_id=? AND ordinal=? AND state=? AND content_hash=?',args:[state,resource?JSON.stringify(resource):null,r.owner,r.engineId,r.installationId,r.index,r.state,r.hash]})
   if(result.rowsAffected!==1)throw new Error('Skill reservation conflict')
   r.state=state;r.resource=resource
  },
  async list(owner:string){return (await db.execute({sql:'SELECT * FROM desktop_service_skill_resources WHERE owner=? ORDER BY installation_id,ordinal',args:[owner]})).rows.map(decode)},
 }
}
export type ServiceSkillJournal=ReturnType<typeof serviceSkillJournal>
export async function currentSkillInstallation(store:ServiceStore,record:ServiceInstall){
 const current=await store.read(record.owner,record.key)
 if(!current||current.id!==record.id||current.engineId!==record.engineId||current.revision!==record.revision)throw new Error('Skill installation changed')
 return current
}
