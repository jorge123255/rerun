'use client'
import {useEffect,useRef,useState} from 'react'
import {AuthMethodPicker,methodKindLabel} from '@/components/services/AuthMethodPicker'
import {ServiceFields} from '@/components/services/ServiceFields'
import {useServiceSetupDriver,type ServiceSetupDriver} from '@/components/services/service-setup-driver'
import {Button} from '@/components/ui/button'
import type {DesktopServiceDetails} from '@/lib/desktop/services-client'
export function DesktopServiceConfigForm({agentId,details,localDriver,onChanged,onBusy}:{agentId:string;localDriver:ServiceSetupDriver;details:DesktopServiceDetails;onChanged:()=>Promise<void>;onBusy:(busy:boolean)=>void}){
 const driver=useServiceSetupDriver(),[methodId,setMethodId]=useState<string|null>(details.installedMethodId??(details.authMethods.length===1?details.authMethods[0].id:null)),[values,setValues]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const alive=useRef(true),pending=useRef(false),epoch=useRef(0)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++}},[])
 const method=details.authMethods.find(m=>m.id===methodId),support=details.methodAvailability.find(m=>m.id===methodId)
 const supported=driver===localDriver&&!!method&&support?.supported===true&&['none','key'].includes(method.kind)&&method.inputs.length<=1&&(method.inputs.length===0||method.inputs[0].secret)
 const existing=details.installation&&details.installation.health.state!=='disconnected'
 function select(id:string){if(pending.current || !details.authMethods.some(m=>m.id===id))return;epoch.current++;setMethodId(id);setValues({});setError('')}
 async function submit(){
  if(pending.current||!supported||!method||existing)return
  pending.current=true;setBusy(true);onBusy(true);setError('');const current=epoch.current
  try{
   const result=await driver.install(agentId,details.slug,values,method.id)
   if(!alive.current||current!==epoch.current)return
   if(!result.ok){setError(result.error);return}
   setValues({});await onChanged()
  }catch{if(alive.current&&current===epoch.current)setError('Setup acknowledgement unavailable. Refresh connection state.')}finally{pending.current=false;onBusy(false);if(alive.current&&current===epoch.current)setBusy(false)}
 }
 if(!details.authMethods.length)return <p className="text-sm text-muted-foreground">No setup method is available for this app.</p>
 return <div className="space-y-3">
  {!busy&&details.authMethods.length>1&&<AuthMethodPicker methods={details.authMethods} onSelect={select}/>}
  <div className="space-y-1">{details.authMethods.map(item=>{const availability=details.methodAvailability.find(value=>value.id===item.id);return <p key={item.id} className="text-xs text-muted-foreground">{item.label||methodKindLabel(item.kind)}: {availability?.supported?'Available locally':`Unavailable — ${availability?.reason??'This method is not supported on this Mac.'}`}</p>})}</div>
  {method&&<p className="text-sm font-medium">{method.label||methodKindLabel(method.kind)}</p>}
  {method&&!supported&&<p role="status" className="text-xs text-muted-foreground">{support?.reason??'This method is unavailable on this Mac. No hosted sign-in will be started.'}</p>}
  {existing?<p className="text-xs text-muted-foreground">Configuration is saved. Probe the connection after enabling its tool permission, or disconnect before changing credentials.</p>:supported&&method&&<>
   <ServiceFields inputs={method.inputs} values={values} onChange={(key,value)=>{if(!pending.current){epoch.current++;setValues(previous=>({...previous,[key]:value}));setError('')}}}/>
   <Button size="sm" disabled={busy||method.inputs.some(input=>input.required&&!(values[input.key]??'').trim())} onClick={()=>submit()}>{busy?'Installing…':'Install'}</Button>
  </>}
  {Object.values(details.installation?.configured??{}).some(Boolean)&&<p className="text-xs text-muted-foreground">Credential configured. Saved credentials are never returned to this form.</p>}
  {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
  <p className="text-xs text-muted-foreground">Installing does not enable tool permissions. Catalog verification is separate from this coworker’s current connection health.</p>
 </div>
}
