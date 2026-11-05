import 'server-only'
import {randomUUID} from 'node:crypto'
import type {DesktopServiceHealth} from '@rerun/contracts'
import {remoteMcpLifecycle} from '../mcp/lifecycle'
import {abortable,remoteMcpRuntime} from '../mcp/remote'
import type {RemoteMcpStore} from '../mcp/store'
import type {DesktopRuntime} from '../runtime'
import type {ServiceStore,ServiceInstall} from './store'
import {compileLocalService} from './compiler'
import {createServiceSkill,removeServiceSkill,verifyServiceSkill} from './skill-resources'
import {getDesktopServiceManifest,getDesktopServiceMethodAvailability} from './catalog/index'
export type ServiceRun={engineAgentId:string;sessionId:string;runId:string}
export type ServiceAuthority=(owner:string,action:'manage'|'use',run:ServiceRun|undefined,signal:AbortSignal)=>Promise<{engineAgentId:string;runtime:DesktopRuntime;skillsRoot:string;enabled:boolean;granted:boolean}>
export type ServiceToolNames=(owner:string,installationId:string,names:string[],signal:AbortSignal)=>Promise<void>
export function localServiceLifecycle(store:ServiceStore,authorize:ServiceAuthority,assertToolNames:ServiceToolNames,network:typeof fetch=fetch){
 const lifecycle=remoteMcpLifecycle(),shutdown=new AbortController()
 const active=new Map<string,Promise<unknown>>()
 const idName=(record:ServiceInstall)=>`svc-${record.id.replaceAll('-','')}`
 async function current(owner:string,action:'manage'|'use',run:ServiceRun|undefined,signal:AbortSignal){signal.throwIfAborted();shutdown.signal.throwIfAborted();const value=await abortable(authorize(owner,action,run,signal),signal);signal.throwIfAborted();shutdown.signal.throwIfAborted();if(action==='use'&&(!value.enabled||!value.granted))throw new Error('Service permission is off');return value}
 async function liveRecord(owner:string,key:string,revision:string,signal:AbortSignal){const record=await abortable(store.read(owner,key),signal);signal.throwIfAborted();if(!record || record.revision!==revision || record.state!=='ready')throw new Error('Service connection changed');return record}
 function transport(record:ServiceInstall,run:ServiceRun|undefined,signal:AbortSignal){
  const reader:RemoteMcpStore={lifecycle,
   list:async()=>[],read:async(owner,name)=>{if(owner!==record.owner||name!==idName(record))throw new Error('Service owner mismatch');const now=await liveRecord(owner,record.key,record.revision,signal);return {name,url:now.plan.url,revision:now.revision,bearer:await abortable(store.credential(owner,now.id),signal)}},
   readOAuth:async()=>null,writeOAuth:async()=>{throw new Error('Service OAuth unavailable')},save:async()=>{throw new Error('Read-only service transport')},remove:async()=>{throw new Error('Read-only service transport')},
  }
  return remoteMcpRuntime(reader,async(owner)=>{const authority=await current(owner,'use',run,signal);if(authority.engineAgentId!==record.engineId)throw new Error('Service owner changed');return {enabled:authority.enabled,granted:authority.granted}},network)
 }
 async function view(record:ServiceInstall,signal:AbortSignal){
  const authority=await current(record.owner,'manage',undefined,signal)
  const healthy=authority.engineAgentId===record.engineId&&record.state==='ready'&&authority.enabled&&authority.granted&&record.health.state==='healthy'&&record.healthLaunch===authority.runtime.launchNonce&&Date.now()>=Date.parse(record.health.checkedAt??'')&&Date.now()-Date.parse(record.health.checkedAt??'')<60_000
  const health:DesktopServiceHealth=healthy?record.health:record.state==='disconnected'?{state:'disconnected',message:'Local credentials removed. This does not revoke the remote API key.'}:!authority.enabled||!authority.granted?{state:'unchecked',message:'Enable Apps in this coworker’s Tools to check the connection.'}:record.health.state==='error'?record.health:{state:'unchecked',message:'Connection health is not established for the current permissions and app launch.'}
  return {key:record.key,slug:record.plan.slug,name:record.plan.name,category:record.plan.category,icon:record.plan.icon,revision:record.revision,health,installed:healthy,status:healthy?'active' as const:record.state==='error'?'error' as const:'needs_config' as const,authMethodId:record.plan.methodId,installedAt:record.installedAt,toolNames:healthy?record.toolNames:[],configured:record.plan.secretInput?{[record.plan.secretInput]:record.configured}:{}}
 }
 async function discover(record:ServiceInstall,run:ServiceRun|undefined,signal:AbortSignal){
  const initial=await current(record.owner,'use',run,signal);if(initial.engineAgentId!==record.engineId)throw new Error('Service owner changed');for(const skill of record.skills)await verifyServiceSkill(initial.skillsRoot,skill)
  const runtime=transport(record,run,signal),result=await runtime.probe(record.owner,idName(record),record.revision,signal)
  await current(record.owner,'use',run,signal);await liveRecord(record.owner,record.key,record.revision,signal)
  if(!result.tools)throw new Error('Connection discovery failed')
  const names=result.tools.map(tool=>`${record.plan.serverName}_${tool.name}`)
  if(names.some(name=>! /^[\w.-]{1,128}$/.test(name)))throw new Error('Service tool name exceeds limit')
  await assertToolNames(record.owner,record.id,names,signal)
  const authority=await current(record.owner,'use',run,signal)
  if(authority.engineAgentId!==record.engineId||authority.skillsRoot!==initial.skillsRoot)throw new Error('Service owner changed');for(const skill of record.skills)await verifyServiceSkill(authority.skillsRoot,skill)
  record.toolNames=names;record.health={state:'healthy',checkedAt:new Date().toISOString(),toolCount:names.length};record.healthLaunch=authority.runtime.launchNonce
  await store.update(record,record.revision)
  await current(record.owner,'use',run,signal);return {...result,tools:result.tools}
 }
 async function probe(owner:string,key:string,revision:string,signal:AbortSignal){
  const record=await liveRecord(owner,key,revision,signal)
  const authority=await current(owner,'manage',undefined,signal)
  if(!authority.enabled||!authority.granted){record.toolNames=[];record.health={state:'unchecked'};record.healthLaunch=null;await store.update(record,revision);return view(record,signal)}
  try{await discover(record,undefined,signal)}catch{record.toolNames=[];record.health={state:'error',checkedAt:new Date().toISOString(),message:'Connection unavailable. Check current permission and configuration.'};record.healthLaunch=null;await store.update(record,revision).catch(()=>{})}
  const now=await store.read(owner,key);if(!now)throw new Error('Service removed');return view(now,signal)
 }
 type Action={action:'install';requestId:string;slug:string;authMethodId:string;values:Record<string,string>}|{action:'probe'|'disconnect'|'remove';requestId:string;key:string;expectedRevision:string}
 async function mutate(owner:string,input:Action,stop:AbortSignal){
  const signal=AbortSignal.any([stop,shutdown.signal,AbortSignal.timeout(120_000)]),authority=await current(owner,'manage',undefined,signal)
  const requestDigest=store.digest(owner,input),requestKey=JSON.stringify([owner,input.requestId])
  const previous=(await abortable(store.db.execute({sql:'SELECT * FROM desktop_service_requests WHERE owner=? AND request_id=?',args:[owner,input.requestId]}),signal)).rows[0]
  if(previous){if(previous.digest!==requestDigest)throw new Error('Request identity reused');if(previous.state!=='complete')return {status:'unknown',message:'Prior request acknowledgement unavailable; inspect connection state.'};const result=JSON.parse(String(previous.result));if(result.key){const now=await store.read(owner,result.key);if(now){if(now.revision!==result.revision)return {status:'unknown',key:result.key,installed:false,health:{state:'unchecked'},message:'This request completed at an earlier revision. Refresh the current installation; it will not be replayed.'};return {...result,...await view(now,signal)}}if(result.status!=='removed')return {status:'unknown',key:result.key,installed:false,health:{state:'disconnected'},message:'The original installation no longer exists. This request will not be replayed.'};}return result}
  if(active.has(requestKey))throw new Error('Request is already in progress')
  const run=async()=>{
   const claim=await store.db.execute({sql:'INSERT INTO desktop_service_requests(owner,request_id,digest,state) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',args:[owner,input.requestId,requestDigest,'claimed']});if(claim.rowsAffected!==1)throw new Error('Request already claimed')
   let result:unknown
   if(input.action==='install'){
    const raw=await getDesktopServiceManifest(input.slug);if(!raw)throw new Error('Unknown service')
    const availability=await getDesktopServiceMethodAvailability(input.slug,input.authMethodId)
    const compiled=compileLocalService(raw.manifest,input.authMethodId,input.values,availability)
    const existing=await store.read(owner,compiled.plan.key)
    if(existing&&existing.engineId!==authority.engineAgentId)throw new Error('Service installation belongs to a previous engine identity')
    if(existing?.state==='ready')throw new Error('Existing service must be disconnected before configuring again')
    if(existing && (existing.skills.length>0 && existing.state==='error' || JSON.stringify(existing.plan)!==JSON.stringify(compiled.plan)))throw new Error('Remove the previous installation before changing its method or owned skill plan')
    const record:ServiceInstall={owner,engineId:authority.engineAgentId,key:compiled.plan.key,id:existing?.id??randomUUID(),revision:randomUUID(),state:'preparing',plan:compiled.plan,skills:existing?.skills??[],toolNames:[],health:{state:'unchecked'},healthLaunch:null,installedAt:existing?.installedAt??new Date().toISOString(),configured:!!compiled.bearer}
    await lifecycle.mutate(owner,idName(record),async()=>{
     const guard=async()=>{const now=await current(owner,'manage',undefined,signal);if(now.runtime.launchNonce!==authority.runtime.launchNonce||now.skillsRoot!==authority.skillsRoot)throw new Error('Service owner changed')}
     await guard()
     if(existing)await store.update(record,existing.revision,compiled.bearer);else {if((await store.list(owner)).length>=64)throw new Error('Too many service installs');await store.create(record,compiled.bearer)}
     try{
      for(const resource of record.skills)await verifyServiceSkill(authority.skillsRoot,resource)
      for(let index=record.skills.length;index<record.plan.skills.length;index++){const resource=await createServiceSkill(authority.skillsRoot,record.id,index,record.plan.skills[index],guard);record.skills.push(resource);await store.update(record,record.revision)}
      await guard();record.state='ready';await store.update(record,record.revision)
     }catch{
      record.state='error';record.health={state:'error',message:'Partial install. Review owned resources before retrying.'}
      const remaining=[]
      for(const skill of record.skills){try{await removeServiceSkill(authority.skillsRoot,skill,guard)}catch{remaining.push(skill)}}
      record.skills=remaining;await store.update(record,record.revision,'');throw new Error('Service installation incomplete')
     }
    })
    result=await probe(owner,record.key,record.revision,signal)
   }else{
    const record=await store.read(owner,input.key);if(!record||record.revision!==input.expectedRevision)throw new Error('Service revision conflict')
    if(input.action==='probe')result=await probe(owner,input.key,input.expectedRevision,signal)
    else await lifecycle.mutate(owner,idName(record),async()=>{
     const now=await current(owner,'manage',undefined,signal);if(now.runtime.launchNonce!==authority.runtime.launchNonce||now.skillsRoot!==authority.skillsRoot)throw new Error('Service owner changed')
     const expected=record.revision;record.revision=randomUUID();record.state=input.action==='remove'?'removing':'disconnected';record.health={state:'disconnected'};record.healthLaunch=null;record.configured=false;record.toolNames=[]
     await store.update(record,expected,'')
     if(input.action==='remove'){
      for(const skill of record.skills)await removeServiceSkill(authority.skillsRoot,skill,async()=>{const now=await current(owner,'manage',undefined,signal);if(now.runtime.launchNonce!==authority.runtime.launchNonce||now.skillsRoot!==authority.skillsRoot)throw new Error('Service owner changed')})
      await store.remove(record);result={key:record.key,revision:record.revision,status:'removed',installed:false,health:{state:'disconnected'}}
     }else result=await view(record,signal)
    })
   }
   await current(owner,'manage',undefined,signal)
   const saved=await store.db.execute({sql:"UPDATE desktop_service_requests SET state='complete',result=? WHERE owner=? AND request_id=? AND digest=?",args:[JSON.stringify(result),owner,input.requestId,requestDigest]});if(saved.rowsAffected!==1)throw new Error('Request acknowledgement unavailable')
   return result
  }
  const work=Promise.resolve().then(run);active.set(requestKey,work);void work.finally(()=>{if(active.get(requestKey)===work)active.delete(requestKey)}).catch(()=>{})
  return abortable(work,signal)
 }
 return {mutate,view,probe,discover,transport,current,liveRecord,idName,lifecycle,
  async reconcile(owner:string,signal:AbortSignal){await current(owner,'manage',undefined,signal);for(const record of await store.list(owner)){await lifecycle.mutate(owner,idName(record),async()=>{const revision=record.revision;record.health={state:'unchecked'};record.healthLaunch=null;record.toolNames=[];if(record.engineId!==(await current(owner,'manage',undefined,signal)).engineAgentId||record.state==='preparing'||record.state==='removing'){record.state='error';record.revision=randomUUID();await store.update(record,revision,'')}else await store.update(record,revision)})}},
  async ownedSkills(owner:string,signal:AbortSignal){await current(owner,'manage',undefined,signal);return (await store.list(owner)).flatMap(record=>record.skills.map(skill=>({key:record.key,installationId:record.id,state:record.state,...skill})))},
  transitionOwner:<T>(owner:string,write:()=>Promise<T>)=>lifecycle.transitionOwner(owner,write),
  shutdown(){shutdown.abort();lifecycle.shutdown()},
  async drain(){await Promise.allSettled([...active.values()])},
 }
}
export type LocalServices=ReturnType<typeof localServiceLifecycle>
