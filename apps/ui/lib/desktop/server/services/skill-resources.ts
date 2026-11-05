import 'server-only'
import {createHash} from 'node:crypto'
import {readdir,lstat} from 'node:fs/promises'
import {join} from 'node:path'
import {publishNewSkill,deleteSkillFolder} from '../../../../../engine/src/desktop/skill-publication'
import {openWithoutLinks} from '../../../../../engine/src/desktop/open-without-links'
import {acquireSkillLease,renameSkillEntry} from '../../../../../engine/src/desktop/skill-publication-native'
import type {ServiceSkillJournal,SkillReservation} from './skill-journal'
import type {ServiceInstall} from './store'
import type {OwnedSkill} from './store'
import type {ServicePlan} from './compiler'

const MAX_MANIFEST_BYTES=131072
const version=(s:import('node:fs').BigIntStats)=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
export const serviceSkillManifest=(skill:ServicePlan['skills'][number])=>`---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body.trim()}\n`
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')

async function inspect(root:string,slug:string):Promise<OwnedSkill>{
 if(!/^svc-[a-f0-9]{16,24}-[0-9]+(?:-pending)?$/.test(slug))throw new Error('Invalid owned skill')
 const directory=await openWithoutLinks(join(root,slug),true)
 try{
  const stat=await directory.stat({bigint:true}),file=await openWithoutLinks(join(root,slug,'SKILL.md'))
  try{
   const before=await file.stat({bigint:true})
   if(!before.isFile() || before.nlink!==BigInt(1) || before.uid!==BigInt(process.getuid?.()??-1) || before.size>BigInt(MAX_MANIFEST_BYTES) || (await readdir(join(root,slug))).some(name=>name!=='SKILL.md'))throw new Error('Service skill changed')
   const bytes=await file.readFile(),after=await file.stat({bigint:true})
   const directoryAfter=await lstat(join(root,slug),{bigint:true}),fileAfter=await lstat(join(root,slug,'SKILL.md'),{bigint:true})
   if(directoryAfter.isSymbolicLink()||directoryAfter.dev!==stat.dev||directoryAfter.ino!==stat.ino||fileAfter.isSymbolicLink()||version(fileAfter)!==version(after))throw new Error('Service skill changed')
   if(version(before)!==version(after))throw new Error('Service skill changed')
   return {slug,directoryIdentity:`${stat.dev}:${stat.ino}`,manifestVersion:version(after),contentHash:hash(bytes)}
  }finally{await file.close()}
 }finally{await directory.close()}
}

function sameResource(current:OwnedSkill,owned:OwnedSkill):boolean{
 return current.directoryIdentity===owned.directoryIdentity&&current.manifestVersion===owned.manifestVersion&&current.contentHash===owned.contentHash
}

export const serviceSkillHash=(skill:ServicePlan['skills'][number])=>hash(Buffer.from(serviceSkillManifest(skill),'utf8'))
export async function createServiceSkill(root:string,record:ServiceInstall,index:number,skill:ServicePlan['skills'][number],guard:()=>Promise<void>,journal:ServiceSkillJournal){
 await guard()
 const reservation=await journal.reserve(record,index,serviceSkillHash(skill))
 if(reservation.state==='reserved'){
  // Existing same-byte folders are NOT evidence of ownership. Lost staging ACK is blocked.
  await publishNewSkill(root,reservation.stageSlug,skill,{beforeCommit:guard})
  const stage=await inspect(root,reservation.stageSlug)
  if(stage.contentHash!==reservation.hash)throw new Error('Skill publication changed; preserved')
  await journal.update(reservation,'staged',stage)
 }
 if(reservation.state==='staged'){
  const resource=reservation.resource
  if(!resource)throw new Error('Skill resource identity unavailable')
  try{
   const final=await inspect(root,reservation.slug)
   if(!sameResource(final,{...resource,slug:reservation.slug}))throw new Error('Skill destination changed; preserved')
  }catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
   await verifyServiceSkill(root,resource)
   const directory=await openWithoutLinks(root,true)
   try{
    const stat=await directory.stat({bigint:true}),identity={dev:stat.dev,ino:stat.ino}
    const lease=await acquireSkillLease(root,identity)
    try{
     await guard();lease.assertCurrent();await verifyServiceSkill(root,resource)
     const [dev,ino]=resource.directoryIdentity.split(':').map(BigInt)
     await renameSkillEntry(root,identity,reservation.stageSlug,{dev:dev!,ino:ino!},reservation.slug)
     await directory.sync()
    }finally{await lease.release()}
   }finally{await directory.close()}
  }
  const final=await inspect(root,reservation.slug)
  if(!sameResource(final,{...resource,slug:reservation.slug}))throw new Error('Skill publication changed; preserved')
  await journal.update(reservation,'published',final)
 }
 if(!reservation.resource)throw new Error('Skill resource unavailable')
 await guard();await verifyServiceSkill(root,reservation.resource)
 return reservation.resource
}

export async function resolveServiceSkillRemoval(root:string,reservation:SkillReservation):Promise<OwnedSkill>{
 if(!reservation.resource)throw new Error('Unacknowledged resource; preserved')
 if(reservation.state!=='staged')return reservation.resource
 const final={...reservation.resource,slug:reservation.slug}
 try{await verifyServiceSkill(root,final);return final}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 return reservation.resource
}

export async function acknowledgeServiceSkill(journal:ServiceSkillJournal,reservation:SkillReservation){
 if(reservation.state==='published')await journal.update(reservation,'acknowledged',reservation.resource)
 else if(reservation.state!=='acknowledged')throw new Error('Skill acknowledgement unavailable')
}

export async function verifyServiceSkill(root:string,owned:OwnedSkill){const current=await inspect(root,owned.slug);if(!sameResource(current,owned))throw new Error('Owned skill changed; preserved')}

export async function removeServiceSkill(root:string,owned:OwnedSkill,guard:()=>Promise<void>){
 const check=async()=>{await guard();const current=await inspect(root,owned.slug);if(!sameResource(current,owned))throw new Error('Owned skill changed; preserved')}
 try{await check()}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
 await deleteSkillFolder(root,owned.slug,{beforeCommit:check})
}
