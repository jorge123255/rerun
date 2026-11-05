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

async function inspect(root:string,slug:string,publicationName?:string):Promise<OwnedSkill>{
 if(!/^svc-[a-f0-9]{16,24}-[0-9]+(?:-pending)?$/.test(slug))throw new Error('Invalid owned skill')
 const entry=publicationName??slug
 if(publicationName&&!/^\.rerun-skill-stage-[a-f0-9]{24}$/.test(publicationName))throw new Error('Invalid publication identity')
 const directory=await openWithoutLinks(join(root,entry),true)
 try{
  const stat=await directory.stat({bigint:true})
  if(!stat.isDirectory()||stat.uid!==BigInt(process.getuid?.()??-1))throw new Error('Owned skill changed; preserved')
  const file=await openWithoutLinks(join(root,entry,'SKILL.md'))
  try{
   const before=await file.stat({bigint:true})
   if(!before.isFile() || before.nlink!==BigInt(1) || before.uid!==BigInt(process.getuid?.()??-1) || before.size>BigInt(MAX_MANIFEST_BYTES) || (await readdir(join(root,entry))).some(name=>name!=='SKILL.md'))throw new Error('Service skill changed')
   const buffer=Buffer.alloc(MAX_MANIFEST_BYTES+1);let count=0
   while(count<buffer.length){const read=await file.read(buffer,count,buffer.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead}
   if(count>MAX_MANIFEST_BYTES)throw new Error('Service skill changed')
   const bytes=buffer.subarray(0,count),after=await file.stat({bigint:true})
   const directoryAfter=await lstat(join(root,entry),{bigint:true}),fileAfter=await lstat(join(root,entry,'SKILL.md'),{bigint:true})
   if(directoryAfter.isSymbolicLink()||directoryAfter.dev!==stat.dev||directoryAfter.ino!==stat.ino||fileAfter.isSymbolicLink()||version(fileAfter)!==version(after))throw new Error('Service skill changed')
   if(version(before)!==version(after))throw new Error('Service skill changed')
   return {slug,directoryIdentity:`${stat.dev}:${stat.ino}`,manifestVersion:version(after),contentHash:hash(bytes)}
  }finally{await file.close()}
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('Owned skill changed; preserved');throw error}finally{await directory.close()}
}

function sameResource(current:OwnedSkill,owned:OwnedSkill):boolean{
 return current.directoryIdentity===owned.directoryIdentity&&current.manifestVersion===owned.manifestVersion&&current.contentHash===owned.contentHash
}

export const serviceSkillHash=(skill:ServicePlan['skills'][number])=>hash(Buffer.from(serviceSkillManifest(skill),'utf8'))
export async function createServiceSkill(root:string,record:ServiceInstall,index:number,skill:ServicePlan['skills'][number],guard:()=>Promise<void>,journal:ServiceSkillJournal){
 await guard()
 const reservation=await journal.reserve(record,index,serviceSkillHash(skill))
 if(reservation.state==='reserved'){
  await publishNewSkill(root,reservation.stageSlug,skill,{beforeCommit:guard,servicePublication:true,beforePublish:async staged=>{
   await guard()
   if(staged.contentHash!==reservation.hash)throw new Error('Skill publication changed; preserved')
   await journal.update(reservation,'staged',{slug:reservation.stageSlug,directoryIdentity:staged.directoryIdentity,manifestVersion:staged.manifestVersion,contentHash:staged.contentHash},staged.name)
  }})
 }
 if(reservation.state==='staged'){
  const resource=reservation.resource
  if(!resource)throw new Error('Skill resource identity unavailable')
  await recoverStagedSkill(root,reservation,guard,false)
  const final=await inspect(root,reservation.slug)
  if(!sameResource(final,{...resource,slug:reservation.slug}))throw new Error('Skill publication changed; preserved')
  await journal.update(reservation,'published',final)
 }
 if(!reservation.resource)throw new Error('Skill resource unavailable')
 await guard();await verifyServiceSkill(root,reservation.resource)
 return reservation.resource
}

/** Resolve only a journalled inode. Never adopt equal bytes or a name alone. */
async function recoverStagedSkill(root:string,reservation:SkillReservation,guard:()=>Promise<void>,allowMissing:boolean):Promise<OwnedSkill>{
 const resource=reservation.resource
 if(!resource)throw new Error('Unacknowledged resource; preserved')
 let directory
 try{directory=await openWithoutLinks(root,true)}catch(error){if(allowMissing&&(error as NodeJS.ErrnoException).code==='ENOENT')return resource;throw error}
 try{
  const stat=await directory.stat({bigint:true}),identity={dev:stat.dev,ino:stat.ino}
  const lease=await acquireSkillLease(root,identity)
  try{
   await guard();lease.assertCurrent()
   const optional=async(slug:string,name?:string)=>{try{return await inspect(root,slug,name)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}}
   const final=await optional(reservation.slug)
   if(final){if(!sameResource(final,resource))throw new Error('Skill destination changed; preserved');return final}
   let staged=await optional(reservation.stageSlug)
   if(staged&&!sameResource(staged,resource))throw new Error('Skill staging changed; preserved')
   if(!staged&&reservation.publicationName){
    staged=await optional(reservation.stageSlug,reservation.publicationName)
    if(staged){
     if(!sameResource(staged,resource))throw new Error('Skill publication changed; preserved')
     const [dev,ino]=resource.directoryIdentity.split(':').map(BigInt)
     await guard();lease.assertCurrent()
     await renameSkillEntry(root,identity,reservation.publicationName,{dev:dev!,ino:ino!},reservation.stageSlug)
     await directory.sync()
    }
   }
   if(!staged){if(allowMissing)return resource;throw new Error('Owned skill is missing; preserved')}
   if(allowMissing)return {...resource,slug:reservation.stageSlug}
   const [dev,ino]=resource.directoryIdentity.split(':').map(BigInt)
   await guard();lease.assertCurrent();await verifyServiceSkill(root,{...resource,slug:reservation.stageSlug})
   await renameSkillEntry(root,identity,reservation.stageSlug,{dev:dev!,ino:ino!},reservation.slug)
   await directory.sync()
   const published=await inspect(root,reservation.slug)
   if(!sameResource(published,resource))throw new Error('Skill publication changed; preserved')
   return published
  }finally{await lease.release()}
 }finally{await directory.close()}
}

export async function resolveServiceSkillRemoval(root:string,reservation:SkillReservation,guard:()=>Promise<void>):Promise<OwnedSkill>{
 await guard()
 if(!reservation.resource)throw new Error('Unacknowledged resource; preserved')
 if(reservation.state!=='staged')return reservation.resource
 return recoverStagedSkill(root,reservation,guard,true)
}

export async function acknowledgeServiceSkill(journal:ServiceSkillJournal,reservation:SkillReservation){
 if(reservation.state==='published')await journal.update(reservation,'acknowledged',reservation.resource)
 else if(reservation.state!=='acknowledged')throw new Error('Skill acknowledgement unavailable')
}

export async function verifyServiceSkill(root:string,owned:OwnedSkill){const current=await inspect(root,owned.slug);if(!sameResource(current,owned))throw new Error('Owned skill changed; preserved')}

export async function removeServiceSkill(root:string,owned:OwnedSkill,guard:()=>Promise<void>){
 const check=async()=>{await guard();const current=await inspect(root,owned.slug);if(!sameResource(current,owned))throw new Error('Owned skill changed; preserved')}
 try{await check()}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
 await deleteSkillFolder(root,owned.slug,{beforeCommit:check,servicePublication:true})
}
