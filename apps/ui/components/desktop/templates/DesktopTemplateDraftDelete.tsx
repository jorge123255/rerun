'use client'
import { useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Trash2Icon } from '@/lib/icons'
import type { DesktopPortableTemplateActions } from '@/lib/desktop/portable-template-actions'
type Props = { templateId:string; revision:string; title:string; actions:DesktopPortableTemplateActions; onDeleted(templateId:string):void }
export function DesktopTemplateDraftDelete(props:Props) { return <DraftDelete key={`${props.templateId}:${props.revision}`} {...props} /> }
function DraftDelete({templateId,revision,title,actions,onDeleted}:Props) {
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),alive=useRef(true),running=useRef(false),attempt=useRef<string|null>(null)
    useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
    async function remove() {
        if(running.current)return;running.current=true;setBusy(true);setError('')
        try {
            attempt.current ??= crypto.randomUUID()
            const result=await actions.deleteTemplate({templateId,revision,requestId:attempt.current})
            if(!alive.current)return
            if(!result.ok || result.result.status!=='deleted' || result.result.templateId!==templateId || result.result.revision!==revision){setError('Delete acknowledgement unavailable. Retry the same attempt.');return}
            onDeleted(templateId)
        } catch {if(alive.current)setError('Delete acknowledgement unavailable. Retry the same attempt.')}
        finally {running.current=false;if(alive.current)setBusy(false)}
    }
    return <div className="min-w-0 space-y-2"><ConfirmDialog title="Delete this template for good?" description={`Only the local draft “${title}” is removed. Other templates and installed coworkers stay.`} confirmLabel="Delete from library" onConfirm={()=>void remove()} pending={busy}>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete template" disabled={busy}><Trash2Icon className="size-3.5" /></Button>
    </ConfirmDialog>{error&&<p role="alert" className="break-words text-xs text-destructive">{error}</p>}</div>
}
