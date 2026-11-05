'use client'
import {useCallback,useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
import {CheckCircle2Icon,ExternalLinkIcon,Loader2Icon,XCircleIcon} from '@/lib/icons'
import type {OAuthStatus} from '@/lib/desktop/server/mcp/oauth-loopback'
export function DesktopMcpOAuthAuthorize({agentId,name,revision}:{agentId:string;name:string;revision:string}) {
 const [status,setStatus]=useState<OAuthStatus>({state:'idle'}),[busy,setBusy]=useState(false),[link,setLink]=useState('')
 const epoch=useRef(0)
 const action=useCallback(async(action:'start'|'status'|'cancel')=>{
  const generation=++epoch.current
  setBusy(true)
  try {
   const response=await fetch(`/api/desktop/coworkers/${encodeURIComponent(agentId)}/mcp/oauth`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,revision,action}),cache:'no-store'})
   const data=await response.json()
   if(generation!==epoch.current)return
   if(!response.ok)throw new Error()
   setStatus(data.status??data)
   const candidate=data.authorizationUrl?new URL(data.authorizationUrl):null
   if(candidate && (candidate.protocol!=='https:' || candidate.username || candidate.password))throw new Error()
   if(action==='start' || action==='cancel' || (data.status??data).state!=='waiting')setLink(candidate?.href??'')
  }catch{if(generation===epoch.current){setStatus({state:'error',message:'Authorization failed. Retry.'});setLink('')}}
  finally{if(generation===epoch.current)setBusy(false)}
 },[agentId,name,revision])
 useEffect(()=>{epoch.current++;setStatus({state:'idle'});setLink('');setBusy(false);void action('status');return()=>{epoch.current++}},[action])
 useEffect(()=>{
  if(status.state!=='waiting')return
  const timer=setTimeout(()=>{void action('status')},1500)
  return()=>clearTimeout(timer)
 },[status,action])
 return <div className="space-y-2 py-1">
  {status.state==='connected'?<div className="flex items-center gap-2 text-sm text-green-600"><CheckCircle2Icon className="size-3.5"/>Connected</div>:<>
   {(status.state==='error'||status.state==='unsupported')&&<p role="alert" className="flex items-start gap-2 text-sm text-destructive break-words"><XCircleIcon className="size-3.5 shrink-0"/>{status.message}</p>}
   <Button variant="outline" size="sm" className="w-full" disabled={busy||status.state==='waiting'} onClick={()=>action('start')}>
    {busy||status.state==='waiting'?<Loader2Icon className="size-3.5 animate-spin mr-1.5"/>:<ExternalLinkIcon className="size-3.5 mr-1.5"/>}
    {status.state==='waiting'?'Waiting for authorization…':status.state==='error'||status.state==='unsupported'?'Retry':'Connect'}
   </Button>
   {link&&status.state==='waiting'&&<a className="text-sm underline break-words" href={link} target="_blank" rel="noreferrer">Open authorization in browser</a>}
   {status.state==='waiting'&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>action('cancel')}>Cancel</Button>}
  </>}
 </div>
}
