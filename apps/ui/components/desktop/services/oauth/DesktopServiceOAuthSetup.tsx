'use client'
import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
import {ExternalLinkIcon,Loader2Icon} from '@/lib/icons'
import type {DesktopServiceAccountIntent} from '../../../../../../packages/contracts/src/desktop-service-accounts'
import type {DesktopServiceOAuthSnapshot} from '../../../../../../packages/contracts/src/desktop-service-oauth'
import type {ServiceOAuthDriver} from '@/lib/desktop/service-oauth-client'
import {DesktopServiceOAuthConnect} from './DesktopServiceOAuthConnect'
export function DesktopServiceOAuthSetup(props:{coworkerId:string;slug:string;name:string;methodId:string;intent:DesktopServiceAccountIntent;driver:ServiceOAuthDriver;onChanged?:(snapshot:DesktopServiceOAuthSnapshot)=>void}){
 const key=JSON.stringify([props.coworkerId,props.slug,props.methodId,props.intent])
 return <Setup key={key} {...props}/>
}
function Setup({coworkerId,slug,name,methodId,intent,driver,onChanged}:Parameters<typeof DesktopServiceOAuthSetup>[0]){
 const [snapshot,setSnapshot]=useState<DesktopServiceOAuthSnapshot|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false)
 const requestId=useRef<string|null>(null),alive=useRef(true),controller=useRef<AbortController|null>(null)
 useEffect(()=>{alive.current=true;return ()=>{alive.current=false;controller.current?.abort()}},[])
 const configure=async()=>{
  if(busy)return
  requestId.current??=crypto.randomUUID();controller.current=new AbortController();setBusy(true);setError(false)
  try{
   const saved=await driver.action(coworkerId,{action:'configure',requestId:requestId.current,slug,methodId,intent},controller.current.signal)
   if(alive.current&&saved.coworkerId===coworkerId&&saved.methodId===methodId){setSnapshot(saved);onChanged?.(saved)}
  }catch{if(alive.current)setError(true)}finally{if(alive.current)setBusy(false)}
 }
 return <div className="min-w-0 space-y-3"><p className="break-words text-sm font-medium">Connect {name}</p>
  {snapshot?<DesktopServiceOAuthConnect snapshot={snapshot} driver={driver} onChanged={onChanged}/>:<>
   <p className="text-xs text-muted-foreground">Save this account’s configuration, then connect to sign in.</p>
   {error&&<p role="alert" className="break-words text-xs text-destructive">Configuration unavailable or changed. Retry to reconcile this request.</p>}
   <Button variant="outline" size="sm" className="w-full" disabled={busy} onClick={()=>void configure()}>{busy?<Loader2Icon className="mr-1.5 size-3.5 animate-spin"/>:<ExternalLinkIcon className="mr-1.5 size-3.5"/>}{busy?'Connecting…':'Connect'}</Button>
  </>}
 </div>
}
