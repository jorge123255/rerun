'use client'
import type {DesktopServiceHealth,DesktopServiceMethodAvailability,ServiceSearchResultView} from '@rerun/contracts'
import type {ServiceDetails,InstallResult} from '@/lib/services/types'
import type {ServiceSetupDriver} from '@/components/services/service-setup-driver'
export type DesktopInstalledService={key:string;slug:string;name:string;category:string;icon:string|null;revision:string;health:DesktopServiceHealth;installed:boolean;status:'active'|'needs_config'|'needs_auth'|'error';authMethodId?:string;installedAt:string;toolNames:string[];configured:Record<string,boolean>}
export type DesktopServiceDetails=ServiceDetails&{icon:string|null;methodAvailability:DesktopServiceMethodAvailability[];installation:DesktopInstalledService|null;localLimitations:string}
export type DesktopServicePage={services:ServiceSearchResultView[];total:number}
export type DesktopMutation={status?:string;message?:string;key?:string;revision?:string;installed?:boolean;health?:DesktopServiceHealth}
export function createDesktopServicesClient(owner:string){
 const url=`/api/desktop/coworkers/${encodeURIComponent(owner)}/services`
 const installRequests=new Map<string,string>(),mutationRequests=new Map<string,string>()
 const controllers=new Set<AbortController>();let closed=false
 async function request<T>(query:URLSearchParams|Record<string,unknown>):Promise<T>{
  if(closed)throw new Error('Service panel owner changed')
  const controller=new AbortController();controllers.add(controller)
  try{
   const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(130_000)])
   const response=await fetch(query instanceof URLSearchParams?`${url}?${query}`:url,{method:query instanceof URLSearchParams?'GET':'POST',cache:'no-store',signal,headers:query instanceof URLSearchParams?{}:{'Content-Type':'application/json'},body:query instanceof URLSearchParams?undefined:JSON.stringify(query)})
   const data=await response.json();signal.throwIfAborted();if(closed)throw new Error('Service panel owner changed')
   if(!response.ok)throw new Error('Local service request unavailable or acknowledgement unknown. Refresh connection state.')
   return data as T
  }finally{controllers.delete(controller)}
 }
 const details=(slug:string)=>request<DesktopServiceDetails>(new URLSearchParams({view:'detail',slug}))
 const installed=()=>request<DesktopInstalledService[]>(new URLSearchParams({view:'installed'}))
 async function mutate(action:'probe'|'disconnect'|'remove',installation:DesktopInstalledService){
  const key=JSON.stringify([action,installation.key,installation.revision]);let requestId=mutationRequests.get(key)
  if(!requestId){requestId=crypto.randomUUID();mutationRequests.set(key,requestId)}
  const result=await request<DesktopMutation>({action,requestId,key:installation.key,expectedRevision:installation.revision})
  if(result.status==='unknown')throw new Error('Prior acknowledgement unavailable. Refresh connection state.')
  mutationRequests.delete(key);return result
 }
 const driver:ServiceSetupDriver={
  details:async(agentId,key)=>{if(agentId!==owner)return null;try{return await details(key)}catch{return null}},
  install:async(agentId,slug,values,authMethodId,opts)=>{
   if(agentId!==owner || opts?.newInstance || !authMethodId || slug.includes('@'))return {ok:false,error:'This local setup supports one base instance and requires an exact method.'}
   try{
    const detail=await details(slug),method=detail.authMethods.find(m=>m.id===authMethodId),support=detail.methodAvailability.find(m=>m.id===authMethodId)
    if(!method || !support?.supported || !['none','key'].includes(method.kind) || method.inputs.length>1 || method.inputs.length===1&&!method.inputs[0].secret)throw new Error()
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([slug,authMethodId,Object.entries(values).sort()])))
    const identity=Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('')
    // Only the most recent input identity stays in component memory; credentials are never persisted.
    let requestId=installRequests.get(identity)
    if(!requestId){installRequests.clear();requestId=crypto.randomUUID();installRequests.set(identity,requestId)}
    const result=await request<InstallResult&DesktopMutation>({action:'install',requestId,slug,authMethodId,values})
    if(result.status!=='installed'&&result.status!=='needs_config')return {ok:false,error:'Install acknowledgement unknown. Refresh connection state.'}
    installRequests.clear()
    return {ok:true,result}
   }catch{return {ok:false,error:'Local setup refused or acknowledgement unknown. Retry the same input or refresh connection state.'}}
  },
  markAuthorized:async(agentId,key)=>{if(agentId!==owner)return {success:false};try{const rows=await installed(),current=rows.find(row=>row.key===key);if(!current)return {success:false};const result=await mutate('probe',current);return {success:result.installed===true&&result.health?.state==='healthy'}}catch{return {success:false}}},
  reset:async(agentId,key)=>{if(agentId!==owner)return {ok:false,error:'Service panel owner changed'};try{const rows=await installed(),current=rows.find(row=>row.key===key);if(!current)throw new Error();await mutate('disconnect',current);return {ok:true,result:{mode:'config',authMethodId:current.authMethodId}}}catch{return {ok:false,error:'Local disconnect acknowledgement unavailable. Refresh connection state.'}}},
 }
 return {driver,details,installed,mutate,
  catalog:(query='',category='',offset=0)=>request<DesktopServicePage>(new URLSearchParams({view:'catalog',query,...(category?{category}:{}),offset:String(offset),limit:'50'})),
  dispose(){closed=true;for(const controller of controllers)controller.abort();controllers.clear();installRequests.clear();mutationRequests.clear()},
 }
}
export type DesktopServicesClient=ReturnType<typeof createDesktopServicesClient>
