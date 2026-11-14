'use client'
import {useCallback,useEffect,useRef,useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {CheckCircle2Icon,ExternalLinkIcon,Loader2Icon,XCircleIcon} from '@/lib/icons'
import type {OAuthStatus} from '@/lib/desktop/server/mcp/oauth-loopback'

const statusSchema=z.object({state:z.enum(['idle','waiting','connected','error','unsupported']),message:z.string().max(400).optional()}).strict()
const responseSchema=z.union([statusSchema,z.object({status:statusSchema,authorizationUrl:z.string().max(8192).optional()}).strict()])
type Props={name:string;revision:string;active?:boolean} & (
 {agentId:string;vaultId?:never} | {vaultId:string;agentId?:never}
)
type Action='start'|'status'|'cancel'

async function readResponse(response:Response,signal:AbortSignal) {
 const reader=response.body?.getReader()
 if(!reader)throw new Error('Authorization unavailable')
 const chunks:Uint8Array[]=[];let bytes=0
 const stop=()=>{void reader.cancel().catch(()=>{})}
 signal.addEventListener('abort',stop,{once:true})
 try {
  for(;;){
   signal.throwIfAborted()
   const next=await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve,reject)=>{
    const cancel=()=>reject(new Error('Authorization cancelled'))
    signal.addEventListener('abort',cancel,{once:true})
    reader.read().then(value=>{signal.removeEventListener('abort',cancel);resolve(value)},error=>{signal.removeEventListener('abort',cancel);reject(error)})
    if(signal.aborted)cancel()
   })
   if(next.done)break;bytes+=next.value.length;if(bytes>16_384)throw new Error('Invalid authorization response');chunks.push(next.value)
  }
  signal.throwIfAborted()
  const data=new Uint8Array(bytes);let offset=0
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length}
  return responseSchema.parse(JSON.parse(new TextDecoder().decode(data)))
 }finally{signal.removeEventListener('abort',stop);void reader.cancel().catch(()=>{})}
}

export function DesktopMcpOAuthAuthorize(props:Props) {
 return <Authorization key={JSON.stringify([props.agentId,props.vaultId,props.name,props.revision])} {...props}/>
}
function Authorization({agentId,vaultId,name,revision,active=true}:Props) {
 const [status,setStatus]=useState<OAuthStatus>({state:'idle'}),[pending,setPending]=useState<Action|null>(null),[link,setLink]=useState('')
 const [visible,setVisible]=useState(()=>typeof document==='undefined'||document.visibilityState!=='hidden')
 const epoch=useRef(0),inflight=useRef<AbortController|null>(null),operation=useRef<Action|null>(null)
 const action=useCallback(async(action:Action)=>{
  if(!active || document.visibilityState==='hidden' || action==='status' && operation.current && operation.current!=='status')return
  const generation=++epoch.current
  inflight.current?.abort()
  const controller=new AbortController();inflight.current=controller;operation.current=action
  const timer=setTimeout(()=>controller.abort(),35_000)
  setPending(action)
  try {
   const path=vaultId?'/api/desktop/vault/oauth':`/api/desktop/coworkers/${encodeURIComponent(agentId!)}/mcp/oauth`
   const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,revision,action,...(vaultId?{id:vaultId}:{})}),cache:'no-store',signal:controller.signal})
   if(!response.ok)throw new Error('Authorization unavailable')
   const data=await readResponse(response,controller.signal)
   if(generation!==epoch.current)return
   const next='status' in data?data.status:data
   const candidate='authorizationUrl' in data && data.authorizationUrl?new URL(data.authorizationUrl):null
   if(candidate && (candidate.protocol!=='https:' || candidate.username || candidate.password || candidate.hash || candidate.port && candidate.port!=='443'))throw new Error('Invalid authorization link')
   setStatus(next)
   if(action==='start' || action==='cancel' || next.state!=='waiting')setLink(candidate?.href??'')
  }catch{if(generation===epoch.current){setStatus({state:'error',message:vaultId?'Vault sign-in is unavailable. Refresh the entry and retry.':'Authorization unavailable. Check this coworker’s MCP permission and retry.'});setLink('')}}
  finally{clearTimeout(timer);if(generation===epoch.current){inflight.current=null;operation.current=null;setPending(null)}}
 },[agentId,vaultId,name,revision,active])
 useEffect(()=>{
  const visibility=()=>setVisible(document.visibilityState!=='hidden')
  document.addEventListener('visibilitychange',visibility)
  return()=>document.removeEventListener('visibilitychange',visibility)
 },[])
 useEffect(()=>{
  if(active && visible)void action('status')
  return()=>{epoch.current++;inflight.current?.abort();inflight.current=null;operation.current=null}
 },[action,active,visible])
 useEffect(()=>{
  if(!active || !visible || pending || status.state!=='waiting')return
  const timer=setTimeout(()=>{void action('status')},1500)
  return()=>clearTimeout(timer)
 },[status,action,active,visible,pending])
 const busy=pending==='start'||pending==='cancel'
 return <div className="space-y-2 py-1" aria-label={`Authorization for ${name}`}>
  {status.state==='connected'?<>
   <div className="flex items-center gap-2 text-sm text-green-600"><CheckCircle2Icon className="size-3.5"/>Connected</div>
   {vaultId&&<Button variant="outline" size="sm" disabled={!active||!visible||!!pending} onClick={()=>action('start')}>Reconnect</Button>}
  </>:<>
   {(status.state==='error'||status.state==='unsupported')&&<p role="alert" className="flex items-start gap-2 text-sm text-destructive break-words"><XCircleIcon className="size-3.5 shrink-0"/>{status.message}</p>}
   <Button variant="outline" size="sm" className="w-full" disabled={!active||!visible||busy||status.state==='waiting'||pending==='status'} onClick={()=>action('start')}>
    {busy||status.state==='waiting'?<Loader2Icon className="size-3.5 animate-spin mr-1.5"/>:<ExternalLinkIcon className="size-3.5 mr-1.5"/>}
    {status.state==='waiting'?'Waiting for authorization…':status.state==='error'||status.state==='unsupported'?'Retry sign-in':'Sign in with browser'}
   </Button>
   {link&&status.state==='waiting'&&<a className="text-sm underline break-words" href={link} target="_blank" rel="noreferrer">Open authorization in browser</a>}
   {status.state==='waiting'&&<Button variant="ghost" size="sm" disabled={!active||!visible||busy} onClick={()=>action('cancel')}>Cancel</Button>}
  </>}
 </div>
}
