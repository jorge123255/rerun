import 'server-only'
import {createHash} from 'node:crypto'
import {readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {publishNewSkill,deleteSkillFolder} from '../../../../../engine/src/desktop/skill-publication'
import {openWithoutLinks} from '../../../../../engine/src/desktop/open-without-links'
import type {OwnedSkill} from './store'
import type {ServicePlan} from './compiler'

const MAX_MANIFEST_BYTES=131072
const version=(s:import('node:fs').BigIntStats)=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
const manifestFor=(skill:ServicePlan['skills'][number])=>`---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body.trim()}\n`
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')

async function inspect(root:string,slug:string):Promise<OwnedSkill>{
 if(!/^svc-[a-f0-9]{16}-[0-9]+$/.test(slug))throw new Error('Invalid owned skill')
 const directory=await openWithoutLinks(join(root,slug),true)
 try{
  const stat=await directory.stat({bigint:true}),file=await openWithoutLinks(join(root,slug,'SKILL.md'))
  try{
   const before=await file.stat({bigint:true})
   if(!before.isFile() || before.nlink!==BigInt(1) || before.uid!==BigInt(process.getuid?.()??-1) || before.size>BigInt(MAX_MANIFEST_BYTES) || (await readdir(join(root,slug))).some(name=>name!=='SKILL.md'))throw new Error('Service skill changed')
   const bytes=await file.readFile(),after=await file.stat({bigint:true})
   if(version(before)!==version(after))throw new Error('Service skill changed')
   return {slug,directoryIdentity:`${stat.dev}:${stat.ino}`,manifestVersion:version(after),contentHash:hash(bytes)}
  }finally{await file.close()}
 }finally{await directory.close()}
}

function sameResource(current:OwnedSkill,owned:OwnedSkill):boolean{
 return current.directoryIdentity===owned.directoryIdentity&&current.manifestVersion===owned.manifestVersion&&current.contentHash===owned.contentHash
}

export async function createServiceSkill(root:string,id:string,index:number,skill:ServicePlan['skills'][number],guard:()=>Promise<void>){
 const slug=`svc-${id.replaceAll('-','').slice(0,16)}-${index}`,expected=hash(Buffer.from(manifestFor(skill),'utf8'))
 try{await publishNewSkill(root,slug,skill,{beforeCommit:guard})}catch(error){
  const existing=await inspect(root,slug)
  if(existing.contentHash!==expected)throw new Error('Owned skill changed; preserved',{cause:error})
  return existing
 }
 const created=await inspect(root,slug)
 if(created.contentHash!==expected)throw new Error('Owned skill changed; preserved')
 return created
}

export async function verifyServiceSkill(root:string,owned:OwnedSkill){const current=await inspect(root,owned.slug);if(!sameResource(current,owned))throw new Error('Owned skill changed; preserved')}

export async function removeServiceSkill(root:string,owned:OwnedSkill,guard:()=>Promise<void>){
 const check=async()=>{await guard();const current=await inspect(root,owned.slug);if(!sameResource(current,owned))throw new Error('Owned skill changed; preserved')}
 try{await check()}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
 await deleteSkillFolder(root,owned.slug,{beforeCommit:check})
}
