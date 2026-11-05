import 'server-only'
import {z} from 'zod'
import {parseServiceRegistryKey,SERVICE_CATEGORIES} from '@rerun/contracts'
import {authenticateDesktopRequest} from '../auth'
import {abortable,boundedText} from '../mcp/remote'
import {serviceManifestSchema} from '@/lib/services/manifest'
import {getDesktopServiceManifest,getDesktopServiceMethodAvailability,listDesktopServiceCatalog} from './catalog/index'
import {localMethodAvailability} from './compiler'
import type {ServiceStore} from './store'
import type {LocalServices} from './lifecycle'
const text=z.string().min(1).max(200)
export const serviceMutation=z.discriminatedUnion('action',[
 z.object({action:z.literal('install'),requestId:z.string().uuid(),slug:text,authMethodId:text,values:z.record(z.string().max(128),z.string().max(8192))}).strict(),
 z.object({action:z.enum(['probe','disconnect','remove']),requestId:z.string().uuid(),key:text,expectedRevision:z.string().uuid()}).strict(),
])
const query=z.discriminatedUnion('view',[
 z.object({view:z.literal('catalog'),query:z.string().max(200).optional(),category:z.enum(SERVICE_CATEGORIES).optional(),offset:z.coerce.number().int().min(0).max(100000).default(0),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict(),
 z.object({view:z.literal('detail'),slug:text}).strict(),z.object({view:z.literal('installed')}).strict(),
])
export function serviceApi(store:ServiceStore,service:LocalServices){
 return async(request:Request,owner:string)=>{
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(125_000)])
  try{
   await abortable(authenticateDesktopRequest(request),signal);const initial=await service.current(owner,'manage',undefined,signal)
   let result:unknown
   if(request.method==='GET'){
    const input=query.parse(Object.fromEntries(new URL(request.url).searchParams))
    if(input.view==='installed')result=await Promise.all((await store.list(owner)).map(record=>service.view(record,signal)))
    else if(input.view==='catalog'){
     const page=await listDesktopServiceCatalog({query:input.query,category:input.category,offset:input.offset,limit:input.limit}),installed=await store.list(owner)
     result={...page,services:await Promise.all(page.services.map(async row=>{const record=installed.find(r=>r.plan.slug===row.slug);const view=record?await service.view(record,signal):null;return {...row,installed:view?.installed??false,installStatus:view?.status??null}}))}
    }else{
     const parsed=parseServiceRegistryKey(input.slug);if(parsed.instanceId)throw new Error('Additional accounts are unavailable in this local setup')
     const raw=await getDesktopServiceManifest(parsed.slug);if(!raw)throw new Error('Unknown service')
     const manifest=serviceManifestSchema.parse(raw.manifest),record=await store.read(owner,manifest.slug),installed=record?await service.view(record,signal):null
     const authMethods=manifest.authMethods.map(method=>({id:method.id,label:method.label,kind:method.kind,recommended:method.recommended,inputs:method.inputs,requiresSecrets:method.inputs.some(i=>i.secret)}))
     result={key:manifest.slug,slug:manifest.slug,name:manifest.name,category:manifest.category,summary:manifest.summary,description:manifest.description,icon:manifest.icon??null,authMethods,methodAvailability:await Promise.all(authMethods.map(async method=>localMethodAvailability(manifest,method.id,await getDesktopServiceMethodAvailability(manifest.slug,method.id)))),installed:installed?.installed??false,installStatus:installed?.status??null,installedMethodId:record?.plan.methodId,multiInstance:false,instances:record?[{key:record.key,status:installed!.status}]:[],installation:installed,localLimitations:'Only the base service instance is supported. Other sign-in/transport methods are unavailable on this Mac.'}
    }
   }else if(request.method==='POST'){
    const input=serviceMutation.parse(JSON.parse(await boundedText(new Response(request.body),signal,32768)))
    result=await service.mutate(owner,input,signal)
    if(input.action==='install' && result && typeof result==='object' && 'installed' in result && 'status' in result && ['active','needs_config','error'].includes(String(result.status))){const view=result as unknown as {installed:boolean;key:string;slug:string;name:string;toolNames:string[]};const raw=await getDesktopServiceManifest(input.slug);if(!raw)throw new Error('Unknown service');const manifest=serviceManifestSchema.parse(raw.manifest);result={...result,status:view.installed?'installed':'needs_config',authMethodId:input.authMethodId,authMethods:manifest.authMethods.map(m=>({id:m.id,label:m.label,kind:m.kind,recommended:m.recommended,inputs:m.inputs,requiresSecrets:m.inputs.some(i=>i.secret)})),message:view.installed?`${view.name} installed. Tools are available only while current permissions remain enabled.`:'Configuration saved; runtime health and current tool permission are not established.'}}
   }else throw new Error('Method not allowed')
   const final=await service.current(owner,'manage',undefined,signal);signal.throwIfAborted();if(final.engineAgentId!==initial.engineAgentId||final.runtime.launchNonce!==initial.runtime.launchNonce)throw new Error('Service owner changed')
   if(!final.enabled||!final.granted){
    const sanitize=(value:unknown):unknown=>{if(Array.isArray(value))return value.map(sanitize);if(!value||typeof value!=='object')return value;const row=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,sanitize(item)]));if('installed' in row){row.installed=false;if(row.status==='active'||row.status==='installed')row.status='needs_config';if(row.installStatus==='active')row.installStatus='needs_config';if(Array.isArray(row.toolNames))row.toolNames=[];if(row.health&&typeof row.health==='object'&&(row.health as {state?:unknown}).state==='healthy')row.health={state:'unchecked',message:'Current service permission is off.'}}return row}
    result=sanitize(result)
   }
   return Response.json(result,{headers:{'Cache-Control':'no-store'}})
  }catch{return Response.json({error:'Local service request refused or its acknowledgement is unknown. Refresh connection state; do not assume installation or removal succeeded.'},{status:400,headers:{'Cache-Control':'no-store'}})}
 }
}
