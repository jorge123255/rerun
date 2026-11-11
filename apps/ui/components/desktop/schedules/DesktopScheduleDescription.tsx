'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PencilIcon } from '@/lib/icons'
import { scheduleSummary } from '@/lib/schedules/cron'
import { createDesktopScheduleParser, validateDesktopSchedulePreview, type DesktopScheduleParser, type DesktopSchedulePreview, type DesktopScheduleSelection } from '@/lib/desktop/schedule-description'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { useDesktopLocale } from '../DesktopLocale'
import type { DesktopProvider } from '@/lib/desktop/settings'

export function DesktopScheduleDescription({mode,cron,runAt,timezone,agentId,connectionId,provider,model,routine,disabled=false,onChange,parser}: {
    mode:'cron'|'runAt'
    cron:string
    runAt:string
    timezone:string
    agentId:string
    connectionId:string|null
    provider:DesktopProvider|null
    model:string|null
    routine?:{slug:string;revision:string}
    disabled?:boolean
    onChange:(next:DesktopScheduleSelection)=>void
    parser?:DesktopScheduleParser
}) {
    const { t, language } = useDesktopLocale()
    const effectiveParser=parser??createDesktopScheduleParser({agentId,connectionId,provider,model,slug:routine?.slug,expectedRevision:routine?.revision})
    const [open,setOpen]=useState(false),[description,setDescription]=useState(''),[busy,setBusy]=useState(false)
    const [error,setError]=useState(''),[preview,setPreview]=useState<DesktopSchedulePreview|null>(null)
    const epoch=useRef(0),request=useRef<AbortController|undefined>(undefined)
    const abortRequest=useCallback(()=>{epoch.current++;request.current?.abort();request.current=undefined},[])
    const resetPreview = useCallback(() => {
        abortRequest()
        setBusy(false)
        setPreview(null)
        setError('')
    }, [abortRequest])
    useEffect(() => () => abortRequest(), [abortRequest])
    useEffect(resetPreview, [mode, cron, runAt, timezone, agentId, connectionId, provider, model, routine?.slug, routine?.revision, disabled, resetPreview])

    function changeOpen(next: boolean) {
        if (!next) resetPreview()
        setOpen(next)
    }

    function changeDescription(value: string) {
        setDescription(value)
        resetPreview()
    }

    function applyPreview() {
        if (!preview || disabled) return
        const { selection } = preview
        if (selection.mode === 'runAt' && Date.parse(selection.runAt) <= Date.now()) {
            setPreview(null)
            setError(t('routines.expiredPreview'))
            return
        }
        onChange(selection)
        setDescription('')
        changeOpen(false)
    }

    async function previewSchedule(){
        if(!description.trim()||busy||disabled)return
        const own=++epoch.current,controller=new AbortController()
        request.current=controller
        setBusy(true);setError('');setPreview(null)
        try {
            const result=await effectiveParser({description:description.trim(),nowIso:new Date().toISOString(),timezone,signal:controller.signal})
            if(own!==epoch.current||controller.signal.aborted)return
            if(result.status==='ok'){
                const valid=validateDesktopSchedulePreview(result.value,timezone)
                if(valid)setPreview(valid)
                else setError(t('routines.invalidPreview'))
            }else setError(result.message.slice(0,300))
        }catch{
            if(own===epoch.current&&!controller.signal.aborted)setError(t('routines.parseFailed'))
        }finally{
            if(own===epoch.current){setBusy(false);request.current=undefined}
        }
    }
    const summary=scheduleSummary({cron:mode==='cron'?cron:null,runAt:mode==='runAt'?runAt:null,timezone}, (key, values) => t(`routines.${key}`, values), desktopLocaleTag(language.locale))
    return <Field label={t('routines.when')}>
        <div className="flex items-center gap-1.5">
            <div className="flex h-8 flex-1 items-center rounded-md border border-input bg-muted/40 px-3 text-sm"><span className={summary==='—'?'text-muted-foreground':''}>{summary}</span></div>
            <Popover open={open} onOpenChange={changeOpen}>
                <PopoverTrigger asChild><Button type="button" size="icon-sm" variant="outline" disabled={disabled} aria-label={t('routines.describeButton')}><PencilIcon className="size-3.5"/><span className="sr-only">{t('routines.describeButton')}</span></Button></PopoverTrigger>
                <PopoverContent align="end" className="w-80 space-y-3 p-3">
                    <Input label={t('routines.describeField')} aria-label={t('routines.describeField')} hideRequired autoFocus value={description} onChange={event => changeDescription(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();void previewSchedule()}}} placeholder={t('routines.describePlaceholder')} className="h-8 text-sm" disabled={busy}/>
                    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                    {preview && <div className="rounded-md border border-input bg-muted/30 p-2 text-xs" aria-label={t('routines.preview')}>
                        <p className="font-medium">{preview.label}</p>
                        <p className="mt-1 font-mono break-all">{preview.selection.mode==='cron'?preview.selection.cron:preview.selection.runAt}</p>
                        <p className="mt-1 text-muted-foreground">{preview.selection.timezone}</p>
                    </div>}
                    <div className="flex justify-end gap-2">
                        <Button type="button" size="sm" variant="ghost" onClick={()=>changeOpen(false)}>{t('cancel')}</Button>
                        {preview ? <Button type="button" size="sm" disabled={disabled} onClick={applyPreview}>{t('routines.useSchedule')}</Button> : <Button type="button" size="sm" loading={busy} disabled={disabled||busy||!description.trim()} onClick={()=>void previewSchedule()}>{t('routines.makePreview')}</Button>}
                    </div>
                </PopoverContent>
            </Popover>
        </div>
    </Field>
}
