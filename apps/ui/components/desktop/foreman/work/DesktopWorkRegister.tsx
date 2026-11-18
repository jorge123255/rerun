'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    DESKTOP_WORK_ROUTINE_DEFAULT_CRON, DESKTOP_WORK_ROUTINE_NAME, DESKTOP_WORK_ROUTINE_SCOPE_EXAMPLE, DESKTOP_WORK_ROUTINE_SCOPE_LIMIT, DESKTOP_WORK_STATUS_LABELS,
    desktopWorkRegisterViewSchema, desktopWorkRoutineViewSchema, isDesktopWorkOpen,
    type DesktopWorkItem, type DesktopWorkRegisterView, type DesktopWorkRoutineView,
} from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { cn } from '@/lib/utils'

export const DESKTOP_WORK_REGISTER_URL = '/api/desktop/work-register'
export const DESKTOP_WORK_ROUTINE_URL = '/api/desktop/work-register/routine'
const REFRESH_MS = 15_000

const STATUS_TONE: Record<DesktopWorkItem['status'], string> = {
    proposed: 'bg-muted text-muted-foreground', accepted: 'bg-muted text-foreground', working: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
    blocked: 'bg-red-500/15 text-red-700 dark:text-red-300', waiting_approval: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    done: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', dropped: 'bg-muted text-muted-foreground line-through',
}

/** The routine's days and times as the form shows them, or null when the saved cron is something else. */
export function workRoutineForm(cron: string | null): { days: 'weekdays' | 'every'; times: string } | null {
    const match = /^(\d{1,2}) ([\d,]+) \* \* (1-5|\*)$/.exec(cron ?? DESKTOP_WORK_ROUTINE_DEFAULT_CRON)
    if (!match) return null
    const minute = Number(match[1])
    return { days: match[3] === '*' ? 'every' : 'weekdays', times: match[2]!.split(',').map(hour => `${Number(hour)}:${String(minute).padStart(2, '0')}`).join(', ') }
}

/** "9:00, 15:00" on weekdays → "0 9,15 * * 1-5". Times must share their minutes: one routine is one cron. */
export function workRoutineCron(days: 'weekdays' | 'every', times: string): { cron: string } | { error: string } {
    const parsed = times.split(/[,\s]+/).filter(Boolean).map(value => /^(\d{1,2})(?::(\d{2}))?$/.exec(value))
    if (!parsed.length || parsed.some(match => !match || Number(match[1]) > 23 || Number(match[2] ?? 0) > 59)) return { error: 'Write times like 9:00, 15:00.' }
    const minutes = new Set(parsed.map(match => Number(match![2] ?? 0)))
    if (minutes.size > 1) return { error: 'Use times on the same minute, like 9:00 and 15:00.' }
    const hours = [...new Set(parsed.map(match => Number(match![1])))].sort((a, b) => a - b)
    return { cron: `${[...minutes][0]} ${hours.join(',')} * * ${days === 'weekdays' ? '1-5' : '*'}` }
}

const when = (iso: string) => { const at = new Date(iso); return Number.isFinite(at.getTime()) ? at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : iso }

/**
 * The work register as the person reads it, in the Chief of Staff's details panel: what needs them,
 * the team's tasks by project, and the "Coordinate the team" routine. Read only, except closing an
 * item as done or dropped and the routine's own settings.
 */
export function DesktopWorkRegister({ active = true }: { active?: boolean }) {
    const [view, setView] = useState<DesktopWorkRegisterView | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [showClosed, setShowClosed] = useState(false)
    const alive = useRef(true)
    useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    const load = useCallback(async (signal?: AbortSignal) => {
        try {
            const response = await fetch(DESKTOP_WORK_REGISTER_URL, { cache: 'no-store', signal })
            if (!response.ok) throw new Error('unavailable')
            const value = desktopWorkRegisterViewSchema.parse(await response.json())
            if (alive.current) { setView(value); setError(null) }
        } catch { if (alive.current && !signal?.aborted) setError('The work register could not be read.') }
    }, [])
    useEffect(() => {
        if (!active) return
        const controller = new AbortController()
        void load(controller.signal)
        const timer = setInterval(() => { if (!document.hidden) void load(controller.signal) }, REFRESH_MS)
        return () => { controller.abort(); clearInterval(timer) }
    }, [active, load])
    const post = async (key: string, body: unknown) => {
        if (busy || isDesktopQuitting()) return
        setBusy(key)
        try {
            const response = await fetch(DESKTOP_WORK_REGISTER_URL, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
            if (!response.ok) setError(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? 'The change was not saved.')
        } catch { setError('The change was not confirmed. The list shows what is saved.') }
        finally { if (alive.current) setBusy(null); await load() }
    }
    const groups = useMemo(() => {
        const shown = (view?.items ?? []).filter(item => showClosed || isDesktopWorkOpen(item.status))
        const byProject = new Map<string, DesktopWorkItem[]>()
        for (const item of shown) byProject.set(item.project, [...(byProject.get(item.project) ?? []), item])
        return [...byProject.entries()].sort(([a], [b]) => a.localeCompare(b))
    }, [view, showClosed])
    const closed = (view?.items ?? []).filter(item => !isDesktopWorkOpen(item.status)).length

    return <section data-work-register aria-label="Work" className="flex min-h-0 flex-col gap-2 px-4 pb-3">
        <div className="flex items-center justify-between pt-1">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Work</span>
            {closed > 0 && <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setShowClosed(value => !value)}>{showClosed ? 'Hide closed' : `Show closed (${closed})`}</Button>}
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {view?.notices.length ? <ul aria-label="Needs you" className="flex flex-col gap-1.5">
            {view.notices.map(notice => <li key={notice.id} className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs">
                <div className="font-medium">{notice.title}</div>
                <div className="mt-0.5 text-muted-foreground">{notice.body}</div>
                <Button variant="ghost" size="sm" className="mt-1 h-6 px-2 text-xs" disabled={!!busy} onClick={() => void post(`notice:${notice.id}`, { action: 'read-notice', id: notice.id })}>Mark read</Button>
            </li>)}
        </ul> : null}
        {!view && !error && <p role="status" className="text-xs text-muted-foreground">Reading the work register…</p>}
        {view && !groups.length && <p className="text-xs text-muted-foreground">No open work yet. The Chief of Staff and coworkers with the Work register permission add tasks here.</p>}
        {groups.map(([project, items]) => <div key={project} data-work-project={project} className="flex flex-col gap-1">
            <div className="truncate text-xs font-semibold">{project}</div>
            <ul className="flex flex-col gap-1.5">
                {items.map(item => <li key={item.id} data-work-item={item.id} className="rounded-md border border-border px-2.5 py-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                        <span className={cn('min-w-0 font-medium', !isDesktopWorkOpen(item.status) && 'text-muted-foreground')}>{item.objective}</span>
                        <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', STATUS_TONE[item.status])}>{DESKTOP_WORK_STATUS_LABELS[item.status]}</span>
                    </div>
                    <div className="mt-0.5 text-muted-foreground">{item.owner.name}</div>
                    {item.nextAction && <div className="mt-1"><span className="text-muted-foreground">Next: </span>{item.nextAction}</div>}
                    {item.blockers && <div className="mt-1 text-red-700 dark:text-red-300"><span className="font-medium">Blocked: </span>{item.blockers}</div>}
                    {item.approval && <div className="mt-1 text-amber-700 dark:text-amber-300"><span className="font-medium">Needs your approval: </span>{item.approval.required}</div>}
                    {item.latestUpdate && <div className="mt-1 text-muted-foreground">{item.latestUpdate.text} · {item.latestUpdate.by}, {when(item.latestUpdate.at)}</div>}
                    {isDesktopWorkOpen(item.status) && <div className="mt-1 flex gap-1">
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={!!busy} onClick={() => void post(`close:${item.id}`, { action: 'close', id: item.id, expectedRevision: item.revision, status: 'done' })}>Mark done</Button>
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={!!busy} onClick={() => void post(`drop:${item.id}`, { action: 'close', id: item.id, expectedRevision: item.revision, status: 'dropped' })}>Drop</Button>
                    </div>}
                </li>)}
            </ul>
        </div>)}
        <DesktopWorkRoutineCard active={active} />
    </section>
}

/** "Coordinate the team": off until the person switches it on, with their days, times, scope and summary choice. */
export function DesktopWorkRoutineCard({ active = true }: { active?: boolean }) {
    const [routine, setRoutine] = useState<DesktopWorkRoutineView | null>(null)
    const [form, setForm] = useState<{ enabled: boolean; days: 'weekdays' | 'every'; times: string; cron: string | null; scope: string; summaries: boolean } | null>(null)
    const [message, setMessage] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const adopt = useCallback((value: DesktopWorkRoutineView) => {
        setRoutine(value)
        const parsed = workRoutineForm(value.cron)
        setForm({ enabled: value.enabled, days: parsed?.days ?? 'weekdays', times: parsed?.times ?? '9:00, 15:00', cron: parsed ? null : value.cron, scope: value.scope, summaries: value.summaries })
    }, [])
    useEffect(() => {
        if (!active) return
        const controller = new AbortController()
        void fetch(DESKTOP_WORK_ROUTINE_URL, { cache: 'no-store', signal: controller.signal })
            .then(async response => { if (!response.ok) throw new Error('unavailable'); adopt(desktopWorkRoutineViewSchema.parse(await response.json())) })
            .catch(() => { if (!controller.signal.aborted) setMessage('The routine could not be read.') })
        return () => controller.abort()
    }, [active, adopt])
    const send = async (body: unknown) => {
        setBusy(true); setMessage(null)
        try {
            const response = await fetch(DESKTOP_WORK_ROUTINE_URL, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
            const value = await response.json().catch(() => null) as { error?: string } | null
            if (!response.ok) { setMessage(value?.error ?? 'Not saved.'); return null }
            return value
        } catch { setMessage('Not confirmed. Reopen the panel to see what is saved.'); return null }
        finally { setBusy(false) }
    }
    if (!form) return <div className="rounded-md border border-border px-2.5 py-2 text-xs text-muted-foreground">{message ?? `${DESKTOP_WORK_ROUTINE_NAME}…`}</div>
    const save = async () => {
        const timing = form.cron ? { cron: form.cron } : workRoutineCron(form.days, form.times)
        if ('error' in timing) { setMessage(timing.error); return }
        const value = await send({ action: 'save', enabled: form.enabled, cron: timing.cron, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, scope: form.scope, summaries: form.summaries })
        if (!value) return
        const saved = desktopWorkRoutineViewSchema.safeParse(value)
        if (saved.success) { adopt(saved.data); setMessage('Saved.') } else setMessage('Not confirmed. Reopen the panel to see what is saved.')
    }
    const runNow = async () => {
        const value = await send({ action: 'run', requestId: crypto.randomUUID() }) as { chatId?: string } | null
        if (value?.chatId) setMessage('Started a test run in a new Chief of Staff conversation.')
    }
    return <div data-work-routine className="flex flex-col gap-2 rounded-md border border-border px-2.5 py-2 text-xs">
        <label className="flex items-center justify-between gap-2">
            <span className="font-medium">{DESKTOP_WORK_ROUTINE_NAME}</span>
            <Switch aria-label={DESKTOP_WORK_ROUTINE_NAME} checked={form.enabled} disabled={busy} onCheckedChange={(enabled: boolean) => setForm({ ...form, enabled })} />
        </label>
        <p className="text-muted-foreground">The Chief of Staff reads the register, asks coworkers how their work stands, records it, and hands out next steps inside your scope. Anything outside it waits for your approval.</p>
        {form.cron
            ? <label className="flex flex-col gap-1"><span className="text-muted-foreground">Schedule (cron)</span><Input value={form.cron} disabled={busy} onChange={event => setForm({ ...form, cron: event.target.value })} /></label>
            : <div className="flex flex-wrap items-center gap-2">
                <select aria-label="Days" className="rounded border border-border bg-background px-1.5 py-1" value={form.days} disabled={busy} onChange={event => setForm({ ...form, days: event.target.value as 'weekdays' | 'every' })}>
                    <option value="weekdays">Weekdays</option><option value="every">Every day</option>
                </select>
                <span className="text-muted-foreground">at</span>
                <Input aria-label="Times" className="h-7 w-32 text-xs" value={form.times} disabled={busy} onChange={event => setForm({ ...form, times: event.target.value })} />
            </div>}
        <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Your agreed scope: what it may hand out without asking you</span>
            <textarea aria-label="Agreed scope" className="min-h-16 rounded border border-border bg-background px-2 py-1" maxLength={DESKTOP_WORK_ROUTINE_SCOPE_LIMIT} placeholder={DESKTOP_WORK_ROUTINE_SCOPE_EXAMPLE} value={form.scope} disabled={busy} onChange={event => setForm({ ...form, scope: event.target.value })} />
        </label>
        <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.summaries} disabled={busy} onChange={event => setForm({ ...form, summaries: event.target.checked })} />
            <span>Send me a short summary after each run</span>
        </label>
        <div className="flex items-center gap-1">
            <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void save()}>Save</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => void runNow()}>Run now</Button>
        </div>
        {routine?.enabled && routine.nextRunAt && <p className="text-muted-foreground">Next run {when(routine.nextRunAt)}.</p>}
        {routine?.lastRun && <p className="text-muted-foreground">Last {routine.lastRun.test ? 'test ' : ''}run {when(routine.lastRun.at)}{routine.lastRun.state === 'failed' ? ': it could not start.' : '.'}</p>}
        {message && <p role="status" className="text-muted-foreground">{message}</p>}
    </div>
}
