'use client'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { EngineSchedule } from '@/lib/engine/types'
import type { DesktopWorkspaceRoutineChat } from '@rerun/contracts'
import { formatDate } from '@rerun/i18n/format'
import { ScheduleRequestError, scheduleRequest } from '@/lib/desktop/schedules/client'
import { DesktopScheduleHistory } from './DesktopScheduleHistory'
import type { ConnectionGroup } from '@/lib/engine/model-groups'
import { desktopModelViewSchema, type DesktopModelView } from '@/lib/desktop/chat-model'
import { desktopProvider } from '@/lib/desktop/settings'
import { RunModelField, type RunModelPick } from '@/components/agent/RunModelField'
import { DesktopScheduleDescription } from './DesktopScheduleDescription'
import { desktopScheduleInstant, desktopScheduleSummary } from '@/lib/desktop/schedule-description'
import { desktopLocaleTag } from '@/lib/desktop/locale'
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
import { Badge } from '@rerun/ui/primitives'
import type { DesktopScheduleInput } from '@/lib/desktop/server/schedules/api'
import { useDesktopScheduleToolNotices } from '@/lib/desktop/use-schedule-tool-notices'
import { DesktopScheduleToolNotice } from '../schedule-tools/DesktopScheduleToolNotice'
import { DesktopTaskNotifyField } from '../DesktopTaskNotifyField'
import { useDesktopLocale } from '../DesktopLocale'

type Chat = DesktopWorkspaceRoutineChat
type Task=EngineSchedule & {setupPending:boolean;nextRunAt:string|null;lastResult:{status:string;runId:string;chat:Chat}|null}
function resultLabel(status: string | undefined, t: ReturnType<typeof useDesktopLocale>['t']) {
    if (!status) return t('routines.coworker.notRun')
    if (status === 'running' || status === 'done' || status === 'error' || status === 'cancelled') return t(`routines.status.${status}`)
    return status
}

export function DesktopCoworkerSchedules(props:{agentId:string;onOpenSession:(chat:Chat)=>void}) {return <Schedules key={props.agentId} {...props}/>}
function Schedules({agentId,onOpenSession}:{agentId:string;onOpenSession:(chat:Chat)=>void}) {
    const { t, language } = useDesktopLocale()
    const locale = desktopLocaleTag(language.locale)
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
            if(alive.current && own===listEpoch.current)setError(error instanceof ScheduleRequestError ? error.message : t('routines.coworker.loadFailed'))
        } finally {
            if(alive.current && own===listEpoch.current)setLoading(false)
        }
    },[request, t])
    useEffect(()=>{void load()},[load])
    const notice=useDesktopScheduleToolNotices(agentId,()=>{if(editing)setExternalChange(true);void load()})
    function navigate(task:Task|'new'|null){epoch.current++;setEditing(task);setExternalChange(false)}
    async function change(method:string,body:unknown){const own=epoch.current;listEpoch.current++;await request(method,body);if(alive.current && own===epoch.current){navigate(null);await load()}}
    const newButton=<Button size="sm" variant="outline" disabled={loading || Boolean(error) || tasks===null} onClick={()=>{if(!loading && !error && tasks!==null)navigate('new')}}><PlusIcon className="size-3.5 mr-1"/>{t('routines.coworker.newTask')}</Button>
    return <PanelSteps stepKey={editing ? 'editor' : 'list'} depth={editing ? 1 : 0}>{editing ?
        <ScheduleEditor stale={externalChange} key={editing==='new'?'new':editing.slug} agentId={agentId} task={editing==='new'?undefined:editing} onBack={()=>navigate(null)} onOpenSession={onOpenSession}
            onSave={input=>change('PUT',{slug:editing==='new'?undefined:editing.slug,input})}
            onDelete={editing==='new'?undefined:()=>change('DELETE',{slug:editing.slug,expectedRevision:editing.revision})}
            onRun={editing==='new'?undefined:async requestId=>{const own=epoch.current;const chat=await request('POST',{slug:editing.slug,action:'run',requestId,expectedRevision:editing.revision});if(alive.current && own===epoch.current){onOpenSession(chat);await load()}}}/> :
        <div className="flex flex-col h-full">
            {notice && <div className="px-3 pt-2 text-xs"><DesktopScheduleToolNotice outcome="committed" text={t('routines.coworker.toolChanged', { slug: notice.slug })} /></div>}
            <PanelListHeader>
                {tasks !== null && !loading && !error && <p className="text-xs text-muted-foreground">{t('routines.coworker.count', { count: tasks.length })}</p>}
                {newButton}
            </PanelListHeader>
            {error && <p role="alert" className="p-3 text-xs text-destructive">{error}</p>}
            {loading && !error && <FxSchedulesLoading label={t('routines.coworker.loading')} />}
            {error && tasks !== null && tasks.length > 0 && <p className="px-3 pt-2 text-xs text-muted-foreground">{t('routines.coworker.previous')}</p>}
            {!loading && !error && tasks?.length === 0 && <EmptyState icon={CalendarClockIcon} title={t('routines.coworker.emptyTitle')} description={t('routines.coworker.emptyDescription')} />}
            {tasks && tasks.length > 0 && <PanelScroller><PanelList>{tasks.map(task => <div key={task.slug}>
                <PanelRow onClick={() => navigate(task)} title={task.name} description={desktopScheduleSummary(task, t, locale)}
                    meta={!task.enabled ? <Badge size="xs" tone="neutral" glow={false}>{t('routines.coworker.paused')}</Badge> : undefined}
                    footer={<span>{t('routines.coworker.nextRun', { date: task.nextRunAt ? formatDate(task.nextRunAt, locale) : '—' })} · {t('routines.lastResult', { status: resultLabel(task.lastResult?.status, t) })}</span>} />
                {task.lastResult?.chat && <Button size="sm" variant="ghost" onClick={() => onOpenSession(task.lastResult!.chat)}>{t('routines.openResult')}</Button>}
            </div>)}</PanelList></PanelScroller>}
            <p className="p-3 text-xs text-muted-foreground">{t('routines.coworker.scheduleHelp')}</p>
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>{t('routines.coworker.reload')}</Button>
        </div>}</PanelSteps>
}
function ScheduleEditor({agentId,task,onBack,onSave,onDelete,onRun,onOpenSession,stale=false}:{stale?:boolean;agentId:string;task?:Task;onBack:()=>void;onSave:(input:DesktopScheduleInput)=>Promise<void>;onDelete?:()=>Promise<void>;onRun?:(requestId:string)=>Promise<void>;onOpenSession:(chat:Chat)=>void}) {
    const { t } = useDesktopLocale()
    const runAtId = useId()
    const modelFieldId = useId()
    const [name,setName]=useState(task?.name ?? ''),[description,setDescription]=useState(task?.description ?? ''),[body,setBody]=useState(task?.body ?? '')
    const [mode,setMode]=useState<'cron'|'runAt'>(task?.runAt ? 'runAt' : 'cron'),[cron,setCron]=useState(task?.cron ?? '0 8 * * *'),[runAt,setRunAt]=useState(task?.runAt ?? '')
    const instant = mode === 'runAt' ? desktopScheduleInstant(runAt) : null
    const timeError = mode === 'runAt' && runAt.trim() && !instant ? t('routines.invalidRunAt') : undefined
    const canSaveTime = mode === 'cron' ? !!cron.trim() : !!instant
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
        }).catch(()=>{if(alive.current&&!controller.signal.aborted)setModelError(t('routines.modelsLoadFailed'))})
        return()=>controller.abort()
    },[agentId, t])
    const availableGroups=useMemo<ConnectionGroup[]>(()=>modelView?.catalog.map(group=>({connectionId:group.connectionId,label:group.name,provider:group.provider,models:group.models,defaultModel:group.models[0]?.id ?? '',planWindows:[]})) ?? [],[modelView])
    const savedProvider=task?.provider?desktopProvider.safeParse(task.provider):null
    const preservedProvider=pick.connectionId===task?.connectionId&&pick.model===task?.model&&savedProvider?.success?savedProvider.data:null
    const provider=pick.model?modelView?.catalog.find(group=>group.connectionId===pick.connectionId)?.provider ?? preservedProvider:null
    const unavailablePin=!!pick.model&&!!modelView&&!availableGroups.some(group=>group.connectionId===pick.connectionId&&group.models.some(model=>model.id===pick.model))
    const unverifiedPin=!!pick.model&&!modelView
    const incompletePin=!!pick.model&&(!pick.connectionId||!provider)
    const waitingForSetup = task?.setupPending === true && !task.enabled
    const modelChanged = Boolean(task && (pick.connectionId !== task.connectionId || pick.model !== task.model || provider !== task.provider))
    async function perform(action:()=>Promise<void>){if(stale || pending.current)return;pending.current=true;setBusy(true);setError('');try{await action()}catch(e){if(alive.current)setError(e instanceof Error?e.message:t('routines.requestFailed'))}finally{pending.current=false;if(alive.current)setBusy(false)}}
    if (historyOpen && task) return <DesktopScheduleHistory agentId={agentId} slug={task.slug} title={task.name} onBack={() => setHistoryOpen(false)} onOpenChat={onOpenSession} />
    return <PanelEditorShell><PanelEditorHeader title={t(task ? 'routines.editor.titleEdit' : 'routines.editor.titleNew')} backLabel={t('routines.back')} onBack={busy?undefined:()=>{if(!pending.current)onBack()}}>
        {task && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (!pending.current) setHistoryOpen(true) }}>{t('routines.editor.history')}</Button>}
    </PanelEditorHeader><PanelEditorBody>
        {stale && <p role="alert" className="text-xs text-destructive">{t('routines.coworker.conflict')}</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Field label={t('routines.editor.name')}><Input aria-label={t('routines.editor.name')} value={name} onChange={e=>setName(e.target.value)} maxLength={120} disabled={busy}/></Field><Field label={t('routines.editor.description')}><Input aria-label={t('routines.editor.description')} value={description} onChange={e=>setDescription(e.target.value)} disabled={busy}/></Field>
        <DesktopScheduleDescription mode={mode} cron={cron} runAt={runAt} timezone={timezone} agentId={agentId} connectionId={pick.connectionId} provider={provider} model={pick.model} disabled={busy} onChange={next=>{setMode(next.mode);setCron(next.cron ?? '');setRunAt(next.runAt ?? '');setTimezone(next.timezone)}}/>
        <Field label={t('routines.scheduleType')}><select aria-label={t('routines.scheduleType')} value={mode} disabled={busy} onChange={e=>setMode(e.target.value as 'cron'|'runAt')}><option value="cron">{t('routines.recurring')}</option><option value="runAt">{t('routines.once')}</option></select></Field>
        {mode === 'cron'
            ? <Field label={t('routines.cron')}><Input aria-label={t('routines.cron')} value={cron} onChange={e => setCron(e.target.value)} disabled={busy} /></Field>
            : <Field label={t('routines.runAt')} htmlFor={runAtId}>
                <Input id={runAtId} aria-label={t('routines.runAt')} value={runAt} onChange={e => setRunAt(e.target.value)} placeholder="2026-12-01T08:00:00-06:00" disabled={busy}
                    aria-invalid={timeError ? true : undefined} aria-describedby={timeError ? runAtId + '-error' : undefined} />
                {timeError && <p id={runAtId + '-error'} className="text-xs text-destructive">{timeError}</p>}
            </Field>}
        <Field label={t('routines.editor.timezone')}><TimezoneCombobox value={timezone} onChange={setTimezone}
            placeholder={t('routines.timezone.placeholder')} searchPlaceholder={t('routines.timezone.search')} emptyLabel={t('routines.timezone.empty')} /></Field>
        <p className="text-xs text-muted-foreground">{t('routines.rawHelp')}</p>
        <RunModelField id={modelFieldId} value={pick} onChange={setPick} availableGroups={availableGroups} agentModel={modelView?.coworker?.model ?? modelView?.effective.model} disabled={busy} helperText={t('routines.modelHelper')} labels={{
            label: t('routines.modelField.label'),
            placeholder: t('routines.modelField.placeholder'),
            coworkerDefault: t('routines.modelField.coworkerDefault'),
            coworkerDefaultWithModel: model => t('routines.modelField.coworkerDefaultWithModel', { model }),
            current: t('routines.modelField.current'),
        }} />
        {modelError && <p className="text-xs text-destructive">{modelError}</p>}
        {unavailablePin && <p className="text-xs text-muted-foreground">{t('routines.modelUnavailable')}</p>}
        <Field orientation="row" label={t('routines.editor.enabled')}><Switch checked={enabled} disabled={busy} onCheckedChange={setEnabled}/></Field>
        {task?.slug && <DesktopTaskNotifyField agentId={agentId} source="schedule" slug={task.slug} disabled={busy}/>}
        <MarkdownTextarea label={t('routines.editor.prompt')} dialogTitle={t('routines.editor.promptDialogTitle')} value={body} onChange={setBody} disabled={busy}/>
        {waitingForSetup && <p className="text-xs text-muted-foreground">{t('routines.editor.setupPendingStart')}</p>}
        {task && !task.revision && <p className="text-xs text-muted-foreground">{t('routines.loadFailed')}</p>}
        {task?.lastResult?.chat && <p className="text-xs">{t('routines.lastResult', { status: resultLabel(task.lastResult.status, t) })}</p>}
    </PanelEditorBody><PanelEditorFooter>
        {onDelete && task && <PanelDeleteButton label={t('routines.editor.delete')} busy={busy} disabled={busy || stale || !task?.revision} onClick={()=>perform(onDelete)} confirmTitle={t('routines.editor.deleteConfirm', { name: task.name })}
            confirmDescription={t('routines.editor.deleteDescription')} confirmLabel={t('routines.editor.delete')} cancelLabel={t('cancel')}/>}
        {onRun && <Button size="sm" variant="outline" title={t('routines.runNow')} disabled={busy || stale || !task?.revision || waitingForSetup || modelChanged || unavailablePin || unverifiedPin || incompletePin} onClick={()=>perform(async()=>{manual.current ??=crypto.randomUUID();await onRun(manual.current);manual.current=null})}>{t('routines.editor.testRun')}</Button>}
        <Button size="sm" disabled={busy || stale || !name.trim() || !body.trim() || incompletePin || !canSaveTime} onClick={()=>perform(()=>onSave({name,description,body,enabled,timezone,cron:mode==='cron'?cron.trim():null,runAt:instant,connectionId:pick.connectionId,provider,model:pick.model}))}>{t(task ? 'routines.editor.saveChanges' : 'routines.editor.create')}</Button>
    </PanelEditorFooter></PanelEditorShell>
}
