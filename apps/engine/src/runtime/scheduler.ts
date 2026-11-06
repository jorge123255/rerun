import { assertDesktopRunAdmission } from '../desktop/workspace-admission.js'
import { automationModel } from '../agents/availability.js'
import { listAgentIdsOnDisk } from '../agents/loader.js'
import { getAgent } from '../agents/registry.js'
import { createSession } from '../db/repos/sessions.js'
import { listSchedules, readSchedule, consumeDesktopSchedule, markFired, type Schedule } from '../schedules/loader.js'
import { buildScheduledRunMessage } from '../schedules/message.js'
import { isDue } from '../schedules/cron.js'
import { sweepMemoriesIfDue } from '../memory/maintenance.js'
import { maintainBrainIfDue } from '../brain/maintenance.js'
import { sweepCodexHomesIfDue } from '../connections/codex-sweep.js'
import { startHeadlessRun } from './headless-run.js'
import { sendNotification } from './notify.js'
import { isBudgetLatched } from './budget-latch.js'
import { nowIso } from '../lib/ids.js'
import { agentDisabled, budgetExhausted, HttpError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

import { desktopApp, assertDesktopProvider } from '../desktop/policy.js'
import { claimDesktopSchedule, recordDesktopSchedule, finishDesktopSchedule, replayDesktopSchedule } from './desktop-schedule-state.js'

type DesktopScheduleHooks = {
    /** Read CURRENT coworker identity, enabled state and explicit schedule grant; throw if unavailable. */
    authorize: (agentId:string) => Promise<void>
    /** Durable desktop adoption; must validate exact engine/local owner. */
    adopt: (agentId:string,sessionId:string,runId:string|null,title:string) => Promise<void>
}
let desktopHooks:DesktopScheduleHooks|undefined
export function configureDesktopSchedules(hooks:DesktopScheduleHooks) {desktopHooks=hooks}
let generation=0
let stopped=false
const preparing=new Set<Promise<unknown>>()
export async function stopScheduledAdmissions():Promise<void> {
    stopped=true;generation++
    await Promise.allSettled([...preparing])
}
type FireOptions={markFired?:boolean;ignoreBudgetLatch?:boolean;manualId?:string;assertActive?:()=>void}
const TICK_MS = 30_000

const inFlight = new Map<string, Promise<{ runId: string; sessionId: string }>>()

export function fireSchedule(agentId: string, schedule: Schedule, opts?: FireOptions): Promise<{ runId: string; sessionId: string }> {
    let admission: number
    try { admission = assertDesktopRunAdmission() } catch (error) { return Promise.reject(error) }
    const key = `${agentId}/${schedule.slug}`
    if(stopped)return Promise.reject(new Error('Scheduler stopped'))
    const existing = inFlight.get(key)
    if (existing) {
        if (!desktopApp()) return existing
        const epoch=generation
        const check=()=>{assertDesktopRunAdmission(admission);if(stopped || generation!==epoch)throw new Error('Scheduler stopped');opts?.assertActive?.()}
        const replay=async()=>{
            check()
            if(opts?.markFired===false && opts.manualId) {
                if(!desktopHooks)throw new Error('Desktop schedule integration unavailable')
                await desktopHooks.authorize(agentId);check()
                const receipt=await replayDesktopSchedule(agentId,schedule.slug,opts.manualId);check()
                await desktopHooks.authorize(agentId);check()
                if(receipt)return receipt
            }
            throw new Error('Task already active under another occurrence')
        }
        const pending=existing.then(replay,replay)
        preparing.add(pending)
        void pending.finally(()=>preparing.delete(pending)).catch(()=>{})
        return pending
    }

    // Admission is reserved before the first await, so a manual run and a due run arriving together
    // queue on the same in-flight launch instead of both racing past this check mid-preparation.
    const epoch=generation
    const assertActive=()=>{assertDesktopRunAdmission(admission);if(stopped || generation!==epoch)throw new Error('Scheduler stopped');opts?.assertActive?.()}
    // Defer preparation until AFTER the reservation, including synchronous/mocked dependency paths.
    const started = Promise.resolve().then(()=>launchScheduledRun(agentId, schedule, key, {...opts,assertActive}))
    preparing.add(started)
    void started.finally(()=>preparing.delete(started)).catch(()=>{})
    inFlight.set(key, started)
    return started
}

async function launchScheduledRun(agentId: string, schedule: Schedule, key: string, opts?: FireOptions): Promise<{ runId: string; sessionId: string }> {
    let claimed=false, launched=false
    const manualId=opts?.markFired===false ? opts.manualId : undefined
    try {
        const check=()=>opts?.assertActive?.()
        const authorize=async()=>{
            check()
            if(desktopApp()) {
                if(!desktopHooks)throw new Error('Desktop schedule integration unavailable')
                await desktopHooks.authorize(agentId);check()
            }
        }
        check();await authorize()
        if(desktopApp() && manualId) {
            const replay=await replayDesktopSchedule(agentId,schedule.slug,manualId);check();await authorize();check()
            if(replay){inFlight.delete(key);return replay}
        }
        // Never trust a stale object passed by a tick or Run now request.
        schedule = await readSchedule(agentId,schedule.slug);check()
        if(desktopApp() && !schedule.enabled)throw new Error('Task is paused')
        if(desktopApp() && opts?.markFired!==false && !isDue(schedule,new Date()))throw new Error('Task is no longer due')
        const agent = await getAgent(agentId);check()
        if (!agent.config.enabled) throw agentDisabled()
        // Resolved before markFired so a budget skip leaves the schedule due: it resumes on the first
        // tick after the latch clears, with no session, no run and no notification in the meantime.
        // Only the managed provider burns the workspace budget, so an agent on its own key still fires.
        const override = await automationModel(agent, desktopApp() ? {...schedule,connectionId:null,provider:null,model:null} : schedule, 'schedule');check()
        if(desktopApp())assertDesktopProvider(override.provider ?? agent.resolved.provider,override.connectionId ?? agent.resolved.connection?.id)
        await authorize();check()
        const latest=await readSchedule(agentId,schedule.slug);check()
        if(JSON.stringify(latest)!==JSON.stringify(schedule))throw new Error('Task changed during preparation')
        if (!opts?.ignoreBudgetLatch && override.provider === 'rerun' && isBudgetLatched()) throw budgetExhausted()
        if(desktopApp()) {
            if(opts?.markFired===false && !manualId)throw new Error('Manual occurrence identity required')
            if(!await claimDesktopSchedule(agentId,schedule,manualId)) {
                // A crash can consume a durable claim before its file stamp. Skip that baseline,
                // advance to now, and let future intervals remain eligible without replaying it.
                check()
                if(opts?.markFired!==false) {await consumeDesktopSchedule(agentId,schedule,nowIso());check()}
                throw new Error('Occurrence already claimed or task already active')
            }
            claimed=true
        }
        check()
        // Stamped before the launch, not after: a schedule whose run preparation keeps throwing would
        // otherwise stay due forever and re-fire on every 30s tick. The trade-off is at-most-once — a
        // crash mid-run costs that occurrence instead of replaying work that may already be done.
        let expectedSchedule=schedule
        if (opts?.markFired !== false) {
            if(desktopApp()) expectedSchedule=await consumeDesktopSchedule(agentId,schedule,nowIso())
            else {await markFired(agentId,schedule.slug,nowIso());expectedSchedule=await readSchedule(agentId,schedule.slug)}
        }
        check();await authorize();check()
        const session = await createSession(agentId, `schedule: ${schedule.slug}`, undefined, 'schedule')
        check()
        if(desktopApp()) {await desktopHooks!.adopt(agentId,session.id,null,schedule.name);check()}
        await sendNotification({
            event: 'agent.session.created',
            kind: 'info',
            agentId,
            sessionId: session.id,
            runId: null,
            message: `Scheduled run: ${schedule.name}`,
            title: schedule.name,
            source: 'schedule',
        })
        check();await authorize();check()
        const beforeLaunch=async()=>{
            check();await authorize();check()
            const [current,currentAgent]=await Promise.all([readSchedule(agentId,schedule.slug),getAgent(agentId)]);check()
            if(!currentAgent.config.enabled)throw agentDisabled()
            if(JSON.stringify(current)!==JSON.stringify(expectedSchedule) || JSON.stringify(currentAgent.config)!==JSON.stringify(agent.config))throw new Error('Task or coworker changed during preparation')
        }
        await beforeLaunch();check()
        const { runId, settled } = await startHeadlessRun(agent, session.id, buildScheduledRunMessage(schedule), override, { source: 'schedule', slug: schedule.slug, name: schedule.name }, {beforeLaunch,assertActive:check})

        launched=true
        // Install settlement tracking BEFORE post-launch callbacks, so failures cannot strand admission.
        void settled.then(outcome => {
            if (outcome.kind === 'error') logger.error({ agent: agentId, schedule: schedule.slug, err: String(outcome.error) }, 'scheduled run failed')
        }).finally(async () => {
            try { if (desktopApp()) await finishDesktopSchedule(agentId, schedule, manualId) }
            finally { inFlight.delete(key) }
        }).catch(error => logger.error({ agent: agentId, schedule: schedule.slug, err: String(error) }, 'schedule settlement persistence failed'))
        check()
        if(desktopApp()) {await recordDesktopSchedule(agentId,schedule,manualId,session.id,runId);check();await desktopHooks!.adopt(agentId,session.id,runId,schedule.name);check()}
        const startedRun = { runId, sessionId: session.id }
        logger.info({ agent: agentId, schedule: schedule.slug, runId, session: session.id }, 'scheduled run fired')

        return startedRun
    } catch (err) {
        if(!launched) {
            if(claimed)await finishDesktopSchedule(agentId,schedule,manualId)
            inFlight.delete(key)
        }
        throw err
    }
}

async function fire(agentId: string, schedule: Schedule, assertActive:()=>void): Promise<void> {
    try {
        await fireSchedule(agentId, schedule,{assertActive})
    } catch (err) {
        if (err instanceof HttpError && err.status === 402) {
            logger.debug({ agent: agentId, schedule: schedule.slug }, 'scheduled run skipped: rerun budget latched')
            return
        }
        logger.error({ agent: agentId, schedule: schedule.slug, err: String(err) }, 'scheduled run failed')
    }
}

async function tick(assertActive:()=>void): Promise<void> {
    assertActive()
    const now = new Date()
    let agentIds: string[]
    try {
        agentIds = await listAgentIdsOnDisk()
    } catch (err) {
        logger.error({ err: String(err) }, 'scheduler tick failed to list agents')
        return
    }
    assertActive()
    // Desktop activates only the user's explicit Routines. Hosted maintenance has
    // separate credentials, lifecycle and permissions and is not part of that grant.
    if (!desktopApp()) {
        void sweepMemoriesIfDue(agentIds)
        void maintainBrainIfDue()
        void sweepCodexHomesIfDue()
    }
    for (const agentId of agentIds) {
        // A switched-off agent normally has its schedules paused too, so this only catches the
        // case where the host could not reach the box at the time. Skipping here rather than
        // letting fireSchedule throw keeps the tick from logging an error every 30 seconds.
        const agent = await getAgent(agentId).catch(() => null)
        assertActive()
        if (!agent?.config.enabled) continue

        let schedules: Schedule[]
        try {
            schedules = await listSchedules(agentId)
        } catch (err) {
            logger.error({ agent: agentId, err: String(err) }, 'scheduler failed to load schedules')
            continue
        }
        assertActive()
        for (const schedule of schedules) {
            if (isDue(schedule, now)) void fire(agentId, schedule,assertActive)
        }
    }
}

export function startScheduler(): (()=>void) & {drain:()=>Promise<void>} {
    stopped=false
    const epoch=++generation
    let closed=false
    const assertActive=()=>{if(closed || stopped || generation!==epoch)throw new Error('Scheduler stopped')}
    const ticks=new Set<Promise<void>>()
    const run=()=>{
        if(closed)return
        const pending=tick(assertActive).catch(error=>{if(!closed)logger.error({err:String(error)},'scheduler tick failed')})
        ticks.add(pending);void pending.finally(()=>ticks.delete(pending))
    }
    run()
    const timer=setInterval(run,TICK_MS)
    const stop=()=>{if(closed)return;closed=true;clearInterval(timer);stopped=true;generation++}
    return Object.assign(stop,{drain:async()=>{stop();await Promise.allSettled([...ticks]);await stopScheduledAdmissions()}})
}
