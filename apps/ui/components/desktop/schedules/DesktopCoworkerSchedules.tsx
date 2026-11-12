'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EngineSchedule } from '@/lib/engine/types'
import type { DesktopWorkspaceRoutineChat } from '@rerun/contracts'
import { ScheduleRequestError, scheduleRequest } from '@/lib/desktop/schedules/client'
import { DesktopScheduleHistory } from './DesktopScheduleHistory'
import type { ConnectionGroup } from '@/lib/engine/model-groups'
import { desktopModelViewSchema, type DesktopModelView } from '@/lib/desktop/chat-model'
import { desktopProvider } from '@/lib/desktop/settings'
import { RunModelField, type RunModelPick } from '@/components/agent/RunModelField'
import { DesktopScheduleDescription } from './DesktopScheduleDescription'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { MarkdownTextarea } from '@/components/ui/markdown-textarea'
import { TimezoneCombobox } from '@/components/agent/TimezoneCombobox'
import { PanelList,PanelListHeader,PanelScroller } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSteps } from '@/components/ui/panel-steps'
import { FxSchedulesLoading } from '../fx-repairs/PanelLoadingSkeletons'
import { PanelDeleteButton,PanelEditorBody,PanelEditorFooter,PanelEditorHeader,PanelEditorShell } from '@/components/ui/panel-editor'
import { EmptyState } from '@/components/ui/empty-state'
import { CalendarClockIcon,PlusIcon } from '@/lib/icons'
import { scheduleSummary } from '@/lib/schedules/cron'
import { Badge } from '@rerun/ui/primitives'
import type { DesktopScheduleInput } from '@/lib/desktop/server/schedules/api'
import { useDesktopScheduleToolNotices } from '@/lib/desktop/use-schedule-tool-notices'
import { DesktopScheduleToolNotice } from '../schedule-tools/DesktopScheduleToolNotice'
import { DesktopTaskNotifyField } from '../DesktopTaskNotifyField'
import { useDesktopLocale } from '../DesktopLocale'

type Chat = DesktopWorkspaceRoutineChat
type Task=EngineSchedule & {setupPending:boolean;nextRunAt:string|null;lastResult:{status:string;runId:string;chat:Chat}|null}
export function DesktopCoworkerSchedules(props:{agentId:string;onOpenSession:(chat:Chat)=>void}) {return <Schedules key={props.agentId} {...props}/>}
function Schedules({agentId,onOpenSession}:{agentId:string;onOpenSession:(chat:Chat)=>void}) {
    const [tasks,setTasks]=useState<Task[]|null>(null),[editing,setEditing]=useState<Task|'new'|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true)
    const [externalChange,setExternalChange]=useState(false)
    const alive=useRef(true),epoch=useRef(0),listEpoch=useRef(0)
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;listEpoch.current++}},[])
    const request=useCallback((method:string,body?:unknown)=>scheduleRequest(agentId,method,body),[agentId])
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
    const notice=useDesktopScheduleToolNotices(agentId,()=>{if(editing)setExternalChange(true);void load()})
    function navigate(task:Task|'new'|null){epoch.current++;setEditing(task);setExternalChange(false)}
    async function change(method:string,body:unknown){const own=epoch.current;listEpoch.current++;await request(method,body);if(alive.current && own===epoch.current){navigate(null);await load()}}
    const newButton=<Button size="sm" variant="outline" disabled={loading || Boolean(error) || tasks===null} onClick={()=>{if(!loading && !error && tasks!==null)navigate('new')}}><PlusIcon className="size-3.5 mr-1"/>New</Button>
    return <PanelSteps stepKey={editing ? 'editor' : 'list'} depth={editing ? 1 : 0}>{editing ?
        <ScheduleEditor stale={externalChange} key={editing==='new'?'new':editing.slug} agentId={agentId} task={editing==='new'?undefined:editing} onBack={()=>navigate(null)} onOpenSession={onOpenSession}
            onSave={input=>change('PUT',{slug:editing==='new'?undefined:editing.slug,input})}
            onDelete={editing==='new'?undefined:()=>change('DELETE',{slug:editing.slug,expectedRevision:editing.revision})}
            onRun={editing==='new'?undefined:async requestId=>{const own=epoch.current;const chat=await request('POST',{slug:editing.slug,action:'run',requestId,expectedRevision:editing.revision});if(alive.current && own===epoch.current){onOpenSession(chat);await load()}}}/> :
        <div className="flex flex-col h-full">{notice && <div className="px-3 pt-2 text-xs"><DesktopScheduleToolNotice outcome="committed" text={`The coworker changed routine ${notice.slug}. The list is refreshed.`}/></div>}{tasks!==null && !loading && !error ? <PanelListHeader count={tasks.length} noun="scheduled task">{newButton}</PanelListHeader> : <PanelListHeader>{newButton}</PanelListHeader>}
            {error && <p role="alert" className="p-3 text-xs text-destructive">{error}</p>}
            {loading && !error && <FxSchedulesLoading />}
            {error && tasks!==null && tasks.length>0 && <p className="px-3 text-xs text-muted-foreground">Showing previously loaded tasks.</p>}
            {!loading && !error && tasks?.length===0 ? <EmptyState icon={CalendarClockIcon} title="No scheduled tasks yet" description="Add a task for this local coworker to run while the app is open."/> : tasks && tasks.length>0 ?
            <PanelScroller><PanelList>{tasks.map(task=><div key={task.slug}><PanelRow onClick={()=>navigate(task)} title={task.name} description={scheduleSummary(task)} meta={!task.enabled ? <Badge size="xs" tone="neutral" glow={false}>paused</Badge> : undefined}
                footer={<span>Next run: {task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : '—'} · Last result: {task.lastResult?.status ?? 'Not run yet'}</span>}/>
                {task.lastResult?.chat && <Button size="sm" variant="ghost" onClick={()=>onOpenSession(task.lastResult!.chat)}>Open result chat</Button>}</div>)}</PanelList></PanelScroller> : null}
            <p className="p-3 text-xs text-muted-foreground">Tasks run while Rerun is open. After sleep or reopening, one due occurrence runs. Refresh to see the latest result.</p><Button size="sm" variant="ghost" disabled={loading} onClick={()=>void load()}>Refresh</Button>
        </div>}</PanelSteps>
}
function ScheduleEditor({agentId,task,onBack,onSave,onDelete,onRun,onOpenSession,stale=false}:{stale?:boolean;agentId:string;task?:Task;onBack:()=>void;onSave:(input:DesktopScheduleInput)=>Promise<void>;onDelete?:()=>Promise<void>;onRun?:(requestId:string)=>Promise<void>;onOpenSession:(chat:Chat)=>void}) {
    const { t } = useDesktopLocale()
    const [name,setName]=useState(task?.name ?? ''),[description,setDescription]=useState(task?.description ?? ''),[body,setBody]=useState(task?.body ?? '')
    const [mode,setMode]=useState<'cron'|'runAt'>(task?.runAt ? 'runAt' : 'cron'),[cron,setCron]=useState(task?.cron ?? '0 8 * * *'),[runAt,setRunAt]=useState(task?.runAt ?? '')
    const [timezone,setTimezone]=useState(task?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),[enabled,setEnabled]=useState(task?.enabled ?? true),[busy,setBusy]=useState(false),[error,setError]=useState('')
    const pending=useRef(false),alive=useRef(true),manual=useRef<string|null>(null)
    const [pick,setPick]=useState<RunModelPick>({connectionId:task?.connectionId ?? null,model:task?.model ?? null})
    const [modelView,setModelView]=useState<DesktopModelView|null>(null),[modelError,setModelError]=useState('')
    const [historyOpen, setHistoryOpen] = useState(false)
    useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
    useEffect(()=>{
        const controller=new AbortController()
        void fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/model`,{cache:'no-store',signal:controller.signal}).then(async response=>{
            const body=await response.json().catch(()=>null)
            if(!response.ok)throw new Error()
            const next=desktopModelViewSchema.parse(body)
            if(alive.current&&!controller.signal.aborted){setModelView(next);setModelError('')}
        }).catch(()=>{if(alive.current&&!controller.signal.aborted)setModelError('Could not load models')})
        return()=>controller.abort()
    },[agentId])
    const availableGroups=useMemo<ConnectionGroup[]>(()=>modelView?.catalog.map(group=>({connectionId:group.connectionId,label:group.name,provider:group.provider,models:group.models,defaultModel:group.models[0]?.id ?? '',planWindows:[]})) ?? [],[modelView])
    const savedProvider=task?.provider?desktopProvider.safeParse(task.provider):null
    const preservedProvider=pick.connectionId===task?.connectionId&&pick.model===task?.model&&savedProvider?.success?savedProvider.data:null
    const provider=pick.model?modelView?.catalog.find(group=>group.connectionId===pick.connectionId)?.provider ?? preservedProvider:null
    const unavailablePin=!!pick.model&&!!modelView&&!availableGroups.some(group=>group.connectionId===pick.connectionId&&group.models.some(model=>model.id===pick.model))
    const unverifiedPin=!!pick.model&&!modelView
    const incompletePin=!!pick.model&&(!pick.connectionId||!provider)
    const waitingForSetup = task?.setupPending === true && !task.enabled
    const modelChanged = Boolean(task && (pick.connectionId !== task.connectionId || pick.model !== task.model || provider !== task.provider))
    async function perform(action:()=>Promise<void>){if(stale || pending.current)return;pending.current=true;setBusy(true);setError('');try{await action()}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Task request failed')}finally{pending.current=false;if(alive.current)setBusy(false)}}
    if (historyOpen && task) return <DesktopScheduleHistory agentId={agentId} slug={task.slug} title={task.name} onBack={() => setHistoryOpen(false)} onOpenChat={onOpenSession} />
    return <PanelEditorShell><PanelEditorHeader title={task?'Edit task':'New task'} onBack={busy?undefined:()=>{if(!pending.current)onBack()}}>
        {task && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (!pending.current) setHistoryOpen(true) }}>History</Button>}
    </PanelEditorHeader><PanelEditorBody>
        {stale && <p role="alert" className="text-xs text-destructive">This routine changed while you were editing. Your text is kept here. Go back and reopen the latest task before saving.</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Field label="Name"><Input aria-label="Name" value={name} onChange={e=>setName(e.target.value)} maxLength={120} disabled={busy}/></Field><Field label="Description"><Input aria-label="Description" value={description} onChange={e=>setDescription(e.target.value)} disabled={busy}/></Field>
        <DesktopScheduleDescription mode={mode} cron={cron} runAt={runAt} timezone={timezone} agentId={agentId} connectionId={pick.connectionId} provider={provider} model={pick.model} disabled={busy} onChange={next=>{setMode(next.mode);setCron(next.cron ?? '');setRunAt(next.runAt ?? '');setTimezone(next.timezone)}}/>
        <Field label="Schedule type"><select aria-label="Schedule type" value={mode} disabled={busy} onChange={e=>setMode(e.target.value as 'cron'|'runAt')}><option value="cron">Recurring</option><option value="runAt">Once</option></select></Field>
        {mode==='cron'?<Field label="Cron expression"><Input aria-label="Cron expression" value={cron} onChange={e=>setCron(e.target.value)} disabled={busy}/></Field>:<Field label="Run at (ISO timestamp with timezone)"><Input aria-label="Run at (ISO timestamp with timezone)" value={runAt} onChange={e=>setRunAt(e.target.value)} placeholder="2026-12-01T08:00:00-06:00" disabled={busy}/></Field>}
        <Field label="Timezone"><TimezoneCombobox value={timezone} onChange={setTimezone}/></Field>
        <p className="text-xs text-muted-foreground">Raw cron and ISO time remain available when schedule parsing is unavailable.</p>
        <RunModelField id="routine-model" value={pick} onChange={setPick} availableGroups={availableGroups} agentModel={modelView?.coworker?.model ?? modelView?.effective.model} disabled={busy} helperText={t('routines.modelHelper')}/>
        {modelError && <p className="text-xs text-destructive">{modelError}</p>}
        {unavailablePin && <p className="text-xs text-muted-foreground">This saved model is no longer offered. Test Run is unavailable; choose another model or Coworker default. Saving does not replace it automatically.</p>}
        <Field orientation="row" label="Enabled"><Switch checked={enabled} disabled={busy} onCheckedChange={setEnabled}/></Field>
        {task?.slug && <DesktopTaskNotifyField agentId={agentId} source="schedule" slug={task.slug} disabled={busy}/>}
        <MarkdownTextarea label="Task prompt" dialogTitle="Edit the task prompt" value={body} onChange={setBody} disabled={busy}/>
        {waitingForSetup && <p className="text-xs text-muted-foreground">{t('routines.editor.setupPendingStart')}</p>}
        {task && !task.revision && <p className="text-xs text-muted-foreground">{t('routines.loadFailed')}</p>}
        {task?.lastResult?.chat && <p className="text-xs">Last result: {task.lastResult.status}</p>}
    </PanelEditorBody><PanelEditorFooter>
        {onDelete && <PanelDeleteButton label="Delete task" busy={busy} disabled={busy || stale || !task?.revision} onClick={()=>perform(onDelete)} confirmDescription="The task stops firing and its schedule is removed. Runs it already produced are kept."/>}
        {onRun && <Button size="sm" variant="outline" title="Run now" disabled={busy || stale || !task?.revision || waitingForSetup || modelChanged || unavailablePin || unverifiedPin || incompletePin} onClick={()=>perform(async()=>{manual.current ??=crypto.randomUUID();await onRun(manual.current);manual.current=null})}>Test Run</Button>}
        <Button size="sm" disabled={busy || stale || !name.trim() || !body.trim() || incompletePin} onClick={()=>perform(()=>onSave({name,description,body,enabled,timezone,cron:mode==='cron'?cron:null,runAt:mode==='runAt'?new Date(runAt).toISOString():null,connectionId:pick.connectionId,provider,model:pick.model}))}>{task?'Save changes':'Create task'}</Button>
    </PanelEditorFooter></PanelEditorShell>
}
