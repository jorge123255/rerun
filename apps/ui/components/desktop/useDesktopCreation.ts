'use client'

import {useCallback,useEffect,useRef,useState} from 'react'
import {z} from 'zod'
import type {GridPosition} from '@rerun/ui/iso-grid'
import type {DesktopAgentView} from './DesktopApp'
import type {DesktopCreateOutcome,DesktopCreationIntent} from '@/lib/desktop/new-agent'
import {holdDraftAdmission,isDesktopQuitting} from '@/lib/desktop/draft-writes'

const position=z.object({col:z.number().int().safe(),row:z.number().int().safe()}).strict()
const intent=z.object({requestId:z.string().min(1).max(200),name:z.string().min(1).max(60),kickoff:z.string().min(1).max(2000),suggestionId:z.string().max(200).nullable(),scheduled:z.boolean()}).strict()
const receipt=z.object({intent,position,spaceId:z.string().min(1).max(200),phase:z.enum(['reserved','created','started']).optional()}).strict()
const pendingReply=z.object({pending:receipt.nullable()}).strict()
const agent=z.object({id:z.string().min(1).max(200),name:z.string(),description:z.string(),createdAt:z.string(),updatedAt:z.string(),position:position.nullable().optional(),spaceId:z.string().optional(),enabled:z.boolean().optional()})
const success=z.object({agent,sessionId:z.string().min(1).max(200)})
const refusal=z.object({error:z.string(),code:z.enum(['position_occupied','creation_refused']),definite:z.literal(true)})
type Created=z.infer<typeof success>
export type DesktopCreationPlacement={intent:DesktopCreationIntent;spaceId?:string;position?:GridPosition;submitted:boolean;saving:boolean;error?:string}

/** The unsent tile is disposable. Once submitted, only the authoritative receipt may settle it. */
export function useDesktopCreation(onCreated:(agent:DesktopAgentView,sessionId:string)=>Promise<void>) {
 const [placement,setPlacement]=useState<DesktopCreationPlacement|null>(null)
 const current=useRef<DesktopCreationPlacement|null>(null),result=useRef<Created|null>(null),presented=useRef(false)
 const [checking,setChecking]=useState(true),[checkError,setCheckError]=useState('')
 const ready=useRef(false),alive=useRef(true),flight=useRef(false),reading=useRef<AbortController|null>(null),writing=useRef<AbortController|null>(null)
 const generation=useRef(0),settle=useRef<((outcome:DesktopCreateOutcome)=>void)|null>(null),created=useRef(onCreated)
 created.current=onCreated
 const publish=useCallback((next:DesktopCreationPlacement|null)=>{current.current=next;if(alive.current)setPlacement(next)},[])

 const refresh=useCallback(async()=>{
  if(flight.current || current.current || isDesktopQuitting())return
  reading.current?.abort();const controller=new AbortController(),epoch=++generation.current;reading.current=controller
  ready.current=false;setChecking(true);setCheckError('')
  const timer=setTimeout(()=>controller.abort(),15_000)
  try{
   const response=await fetch('/api/desktop/new-agent',{cache:'no-store',signal:controller.signal})
   if(!response.ok)throw new Error('Could not check your previous creation. Try again before creating another coworker.')
   const body=pendingReply.parse(await response.json())
   if(!alive.current || controller.signal.aborted || generation.current!==epoch)return
   if(body.pending)publish({...body.pending,submitted:true,saving:false,error:'Your previous creation needs confirmation. Retry checks the same coworker and first chat.'})
   ready.current=true
  }catch{
   if(alive.current && generation.current===epoch)setCheckError('Could not check your previous creation. Try again before creating another coworker.')
  }finally{
   clearTimeout(timer)
   if(reading.current===controller)reading.current=null
   if(alive.current && generation.current===epoch)setChecking(false)
  }
 },[publish])
 useEffect(()=>{
  alive.current=true;void refresh()
  return()=>{alive.current=false;generation.current++;reading.current?.abort();writing.current?.abort();settle.current?.({kind:'uncertain',error:'Creation is still being checked.'});settle.current=null}
 },[refresh])

 const begin=useCallback((next:DesktopCreationIntent,spaceId?:string):Promise<DesktopCreateOutcome>=>{
  if(!ready.current || current.current || flight.current || isDesktopQuitting())return Promise.resolve({kind:'refused',error:'Check the previous creation before starting another.'})
  result.current=null;presented.current=false
  publish({intent:next,spaceId,submitted:false,saving:false})
  return new Promise(resolve=>{settle.current=resolve})
 },[publish])
 const cancel=useCallback(()=>{
  if(!current.current || current.current.submitted || flight.current)return
  publish(null);result.current=null;presented.current=false;settle.current?.({kind:'refused',error:''});settle.current=null
 },[publish])
 const place=useCallback(async(anchor:GridPosition,spaceId:string)=>{
  const draft=current.current
  if(!draft || flight.current || !alive.current || isDesktopQuitting())return
  const fixed={...draft,position:draft.position??anchor,spaceId:draft.spaceId??spaceId,submitted:true,saving:true,error:undefined}
  // Capture synchronously before the request: every retry retains these exact bytes.
  flight.current=true;publish(fixed)
  const controller=new AbortController();writing.current=controller
  const timer=setTimeout(()=>controller.abort(),45_000),release=holdDraftAdmission()
  try{
   if(!result.current){
    const response=await fetch('/api/desktop/new-agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({intent:fixed.intent,position:fixed.position,spaceId:fixed.spaceId}),signal:controller.signal})
    const body=await response.json()
    if(!response.ok){
     const rejected=refusal.safeParse(body)
     if(rejected.success){
      if(alive.current)publish({...fixed,spaceId:draft.spaceId,position:undefined,submitted:false,saving:false,error:rejected.data.error})
      return
     }
     throw new Error('Could not confirm creation. Retry checks the same coworker; it will not start another.')
    }
    result.current=success.parse(body)
    controller.signal.throwIfAborted()
    if(!alive.current)return
   }
   if(!presented.current){await created.current(result.current!.agent,result.current!.sessionId);presented.current=true}
   controller.signal.throwIfAborted()
   const response=await fetch('/api/desktop/new-agent',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:fixed.intent.requestId}),signal:controller.signal})
   const acknowledged=z.object({acknowledged:z.literal(true)}).strict().safeParse(await response.json())
   if(!response.ok || !acknowledged.success)throw new Error('Your coworker is created, but its confirmation could not be saved. Retry checks the same creation.')
   controller.signal.throwIfAborted()
   if(alive.current){publish(null);result.current=null;settle.current?.({kind:'created'});settle.current=null}
  }catch{
   if(alive.current)publish({...fixed,saving:false,error:result.current?'Your coworker is created, but its confirmation could not be saved. Retry checks the same creation.':'Could not confirm creation. Retry checks the same coworker; it will not start another.'})
  }finally{
   clearTimeout(timer);writing.current=null;flight.current=false;release()
  }
 },[publish])
 return {placement,checking,checkError,refresh,begin,cancel,place}
}
