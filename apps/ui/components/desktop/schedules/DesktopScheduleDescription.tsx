'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PencilIcon } from '@/lib/icons'
import { scheduleSummary } from '@/lib/schedules/cron'
import { createDesktopScheduleParser, validateDesktopSchedulePreview, type DesktopScheduleParser, type DesktopSchedulePreview, type DesktopScheduleSelection } from '@/lib/desktop/schedule-description'
import type { DesktopProvider } from '@/lib/desktop/settings'

export function DesktopScheduleDescription({mode,cron,runAt,timezone,agentId,connectionId,provider,model,disabled=false,onChange,parser}: {
    mode:'cron'|'runAt'
    cron:string
    runAt:string
    timezone:string
    agentId:string
    connectionId:string|null
    provider:DesktopProvider|null
    model:string|null
    disabled?:boolean
    onChange:(next:DesktopScheduleSelection)=>void
    parser?:DesktopScheduleParser
}) {
    const effectiveParser=parser??createDesktopScheduleParser({agentId,connectionId,provider,model})
    const [open,setOpen]=useState(false),[description,setDescription]=useState(''),[busy,setBusy]=useState(false)
    const [error,setError]=useState(''),[preview,setPreview]=useState<DesktopSchedulePreview|null>(null)
    const epoch=useRef(0),request=useRef<AbortController|undefined>(undefined)
    const abortRequest=useCallback(()=>{epoch.current++;request.current?.abort();request.current=undefined},[])
    useEffect(()=>()=>abortRequest(),[abortRequest])
    useEffect(()=>{abortRequest();setBusy(false);setPreview(null);setError('')},[mode,cron,runAt,timezone,abortRequest])
    function changeOpen(next:boolean){if(!next){abortRequest();setBusy(false);setPreview(null);setError('')}setOpen(next)}
    async function previewSchedule(){
        if(!description.trim()||busy)return
        const own=++epoch.current,controller=new AbortController()
        request.current=controller
        setBusy(true);setError('');setPreview(null)
        try {
            const result=await effectiveParser({description:description.trim(),nowIso:new Date().toISOString(),timezone,signal:controller.signal})
            if(own!==epoch.current||controller.signal.aborted)return
            if(result.status==='ok'){
                const valid=validateDesktopSchedulePreview(result.value,timezone)
                if(valid)setPreview(valid)
                else setError('Could not understand that schedule. Edit the description or enter cron or an ISO time manually.')
            }else setError(result.message.slice(0,300))
        }catch{
            if(own===epoch.current&&!controller.signal.aborted)setError('Could not parse that schedule. Edit the description or enter cron or an ISO time manually.')
        }finally{
            if(own===epoch.current){setBusy(false);request.current=undefined}
        }
    }
    const summary=scheduleSummary({cron:mode==='cron'?cron:null,runAt:mode==='runAt'?runAt:null,timezone})
    return <Field label="When">
        <div className="flex items-center gap-1.5">
            <div className="flex h-8 flex-1 items-center rounded-md border border-input bg-muted/40 px-3 text-sm"><span className={summary==='—'?'text-muted-foreground':''}>{summary}</span></div>
            <Popover open={open} onOpenChange={changeOpen}>
                <PopoverTrigger asChild><Button type="button" size="icon-sm" variant="outline" disabled={disabled} aria-label="Describe schedule"><PencilIcon className="size-3.5"/><span className="sr-only">Describe schedule</span></Button></PopoverTrigger>
                <PopoverContent align="end" className="w-80 space-y-3 p-3">
                    <Input label="Describe the schedule" aria-label="Describe the schedule" hideRequired autoFocus value={description} onChange={event=>setDescription(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();void previewSchedule()}}} placeholder="every weekday at 8am" className="h-8 text-sm" disabled={busy}/>
                    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                    {preview && <div className="rounded-md border border-input bg-muted/30 p-2 text-xs" aria-label="Schedule preview">
                        <p className="font-medium">{preview.label}</p>
                        <p className="mt-1 font-mono break-all">{preview.selection.mode==='cron'?preview.selection.cron:preview.selection.runAt}</p>
                        <p className="mt-1 text-muted-foreground">{preview.selection.timezone}</p>
                    </div>}
                    <div className="flex justify-end gap-2">
                        <Button type="button" size="sm" variant="ghost" onClick={()=>changeOpen(false)}>Cancel</Button>
                        {preview ? <Button type="button" size="sm" onClick={()=>{onChange(preview.selection);setDescription('');changeOpen(false)}}>Use schedule</Button> : <Button type="button" size="sm" loading={busy} disabled={busy||!description.trim()} onClick={()=>void previewSchedule()}>Preview schedule</Button>}
                    </div>
                </PopoverContent>
            </Popover>
        </div>
    </Field>
}
