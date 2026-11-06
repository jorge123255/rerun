'use client'
import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
import {CheckCircle2Icon,ExternalLinkIcon,Loader2Icon} from '@/lib/icons'
import type {DesktopServiceOAuthSnapshot as Snapshot} from '../../../../../../packages/contracts/src/desktop-service-oauth'
import type {ServiceOAuthDriver} from '@/lib/desktop/service-oauth-client'
export function DesktopServiceOAuthConnect({snapshot:initial,driver,onChanged}:{snapshot:Snapshot;driver:ServiceOAuthDriver;onChanged?:(snapshot:Snapshot)=>void}){
 const identity=JSON.stringify([initial.coworkerId,initial.accountKey,initial.installationId,initial.configGeneration])
 return <OAuthConnect key={identity} initial={initial} driver={driver} onChanged={onChanged}/>
}
function OAuthConnect({initial,driver,onChanged}:{initial:Snapshot;driver:ServiceOAuthDriver;onChanged?:(snapshot:Snapshot)=>void}){
 const [snapshot,setSnapshot]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null)
 const current=useRef(initial),alive=useRef(true),epoch=useRef(0),startId=useRef<string|null>(null),flight=useRef<AbortController|null>(null)
 useEffect(()=>{alive.current=true;return ()=>{alive.current=false;epoch.current++;flight.current?.abort()}},[])
 useEffect(()=>{epoch.current++;flight.current?.abort();current.current=initial;setSnapshot(initial);setBusy(false)},[initial.revision])
 const accept=(next:Snapshot,version:number)=>{
  if(!alive.current||epoch.current!==version)return
  if(next.coworkerId!==initial.coworkerId||next.accountKey!==initial.accountKey||next.installationId!==initial.installationId||next.configGeneration!==initial.configGeneration)throw new Error('Account changed')
  current.current=next;setSnapshot(next);onChanged?.(next)
 }
 const perform=async(action:'start'|'cancel'|'probe'|'disconnect'|'status')=>{
  const version=++epoch.current;flight.current?.abort();const controller=new AbortController();flight.current=controller
  setBusy(action!=='status');setError(null)
  try{
   let value=current.current
   if(action==='start'){
    startId.current??=crypto.randomUUID()
    value=await driver.action(initial.coworkerId,{action:'start',requestId:startId.current,accountKey:initial.accountKey,expectedGeneration:initial.configGeneration},controller.signal)
   }else{
    if(action==='cancel'&&startId.current&&value.state==='configured')value=await driver.action(initial.coworkerId,{action:'lookup',requestId:startId.current},controller.signal)
    value=await driver.action(initial.coworkerId,{action,attemptId:value.attemptId,expectedRevision:value.revision},controller.signal)
   }
   accept(value,version)
   if(['cancelled','expired','error','unsupported','interrupted','disconnected'].includes(value.state))startId.current=null
  }catch{if(alive.current&&epoch.current===version)setError('OAuth unavailable or account changed. Refresh and retry.')}
  finally{if(alive.current&&epoch.current===version)setBusy(false)}
 }
 useEffect(()=>{
  if(!['starting','waiting'].includes(snapshot.state)||busy)return
  const timer=setTimeout(()=>{void perform('status')},1500)
  return ()=>clearTimeout(timer)
 // The current snapshot/epoch owns this one read; no sign-in begins from an effect.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[snapshot,busy])
 const waiting=['starting','waiting'].includes(snapshot.state)
 return <div className="min-w-0 space-y-2 py-1">
  <div className="flex min-w-0 items-center gap-2 text-sm">
   {snapshot.installed?<CheckCircle2Icon className="size-3.5 shrink-0 text-green-600"/>:waiting?<Loader2Icon className="size-3.5 shrink-0 animate-spin"/>:null}
   <span className="min-w-0 break-words">{snapshot.message}</span>
  </div>
  {waiting&&snapshot.authorizationUrl&&<a href={snapshot.authorizationUrl} target="_blank" rel="noreferrer" className="inline-flex break-words text-sm underline underline-offset-2">Open sign-in in browser</a>}
  {error&&<p role="alert" className="break-words text-sm text-destructive">{error}</p>}
  {error&&waiting&&<Button variant="outline" size="sm" onClick={()=>void perform('status')}>Retry</Button>}
  <div className="flex flex-wrap gap-2">
   {!waiting&&!snapshot.installed&&snapshot.state!=='checking'&&<Button variant="outline" size="sm" disabled={busy} className="w-full" onClick={()=>void perform('start')}><ExternalLinkIcon className="mr-1.5 size-3.5"/>{['configured','disconnected'].includes(snapshot.state)?'Connect':'Retry'}</Button>}
   {snapshot.state==='checking'&&<Button variant="outline" size="sm" disabled={busy} onClick={()=>void perform('probe')}>Check connection</Button>}
   {(waiting||busy||startId.current!==null)&&<Button variant="outline" size="sm" onClick={()=>void perform('cancel')}>Cancel</Button>}
   {snapshot.configured&&<Button variant="outline" size="sm" disabled={busy} onClick={()=>void perform('disconnect')}>Disconnect</Button>}
  </div>
 </div>
}
