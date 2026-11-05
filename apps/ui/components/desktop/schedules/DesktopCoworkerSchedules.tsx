'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EngineSchedule } from '@/lib/engine/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { MarkdownTextarea } from '@/components/ui/markdown-textarea'
import { TimezoneCombobox } from '@/components/agent/TimezoneCombobox'
import { PanelList,PanelListHeader,PanelScroller } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSteps } from '@/components/ui/panel-steps'
import { PanelDeleteButton,PanelEditorBody,PanelEditorFooter,PanelEditorHeader,PanelEditorShell } from '@/components/ui/panel-editor'
import { EmptyState } from '@/components/ui/empty-state'
import { CalendarClockIcon,PlusIcon } from '@/lib/icons'
import { scheduleSummary } from '@/lib/schedules/cron'
import { Badge } from '@rerun/ui/primitives'
import type { DesktopScheduleInput } from '@/lib/desktop/server/schedules/api'
import { DesktopTaskNotifyField } from '../DesktopTaskNotifyField'

type Chat={agentId:string;sessionId:string;engineSessionId:string;tabUid:string;title:string;runId:string|null}
type Task=EngineSchedule & {nextRunAt:string|null;lastResultUnknown?:boolean;lastResult:{status:string;runId:string;chat:Chat}|null}
class ScheduleRequestError extends Error {}
export function DesktopCoworkerSchedules(props:{agentId:string;onOpenSession:(chat:Chat)=>void}) {return <Schedules key={props.agentId} {...props}/>}
function Schedules({agentId,onOpenSession}:{agentId:string;onOpenSession:(chat:Chat)=>void}) {
    const [tasks,setTasks]=useState<Task[]|null>(null),[editing,setEditing]=useState<Task|'new'|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true)
    const alive=useRef(true),epoch=useRef(0),listEpoch=useRef(0)
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;listEpoch.current++}},[])
    const request=useCallback(async(method:string,body?:unknown)=>{
        const response=await fetch(`/api/desktop/coworkers/${encodeURIComponent(agentId)}/schedules`,{method,cache:'no-store',headers:body ? {'Content-Type':'application/json'} : {},body:body ? JSON.stringify(body) : undefined})
        const result=await response.json();if(!response.ok)throw new ScheduleRequestError(typeof result?.error==='string' && result.error.trim().length>0 && result.error.length<=500 ? result.error : 'Task request failed');return result
    },[agentId])
    const load=useCallback(async()=>{
        const own=++listEpoch.current
        setLoading(true)
        try {
            const data=await request('GET')
            if(!Array.isArray(data))throw new Error('Invalid task list')
            if(alive.current && own===listEpoch.current){setTasks(data);setError('')}
        } catch(error) {
            if(alive.current && own===listEpoch.current)setError(error instanceof ScheduleRequestError ? error.message : 'Could not load scheduled tasks')
        } finally {
            if(alive.current && own===listEpoch.current)setLoading(false)
        }
    },[request])
    useEffect(()=>{void load()},[load])
    function navigate(task:Task|'new'|null){epoch.current++;setEditing(task)}
    async function change(method:string,body:unknown){const own=epoch.current;listEpoch.current++;await request(method,body);if(alive.current && own===epoch.current){navigate(null);await load()}}
    const newButton=<Button size="sm" variant="outline" disabled={loading || Boolean(error) || tasks===null} onClick={()=>{if(!loading && !error && tasks!==null)navigate('new')}}><PlusIcon className="size-3.5 mr-1"/>New</Button>
    return <PanelSteps stepKey={editing ? 'editor' : 'list'} depth={editing ? 1 : 0}>{editing ?
        <ScheduleEditor key={editing==='new'?'new':editing.slug} agentId={agentId} task={editing==='new'?undefined:editing} onBack={()=>navigate(null)}
            onSave={input=>change('PUT',{slug:editing==='new'?undefined:editing.slug,input})}
            onDelete={editing==='new'?undefined:()=>change('DELETE',{slug:editing.slug})}
            onRun={editing==='new'?undefined:async requestId=>{const own=epoch.current;const chat=await request('POST',{slug:editing.slug,action:'run',requestId});if(alive.current && own===epoch.current){onOpenSession(chat);await load()}}}/> :
        <div className="flex flex-col h-full">{tasks!==null && !loading && !error ? <PanelListHeader count={tasks.length} noun="scheduled task">{newButton}</PanelListHeader> : <PanelListHeader>{newButton}</PanelListHeader>}
            {error && <p role="alert" className="p-3 text-xs text-destructive">{error}</p>}
            {loading && <p className="p-3 text-xs" role="status">Loading scheduled tasks…</p>}
            {error && tasks!==null && tasks.length>0 && <p className="px-3 text-xs text-muted-foreground">Showing previously loaded tasks.</p>}
            {!loading && !error && tasks?.length===0 ? <EmptyState icon={CalendarClockIcon} title="No scheduled tasks yet" description="Add a task for this local coworker to run while the app is open."/> : tasks && tasks.length>0 ?
            <PanelScroller><PanelList>{tasks.map(task=><div key={task.slug}><PanelRow onClick={()=>navigate(task)} title={task.name} description={scheduleSummary(task)} meta={!task.enabled ? <Badge size="xs" tone="neutral" glow={false}>paused</Badge> : undefined}
                footer={<span>Next run: {task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : '—'} · Last result: {task.lastResult?.status ?? (task.lastResultUnknown ? 'Unavailable — history not established' : 'Not run yet')}</span>}/>
                {task.lastResult?.chat && <Button size="sm" variant="ghost" onClick={()=>onOpenSession(task.lastResult!.chat)}>Open result chat</Button>}</div>)}</PanelList></PanelScroller> : null}
            <p className="p-3 text-xs text-muted-foreground">Tasks run while Rerun is open. After sleep or reopening, one due occurrence runs. Refresh to see the latest result.</p><Button size="sm" variant="ghost" disabled={loading} onClick={()=>void load()}>Refresh</Button>
        </div>}</PanelSteps>
}
function ScheduleEditor({agentId,task,onBack,onSave,onDelete,onRun}:{agentId:string;task?:Task;onBack:()=>void;onSave:(input:DesktopScheduleInput)=>Promise<void>;onDelete?:()=>Promise<void>;onRun?:(requestId:string)=>Promise<void>}) {
    const [name,setName]=useState(task?.name ?? ''),[description,setDescription]=useState(task?.description ?? ''),[body,setBody]=useState(task?.body ?? '')
    const [mode,setMode]=useState(task?.runAt ? 'runAt' : 'cron'),[cron,setCron]=useState(task?.cron ?? '0 8 * * *'),[runAt,setRunAt]=useState(task?.runAt ?? '')
    const [timezone,setTimezone]=useState(task?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),[enabled,setEnabled]=useState(task?.enabled ?? true),[busy,setBusy]=useState(false),[error,setError]=useState('')
    const pending=useRef(false),alive=useRef(true),manual=useRef<string|null>(null)
    useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
    async function perform(action:()=>Promise<void>){if(pending.current)return;pending.current=true;setBusy(true);setError('');try{await action()}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Task request failed')}finally{pending.current=false;if(alive.current)setBusy(false)}}
    return <PanelEditorShell><PanelEditorHeader title={task?'Edit task':'New task'} onBack={busy?undefined:()=>{if(!pending.current)onBack()}}/><PanelEditorBody>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Field label="Name"><Input aria-label="Name" value={name} onChange={e=>setName(e.target.value)} maxLength={120} disabled={busy}/></Field><Field label="Description"><Input aria-label="Description" value={description} onChange={e=>setDescription(e.target.value)} disabled={busy}/></Field>
        <Field label="When"><select aria-label="Schedule type" value={mode} disabled={busy} onChange={e=>setMode(e.target.value)}><option value="cron">Recurring</option><option value="runAt">Once</option></select></Field>
        {mode==='cron'?<Field label="Cron expression"><Input aria-label="Cron expression" value={cron} onChange={e=>setCron(e.target.value)} disabled={busy}/></Field>:<Field label="Run at (ISO timestamp with timezone)"><Input aria-label="Run at (ISO timestamp with timezone)" value={runAt} onChange={e=>setRunAt(e.target.value)} placeholder="2026-12-01T08:00:00-06:00" disabled={busy}/></Field>}
        <Field label="Timezone"><TimezoneCombobox value={timezone} onChange={setTimezone}/></Field>
        <p className="text-xs text-muted-foreground">Raw cron and ISO time are the local fallback. Natural-language schedule parsing is unavailable. This task uses the coworker's configured local provider and model.</p>
        <Field orientation="row" label="Enabled"><Switch checked={enabled} disabled={busy} onCheckedChange={setEnabled}/></Field>
        {task?.slug && <DesktopTaskNotifyField agentId={agentId} source="schedule" slug={task.slug} disabled={busy}/>}
        <MarkdownTextarea label="Task prompt" dialogTitle="Edit the task prompt" value={body} onChange={setBody} disabled={busy}/>
        {task?.lastResult?.chat && <p className="text-xs">Last result: {task.lastResult.status}</p>}
    </PanelEditorBody><PanelEditorFooter>
        {onDelete && <PanelDeleteButton label="Delete task" busy={busy} disabled={busy} onClick={()=>perform(onDelete)} confirmDescription="The task stops firing and its schedule is removed. Runs it already produced are kept."/>}
        {onRun && <Button size="sm" variant="outline" title="Run now" disabled={busy || !task?.enabled} onClick={()=>perform(async()=>{manual.current ??=crypto.randomUUID();await onRun(manual.current);manual.current=null})}>Test Run</Button>}
        <Button size="sm" disabled={busy || !name.trim() || !body.trim()} onClick={()=>perform(()=>onSave({name,description,body,enabled,timezone,cron:mode==='cron'?cron:null,runAt:mode==='runAt'?new Date(runAt).toISOString():null}))}>{task?'Save changes':'Create task'}</Button>
    </PanelEditorFooter></PanelEditorShell>
}
