'use client'
import {useState} from 'react'
import {AuthMethodPicker} from '@/components/services/AuthMethodPicker'
import type {AuthMethodSummary} from '@/lib/services/types'
export function DesktopCatalogOAuthMethods({methods,availability,onSelect}:{methods:AuthMethodSummary[];availability:{id:string;supported:boolean;reason:string|null}[];onSelect:(methodId:string)=>void}){
 const [reason,setReason]=useState<string|null>(null)
 return <div className="min-w-0 space-y-2"><AuthMethodPicker methods={methods} onSelect={id=>{
  const method=methods.find(m=>m.id===id),state=availability.find(m=>m.id===id)
  if(!method||!state?.supported){setReason(state?.reason??'This authentication method is unavailable on this Mac.');return}
  setReason(null);onSelect(id)
 }}/>{reason&&<p role="alert" className="break-words text-sm text-muted-foreground">{reason}</p>}</div>
}
