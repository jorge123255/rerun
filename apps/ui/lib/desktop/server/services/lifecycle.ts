import 'server-only'
import {randomUUID} from 'node:crypto'
import type {DesktopServiceHealth} from '@rerun/contracts'
import {remoteMcpLifecycle} from '../mcp/lifecycle'
import {abortable,remoteMcpRuntime} from '../mcp/remote'
import type {RemoteMcpStore} from '../mcp/store'
import type {RemoteTool} from '../mcp/model'
import type {DesktopRuntime} from '../runtime'
import type {ServiceStore,ServiceInstall} from './store'
import {compileLocalService} from './compiler'
import {serviceSkillJournal,currentSkillInstallation} from './skill-journal'
import {connectorSkillAuthority} from './skill-ownership'
import {createServiceSkill,removeServiceSkill,verifyServiceSkill,acknowledgeServiceSkill,resolveServiceSkillRemoval} from './skill-resources'
import {syncDesktopServiceRegistry,desktopServiceRegistryName} from './service-registry'
import {getDesktopServiceManifest,getDesktopServiceMethodAvailability} from './catalog/index'
export type ServiceRun={engineAgentId:string;sessionId:string;runId:string}
export type ServiceAuthority=(owner:string,action:'manage'|'use',run:ServiceRun|undefined,signal:AbortSignal)=>Promise<{engineAgentId:string;runtime:DesktopRuntime;skillsRoot:string;enabled:boolean;granted:boolean;check?:()=>void}>
export type ServiceToolNames=(owner:string,installationId:string,names:string[],signal:AbortSignal)=>Promise<void>
export type ServiceRestartAuthority=(owner:string,signal:AbortSignal)=>Promise<{engineId:string;skillsRoot:string}>
export type ServiceRegistryWriter=(skillsRoot:string,records:ServiceInstall[],signal:AbortSignal)=>Promise<void>
export type ServiceTransport={
 probe(owner:string,name:string,revision:string,signal?:AbortSignal):Promise<{tools?:RemoteTool[];result?:Record<string,unknown>}>
 call(owner:string,name:string,revision:string,tool:string,args:Record<string,unknown>,signal?:AbortSignal,invocation?:{toolCallId:string}):Promise<{tools?:RemoteTool[];result?:Record<string,unknown>}>
 validate(owner:string,name:string,revision:string,signal:AbortSignal):Promise<void>
}
export const isAccountService=(record:ServiceInstall)=>'shape' in record.plan
export function localServiceLifecycle(store:ServiceStore,authorize:ServiceAuthority,assertToolNames:ServiceToolNames,network:typeof fetch=fetch,writeRegistry:ServiceRegistryWriter=syncDesktopServiceRegistry,restartAuthority?:ServiceRestartAuthority){
 const lifecycle=remoteMcpLifecycle(),shutdown=new AbortController()
 const skillJournal=serviceSkillJournal(store.db)
 const skillAuthority=connectorSkillAuthority(store,skillJournal,async (owner,signal=shutdown.signal)=>{const authority=await current(owner,'manage',undefined,signal);return {engineId:authority.engineAgentId,skillsRoot:authority.skillsRoot}})
 const active=new Map<string,Promise<unknown>>()
 const ownerTails=new Map<string,Promise<unknown>>(),transportWork=new Map<string,Set<Promise<unknown>>>()
 let accountTransport:((record:ServiceInstall,run:ServiceRun|undefined,signal:AbortSignal)=>ServiceTransport)|undefined
 function trackTransport<T>(owner:string,work:Promise<T>):Promise<T>{const works=transportWork.get(owner)??new Set();transportWork.set(owner,works);works.add(work);const done=()=>{works.delete(work);if(!works.size)transportWork.delete(owner)};void work.then(done,done);return work}
 function exclusive<T>(owner:string,write:()=>Promise<T>):Promise<T>{const work=(ownerTails.get(owner)??Promise.resolve()).catch(()=>{}).then(write);ownerTails.set(owner,work);const done=()=>{if(ownerTails.get(owner)===work)ownerTails.delete(owner)};void work.then(done,done);return work}
 const idName=(record:ServiceInstall)=>desktopServiceRegistryName(record.id)
 const syncRegistry=async(skillsRoot:string,owner:string,signal:AbortSignal)=>writeRegistry(skillsRoot,await abortable(store.list(owner),signal),signal)
 async function current(owner:string,action:'manage'|'use',run:ServiceRun|undefined,signal:AbortSignal){signal.throwIfAborted();shutdown.signal.throwIfAborted();const value=await abortable(authorize(owner,action,run,signal),signal);signal.throwIfAborted();shutdown.signal.throwIfAborted();value.check?.();if(action==='use'&&(!value.enabled||!value.granted))throw new Error('Service permission is off');return value}
 async function liveRecord(owner:string,key:string,revision:string,signal:AbortSignal){const record=await abortable(store.read(owner,key),signal);signal.throwIfAborted();if(!record || record.revision!==revision || record.state!=='ready')throw new Error('Service connection changed');await skillAuthority.assertReady(owner,record.id,signal);return record}
 function transport(record:ServiceInstall,run:ServiceRun|undefined,signal:AbortSignal):ServiceTransport{
  if(isAccountService(record)){if(!accountTransport)throw new Error('Service account transport unavailable');return accountTransport(record,run,signal)}
  const reader:RemoteMcpStore={lifecycle,
   list:async()=>[],read:async(owner,name)=>{if(owner!==record.owner||name!==idName(record))throw new Error('Service owner mismatch');const now=await liveRecord(owner,record.key,record.revision,signal);return {name,url:now.plan.url,revision:now.revision,bearer:await abortable(store.credential(owner,now.id),signal)}},
   readOAuth:async()=>null,writeOAuth:async()=>{throw new Error('Service OAuth unavailable')},save:async()=>{throw new Error('Read-only service transport')},remove:async()=>{throw new Error('Read-only service transport')},
  }
  const runtime=remoteMcpRuntime(reader,async(owner)=>{const authority=await current(owner,'use',run,signal);if(authority.engineAgentId!==record.engineId)throw new Error('Service owner changed');return {enabled:authority.enabled,granted:authority.granted}},network)
  return {...runtime,probe:(...args:Parameters<typeof runtime.probe>)=>trackTransport(record.owner,runtime.probe(...args)),call:(...args:Parameters<typeof runtime.call>)=>trackTransport(record.owner,runtime.call(...args))}
 }
 async function view(record:ServiceInstall,signal:AbortSignal){
  const authority=await current(record.owner,'manage',undefined,signal)
  let skillsHealthy=false;try{await skillAuthority.assertReady(record.owner,record.id,signal);skillsHealthy=true}catch{}
  const healthy=skillsHealthy&&authority.engineAgentId===record.engineId&&record.state==='ready'&&authority.enabled&&authority.granted&&record.health.state==='healthy'&&record.healthLaunch===authority.runtime.launchNonce&&Date.now()>=Date.parse(record.health.checkedAt??'')&&Date.now()-Date.parse(record.health.checkedAt??'')<60_000
  const health:DesktopServiceHealth=healthy?record.health:record.state==='disconnected'?{state:'disconnected',message:'Local credentials removed. This does not revoke the remote API key.'}:!authority.enabled||!authority.granted?{state:'unchecked',message:'Enable Apps in this coworker’s Tools to check the connection.'}:record.health.state==='error'?record.health:{state:'unchecked',message:'Connection health is not established for the current permissions and app launch.'}
  return {key:record.key,slug:record.plan.slug,name:record.plan.name,category:record.plan.category,icon:record.plan.icon,revision:record.revision,health,installed:healthy,status:healthy?'active' as const:record.state==='error'?'error' as const:'needs_config' as const,authMethodId:record.plan.methodId,installedAt:record.installedAt,toolNames:healthy?record.toolNames:[],configured:record.plan.secretInput?{[record.plan.secretInput]:record.configured}:{}}
 }
 async function discover(record:ServiceInstall,run:ServiceRun|undefined,signal:AbortSignal){
  await skillAuthority.assertReady(record.owner,record.id,signal)
  const initial=await current(record.owner,'use',run,signal);if(initial.engineAgentId!==record.engineId)throw new Error('Service owner changed');for(const skill of record.skills)await verifyServiceSkill(initial.skillsRoot,skill)
  await syncRegistry(initial.skillsRoot,record.owner,signal)
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
 async function mutateLegacy(owner:string,input:Action,stop:AbortSignal){
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
    if(existing&&isAccountService(existing))throw new Error('Use the account settings for this connection')
    if(existing&&existing.engineId!==authority.engineAgentId)throw new Error('Service installation belongs to a previous engine identity')
    if(existing?.state==='ready')throw new Error('Existing service must be disconnected before configuring again')
    if(existing && JSON.stringify(existing.plan)!==JSON.stringify(compiled.plan))throw new Error('Remove the previous installation before changing its method or owned skill plan')
    const record:ServiceInstall={owner,engineId:authority.engineAgentId,key:compiled.plan.key,id:existing?.id??randomUUID(),revision:randomUUID(),state:'preparing',plan:compiled.plan,skills:existing?.skills??[],toolNames:[],health:{state:'unchecked'},healthLaunch:null,installedAt:existing?.installedAt??new Date().toISOString(),configured:!!compiled.bearer}
    await lifecycle.mutate(owner,idName(record),async()=>{
     const guard=async()=>{await currentSkillInstallation(store,record);const now=await current(owner,'manage',undefined,signal);if(now.engineAgentId!==record.engineId||now.runtime.launchNonce!==authority.runtime.launchNonce||now.skillsRoot!==authority.skillsRoot)throw new Error('Service owner changed')}
     await current(owner,'manage',undefined,signal)
     if(existing)await store.update(record,existing.revision,compiled.bearer);else {if((await store.list(owner)).length>=64)throw new Error('Too many service installs');await store.create(record,compiled.bearer)}
     try{
      await syncRegistry(authority.skillsRoot,owner,signal)
      for(const resource of record.skills)await verifyServiceSkill(authority.skillsRoot,resource)
      for(let index=0;index<record.plan.skills.length;index++){
       const resource=await createServiceSkill(authority.skillsRoot,record,index,record.plan.skills[index],guard,skillJournal)
       record.skills[index]=resource;await store.update(record,record.revision);const reservation=await skillJournal.read(owner,record.id,index);if(!reservation)throw new Error('Skill reservation unavailable');await acknowledgeServiceSkill(skillJournal,reservation);await syncRegistry(authority.skillsRoot,owner,signal)
      }
      await guard();record.state='ready';await store.update(record,record.revision);await syncRegistry(authority.skillsRoot,owner,signal)
     }catch{
      record.state='error';record.health={state:'error',message:'Partial install. Review owned resources before retrying.'}
      await store.update(record,record.revision,'');await syncRegistry(authority.skillsRoot,owner,signal);throw new Error('Service installation incomplete')
     }
    })
    result=await probe(owner,record.key,record.revision,signal)
   }else{
    const record=await store.read(owner,input.key);if(!record||record.revision!==input.expectedRevision)throw new Error('Service revision conflict')
    if(isAccountService(record))throw new Error('Use the account settings for this connection')
    if(input.action==='probe')result=await probe(owner,input.key,input.expectedRevision,signal)
    else await lifecycle.mutate(owner,idName(record),async()=>{
     const now=await current(owner,'manage',undefined,signal);if(now.engineAgentId!==record.engineId||now.runtime.launchNonce!==authority.runtime.launchNonce||now.skillsRoot!==authority.skillsRoot)throw new Error('Service owner changed')
     const expected=record.revision;record.revision=randomUUID();record.state=input.action==='remove'?'removing':'disconnected';record.health={state:'disconnected'};record.healthLaunch=null;record.configured=false;record.toolNames=[]
     await store.update(record,expected,'');await syncRegistry(authority.skillsRoot,owner,signal)
     if(input.action==='remove'){
      for(const reservation of (await skillJournal.list(owner)).filter(r=>r.installationId===record.id&&r.state!=='removed')){
       const guard=async()=>{await currentSkillInstallation(store,record);const now=await current(owner,'manage',undefined,signal);if(now.engineAgentId!==record.engineId||now.runtime.launchNonce!==authority.runtime.launchNonce||now.skillsRoot!==authority.skillsRoot)throw new Error('Service owner changed')}
       if(!reservation.resource)throw new Error('Unacknowledged staging resource; preserved for explicit recovery')
       const refs=(await store.list(owner)).filter(other=>other.id!==record.id).flatMap(other=>other.skills)
       if(refs.some(skill=>skill.slug===reservation.resource!.slug||skill.directoryIdentity===reservation.resource!.directoryIdentity))throw new Error('Skill still referenced by another installation')
       const resource=await resolveServiceSkillRemoval(authority.skillsRoot,reservation,guard)
       await removeServiceSkill(authority.skillsRoot,resource,guard)
       await skillJournal.update(reservation,'removed',reservation.resource)
      }
      for(const skill of record.skills){const rows=await skillJournal.list(owner);if(!rows.some(r=>r.installationId===record.id&&r.resource?.slug===skill.slug&&r.state==='removed'))throw new Error('Legacy skill ownership requires reconciliation; preserved')}
      await store.remove(record);await syncRegistry(authority.skillsRoot,owner,signal);result={key:record.key,revision:record.revision,status:'removed',installed:false,health:{state:'disconnected'}}
     }else result=await view(record,signal)
    })
   }
   await current(owner,'manage',undefined,signal)
   const saved=await store.db.execute({sql:"UPDATE desktop_service_requests SET state='complete',result=? WHERE owner=? AND request_id=? AND digest=?",args:[JSON.stringify(result),owner,input.requestId,requestDigest]});if(saved.rowsAffected!==1)throw new Error('Request acknowledgement unavailable')
   return result
  }
  const work=Promise.resolve().then(run);active.set(requestKey,work);void work.finally(()=>{if(active.get(requestKey)===work)active.delete(requestKey)}).catch(()=>{})
  // Keep the shared mutation queue occupied until real work settles, even when
  // the request observer has stopped waiting for its acknowledgement.
  return work
 }
 async function reconcile(owner:string,signal:AbortSignal){
  const scope=async()=>{
   signal.throwIfAborted();shutdown.signal.throwIfAborted()
   if(restartAuthority)return abortable(restartAuthority(owner,signal),signal)
   const value=await current(owner,'manage',undefined,signal);return {engineId:value.engineAgentId,skillsRoot:value.skillsRoot}
  }
  const authority=await scope(),offlineSkills=connectorSkillAuthority(store,skillJournal,scope)
  for(const record of await store.list(owner)){await lifecycle.mutate(owner,idName(record),async()=>{
   let skillsValid=true;try{await offlineSkills.assertReady(owner,record.id,signal)}catch{skillsValid=false}
   const revision=record.revision;record.health={state:'unchecked'};record.healthLaunch=null;record.toolNames=[]
   const now=await scope()
   if(now.engineId!==authority.engineId||now.skillsRoot!==authority.skillsRoot)throw new Error('Service owner changed')
   // Account receipts and encrypted bundles bind this exact revision. Restart must
   // not rotate it or abandon a partially published/removed owned resource.
   if(isAccountService(record)){
    if(record.engineId!==now.engineId||!skillsValid)record.health={state:'error',message:'App resources need review before reconnecting.'}
    await store.update(record,revision)
   }else if(record.engineId!==now.engineId||!skillsValid||record.state==='preparing'||record.state==='removing'){record.state='error';record.revision=randomUUID();await store.update(record,revision,'')}else await store.update(record,revision)
  })}
  await scope();await syncRegistry(authority.skillsRoot,owner,signal)
 }
 return {skillAuthority,skillJournal,view,probe,discover,transport,current,liveRecord,idName,lifecycle,reconcile,syncRegistry,assertToolNames,trackTransport,
  mutate:(owner:string,input:Action,stop:AbortSignal)=>exclusive(owner,()=>mutateLegacy(owner,input,stop)),
  setAccountTransport(factory:NonNullable<typeof accountTransport>){if(accountTransport)throw new Error('Account transport already bound');accountTransport=factory},
  accountMutation:<T>(owner:string,probe:boolean,write:()=>Promise<T>)=>exclusive(owner,()=>probe?write():lifecycle.transitionOwner(owner,async()=>{await Promise.allSettled([...(transportWork.get(owner)??[])]);return write()})),
  async reconcileOwners(signal:AbortSignal){
   // Clear usable health before any owner inspection; restart never probes a provider.
   await abortable(store.db.execute(`UPDATE desktop_service_installs SET health='{"state":"unchecked"}',health_launch=NULL,tool_names='[]'`),signal)
   const rows=await abortable(store.db.execute({sql:'SELECT DISTINCT owner FROM desktop_service_installs LIMIT 4097',args:[]}),signal)
   if(rows.rows.length>4096)throw new Error('Service owner limit exceeded')
   for(const row of rows.rows){
    signal.throwIfAborted();shutdown.signal.throwIfAborted()
    const owner=String(row.owner),stop=AbortSignal.any([signal,shutdown.signal,AbortSignal.timeout(5_000)])
    try{await reconcile(owner,stop)}catch{
     signal.throwIfAborted();shutdown.signal.throwIfAborted()
     // A missing/deleting owner or broken projection cannot hold unrelated MCP startup hostage.
     // Do not decode the same corrupt/unknown-version row that caused recovery
     // to fail. Unknown records remain unreadable; unrelated owners can start.
     await abortable(store.db.execute({sql:`UPDATE desktop_service_installs SET health='{"state":"error","message":"App resources need review before reconnecting."}',health_launch=NULL,tool_names='[]' WHERE owner=?`,args:[owner]}),signal)
     const saved=await abortable(store.db.execute({sql:'SELECT key,id,revision,schema_version,plan FROM desktop_service_installs WHERE owner=?',args:[owner]}),signal)
     for(const row of saved.rows){
      if(Number(row.schema_version)!==1)continue
      let plan:unknown;try{plan=JSON.parse(String(row.plan))}catch{continue}
      if(!plan||typeof plan!=='object'||Array.isArray(plan)||'shape' in plan)continue
      await abortable(store.db.execute({sql:"UPDATE desktop_service_installs SET state='error',bearer=NULL,revision=? WHERE owner=? AND key=? AND id=? AND revision=?",args:[randomUUID(),owner,String(row.key),String(row.id),String(row.revision)]}),signal)
     }
    }
   }
  },
  async ownedSkills(owner:string,signal:AbortSignal){await current(owner,'manage',undefined,signal);return (await store.list(owner)).flatMap(record=>record.skills.map(skill=>({key:record.key,installationId:record.id,state:record.state,...skill})))},
  transitionOwner:<T>(owner:string,write:()=>Promise<T>)=>{lifecycle.disconnect(owner);return exclusive(owner,()=>lifecycle.transitionOwner(owner,async()=>{await Promise.allSettled([...(transportWork.get(owner)??[])]);return write()}))},
  shutdown(){shutdown.abort();lifecycle.shutdown()},
  async drain(){await Promise.allSettled([...active.values(),...ownerTails.values(),...[...transportWork.values()].flatMap(works=>[...works])])},
 }
}
export type LocalServices=ReturnType<typeof localServiceLifecycle>
