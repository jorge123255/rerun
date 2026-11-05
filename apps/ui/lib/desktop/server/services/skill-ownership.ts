import 'server-only'
import type {ServiceStore} from './store'
import type {ServiceSkillJournal} from './skill-journal'
import {verifyServiceSkill} from './skill-resources'
export type ConnectorSkillOwner={slug:string;serviceKey:string;serviceName:string;installationId:string;readOnly:true;exportable:false;verified:boolean;reason:string}
export function connectorSkillAuthority(store:ServiceStore,journal:ServiceSkillJournal,current:(owner:string)=>Promise<{engineId:string;skillsRoot:string}>){
 async function projection(owner:string):Promise<ConnectorSkillOwner[]>{
  const authority=await current(owner),records=await store.list(owner),reservations=await journal.list(owner),output:ConnectorSkillOwner[]=[]
  for(const record of records){
   for(const skill of record.skills){
    const reserved=reservations.find(r=>r.installationId===record.id&&r.slug===skill.slug)
    let verified=false
    if(record.engineId===authority.engineId&&reserved?.engineId===authority.engineId&&reserved.state==='acknowledged'&&reserved.resource&&reserved.hash===skill.contentHash&&JSON.stringify(reserved.resource)===JSON.stringify(skill)){
     try{await verifyServiceSkill(authority.skillsRoot,skill);verified=true}catch{}
    }
    output.push({slug:skill.slug,serviceKey:record.key,serviceName:record.plan.name,installationId:record.id,readOnly:true,exportable:false,verified,reason:verified?'This skill is managed by its app.':'App skill ownership needs reconciliation; content is preserved.'})
   }
  }
  for(const reservation of reservations){
   for(const slug of [reservation.slug,reservation.stageSlug])if(reservation.state!=='removed'&&!output.some(s=>s.slug===slug))output.push({slug,serviceKey:'',serviceName:'App',installationId:reservation.installationId,readOnly:true,exportable:false,verified:false,reason:'Reserved app resource; ownership is not acknowledged.'})
  }
  const after=await current(owner)
  if(after.engineId!==authority.engineId||after.skillsRoot!==authority.skillsRoot)throw new Error('App skill owner changed')
  return output
 }
 return {projection,
  async assertUserOperation(owner:string,slug:string,operation:'edit'|'delete'|'capture'|'export'){
   const owned=(await projection(owner)).find(s=>s.slug===slug)
   if(owned||slug.startsWith('svc-'))throw new Error(owned?.reason??'Unknown app skill ownership; reconcile before changing or exporting it.')
   return {allowed:true as const,operation}
  },
  async assertReady(owner:string,installationId:string){
   const record=(await store.list(owner)).find(r=>r.id===installationId)
   if(!record||record.skills.length!==record.plan.skills.length)throw new Error('Required app skills are incomplete')
   const projected=await projection(owner)
   if(record.skills.some(s=>!projected.some(p=>p.slug===s.slug&&p.installationId===installationId&&p.verified)))throw new Error('Required app skills are unverified')
  },
 }
}
