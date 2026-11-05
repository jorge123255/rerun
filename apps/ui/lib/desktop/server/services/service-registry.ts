import 'server-only'

import {join} from 'node:path'
import type {RegistryEntry} from '@/lib/services/registry'
import {ownersOfRegistryJson,readConfinedFile,writeConfinedFile} from '../../../../../engine/src/desktop/skill-publication'
import type {ServiceInstall} from './store'

type DesktopRegistryEntry=RegistryEntry&{desktopInstallationId?:string}
type DesktopServiceRegistry={services:Record<string,DesktopRegistryEntry>}

export function desktopServiceRegistryName(installationId:string):string{
 return `svc-${installationId.replaceAll('-','')}`
}

export function desktopServiceRegistryProjection(current:DesktopServiceRegistry|null,records:ServiceInstall[]):DesktopServiceRegistry{
 const services=Object.fromEntries(Object.entries(current?.services??{}).filter(([,entry])=>typeof entry.desktopInstallationId!=='string'))
 for(const record of records){
  services[record.key]={
   status:record.state==='ready'?'active':'needs_config',config:{},authMethodId:record.plan.methodId,
   mcpServers:[desktopServiceRegistryName(record.id)],envKeys:[],skills:record.skills.map(skill=>skill.slug),
   installedAt:record.installedAt,desktopInstallationId:record.id,
  }
 }
 return {services}
}

export async function syncDesktopServiceRegistry(skillsRoot:string,records:ServiceInstall[],signal:AbortSignal):Promise<void>{
 const root=join(skillsRoot,'..','workspace','.rerun')
 const existing=await readConfinedFile(root,'services.json',0,{signal})
 if(existing?.truncated)throw new Error('Service ownership registry is too large or incomplete')
 if(!existing&&records.length===0)return
 let current:DesktopServiceRegistry|null=null
 if(existing){
  ownersOfRegistryJson(existing.content)
  current=JSON.parse(existing.content) as DesktopServiceRegistry
  for(const entry of Object.values(current.services))if('desktopInstallationId' in entry&&typeof entry.desktopInstallationId!=='string')throw new Error('Service ownership registry is invalid')
 }
 const projected=desktopServiceRegistryProjection(current,records)
 await writeConfinedFile(root,'services.json',`${JSON.stringify(projected,null,2)}\n`,{
  signal,createOnly:!existing,baseIdentity:existing?.identity,completeRead:!!existing,
 })
}
