import 'server-only'
import {join} from 'node:path'
import {readdir} from 'node:fs/promises'
import {publishNewSkill,deleteSkillFolder} from '../../../../../engine/src/desktop/skill-publication'
import {openWithoutLinks} from '../../../../../engine/src/desktop/open-without-links'
import type {OwnedSkill} from './store'
import type {ServicePlan} from './compiler'
const version=(s:import('node:fs').BigIntStats)=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
async function inspect(root:string,slug:string):Promise<OwnedSkill>{
 if(!/^svc-[a-f0-9]{16}-[0-9]+$/.test(slug))throw new Error('Invalid owned skill')
 const directory=await openWithoutLinks(join(root,slug),true)
 try{const stat=await directory.stat({bigint:true}),file=await openWithoutLinks(join(root,slug,'SKILL.md'));try{const current=await file.stat({bigint:true});if(!current.isFile() || current.nlink!==BigInt(1) || current.uid!==BigInt(process.getuid?.()??-1) || (await readdir(join(root,slug))).some(name=>name!=='SKILL.md'))throw new Error('Service skill changed');return {slug,directoryIdentity:`${stat.dev}:${stat.ino}`,manifestVersion:version(current)}}finally{await file.close()}}finally{await directory.close()}
}
export async function createServiceSkill(root:string,id:string,index:number,skill:ServicePlan['skills'][number],guard:()=>Promise<void>){
 const slug=`svc-${id.replaceAll('-','').slice(0,16)}-${index}`
 await publishNewSkill(root,slug,skill,{beforeCommit:guard})
 return inspect(root,slug)
}
export async function verifyServiceSkill(root:string,owned:OwnedSkill){const current=await inspect(root,owned.slug);if(current.directoryIdentity!==owned.directoryIdentity||current.manifestVersion!==owned.manifestVersion)throw new Error('Owned skill changed; preserved')}
export async function removeServiceSkill(root:string,owned:OwnedSkill,guard:()=>Promise<void>){
 const check=async()=>{await guard();const current=await inspect(root,owned.slug);if(current.directoryIdentity!==owned.directoryIdentity || current.manifestVersion!==owned.manifestVersion)throw new Error('Owned skill changed; preserved')}
 try{await check()}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
 await deleteSkillFolder(root,owned.slug,{beforeCommit:check})
}
