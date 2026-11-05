'use client'
import {useCallback,useEffect,useRef,useState} from 'react'
import {ActionApprovalBlock} from '@/components/chat/ActionApprovalBlock'
import {Button} from '@/components/ui/button'
import type {NativeReview} from '@/lib/desktop/server/native-writeback/service'
type Props={agentId:string;sessionId:string;refreshKey?:string|number}
export function DesktopNativeWritebackReview(props:Props){return <Review key={`${props.agentId}/${props.sessionId}`} {...props}/>}
function Review({agentId,sessionId,refreshKey}:Props){
 const [cursor,setCursor]=useState<string|undefined>(),[files,setFiles]=useState<NativeReview[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[version,setVersion]=useState(0)
 const epoch=useRef(0),alive=useRef(true),pending=useRef(false)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++}},[])
 const url=`/api/desktop/coworkers/${encodeURIComponent(agentId)}/native-writeback`
 const load=useCallback(async(older?:string)=>{
  const current=++epoch.current
  const params=new URLSearchParams({sessionId});if(older)params.set('cursor',older)
  try{const response=await fetch(`${url}?${params}`,{cache:'no-store'});if(!response.ok)throw new Error();const data=await response.json();if(alive.current && current===epoch.current){setFiles(previous=>older?[...previous,...data.files]:data.files);setCursor(data.nextCursor);setVersion(value=>value+1);setError('')}}catch{if(alive.current && current===epoch.current)setError('Could not load proposed file changes.')}
 },[url,sessionId])
 useEffect(()=>{void load()},[load,refreshKey])
 async function decide(item:NativeReview,decision:'apply'|'reject'){
  if(pending.current)return;pending.current=true;setBusy(true);epoch.current++
  try{
   const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,proposalId:item.id,path:item.path,digest:item.digest,decision})})
   const result=await response.json()
   if(!response.ok || !['saved','rejected'].includes(result.state))throw new Error()
   await load()
  }catch{if(alive.current){await load();setError('No save acknowledgement. Inspect the durable receipt before taking another action.')}}
  finally{pending.current=false;if(alive.current)setBusy(false)}
 }
 if(!files.length&&!error)return null
 return <div className="space-y-3 min-w-0">
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <Button variant="outline" size="sm" disabled={busy} onClick={()=>load()}>Refresh file changes</Button>
  {files.map(item=><div key={`${item.id}/${item.path}/${item.digest}`}>
   {item.state==='pending'?<ActionApprovalBlock key={`${item.id}/${item.path}/${item.digest}/${version}`} disabled={busy} approvals={[{action:`Publish changes to ${item.path}`,detail:`--- ${item.before===null?'/dev/null':item.path}\n+++ ${item.path}\n${(item.before??'').split('\n').map(line=>'-'+line).join('\n')}\n${item.after.split('\n').map(line=>'+'+line).join('\n')}`}]} onSubmit={decisions=>{void decide(item,decisions[0].decision==='approved'?'apply':'reject')}}/>:<p className="text-xs break-all">{item.path}: {item.state==='claimed'?'Unknown acknowledgement; inspect Files':item.state}</p>}
  </div>)}
  {cursor&&<Button variant="outline" size="sm" disabled={busy} onClick={()=>load(cursor)}>Load older file changes</Button>}
  <p className="text-xs text-muted-foreground">Approval applies only to these captured bytes. Publishing also requires the current private writeback permission. No deletions are published.</p>
 </div>
}
