'use client'

import { Orb } from '@rerun/ui/foreman'
import { Composer, fall, Floor, type FloorLight, OrbLight, useFollow, useJobReading, type JobReader, type JobReading } from '@rerun/ui/new-agent'
import { DESCRIBED } from '@rerun/ui/new-agent/schedule'
import { AGENT_NAME_MAX, EMPTY_READING } from '@rerun/ui/new-agent/reading'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
    DESKTOP_DESCRIPTION_MAX, DESKTOP_NEW_AGENT_CAPABILITIES, IDLE_CREATION, createDesktopJobReader,
    requestDesktopCreation, settleDesktopCreation, type DesktopCreateOutcome, type DesktopCreateState,
    type DesktopCreationInput, type DesktopCreationIntent, type DesktopNewAgentCapabilities,
} from '@/lib/desktop/new-agent'
import { useEffect, useMemo, useRef, useState } from 'react'

const ORB_SIZE = 56
const SETTLE_MS = 2500

function settled(reading: Promise<JobReading>, fallback: JobReading, signal: AbortSignal): Promise<JobReading> {
    return new Promise(resolve => {
        let finished = false
        const finish = (value: JobReading) => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            signal.removeEventListener('abort', cancel)
            resolve(value)
        }
        const cancel = () => finish(EMPTY_READING)
        const timer = setTimeout(() => finish(fallback), SETTLE_MS)
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
        void reading.then(finish, () => finish(fallback))
    })
}

// Keep the original Orb, lighting and composer rather than inventing a second creation layout.
const FADE = 'radial-gradient(ellipse 820px 520px at 50% calc(50% + 240px), #000 0%, rgba(0,0,0,0.6) 50%, transparent 100%)'
function floorLight(focused: boolean): FloorLight {
    const source = 'calc(50% + var(--orb-x, 0px)) calc(50% + var(--orb-y, 0px))'
    return {
        masks: [fall(focused ? 60 : 80, source), `radial-gradient(760px 440px at ${source}, #000, rgba(0,0,0,0.55) 35%, rgba(0,0,0,0.18) 70%, transparent)`],
        light: 'rgb(104 80 252 / 0.2)', dark: 'rgb(200 190 255 / 0.18)',
    }
}
const UNCERTAIN = 'We could not confirm whether your coworker was created. Trying again checks the same attempt; it does not create a second one.'
type Submission = { generation: number; controller: AbortController; admitted: boolean }
type Prepare = (signal: AbortSignal) => Promise<DesktopCreationInput>

/** Emits one intent. Root owns durable placement, creation and kickoff receipts. */
export function DesktopNewAgentDialog({ open, onOpenChange, onCreate, read, capabilities = DESKTOP_NEW_AGENT_CAPABILITIES, first = false, resumeIntent = null, resolvingReceipt = false }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onCreate: (intent: DesktopCreationIntent) => Promise<DesktopCreateOutcome>
    read?: JobReader
    capabilities?: DesktopNewAgentCapabilities
    first?: boolean
    /** Root's unresolved durable receipt, including after a full process restart. */
    resumeIntent?: DesktopCreationIntent | null
    /** Keep admission closed until root has loaded/reconciled that durable receipt. */
    resolvingReceipt?: boolean
}) {
    const [create, setCreate] = useState<DesktopCreateState>(IDLE_CREATION)
    const [preparing, setPreparing] = useState(false)
    const [failure, setFailure] = useState<string | null>(null)
    const [completedGeneration, setCompletedGeneration] = useState<number | null>(null)
    const submission = useRef<Submission | null>(null)
    const settledReceipt = useRef<string | null>(null)
    const admission = useRef({ resolvingReceipt, resumeId: resumeIntent?.requestId })
    admission.current = { resolvingReceipt, resumeId: resumeIntent?.requestId }
    const lifetime = useRef({ mounted: true, open, generation: 0 })
    if (lifetime.current.open !== open) {
        lifetime.current.open = open
        lifetime.current.generation++
    }
    const generation = lifetime.current.generation
    const creation: DesktopCreateState = create.status === 'idle' && resumeIntent && settledReceipt.current !== resumeIntent.requestId
        ? { status: 'uncertain', intent: resumeIntent, error: '' } : create

    useEffect(() => {
        lifetime.current.mounted = true
        return () => { lifetime.current.mounted = false; submission.current?.controller.abort() }
    }, [])
    useEffect(() => {
        setFailure(null)
        if (!open && submission.current && !submission.current.admitted) {
            submission.current.controller.abort()
            submission.current = null
            setPreparing(false)
        }
    }, [open])

    const current = (token: Submission) => lifetime.current.mounted && lifetime.current.open && lifetime.current.generation === token.generation
    function changeOpen(next: boolean) {
        if (!next) {
            lifetime.current.generation++
            if (submission.current && !submission.current.admitted) {
                submission.current.controller.abort()
                submission.current = null
                setPreparing(false)
            }
        }
        onOpenChange(next)
    }

    async function submit(prepare: Prepare) {
        if (!open || resolvingReceipt || submission.current || creation.status === 'pending') return
        const token: Submission = { generation: lifetime.current.generation, controller: new AbortController(), admitted: false }
        const resumeId = resumeIntent?.requestId
        submission.current = token
        setPreparing(true)
        try {
            // An unresolved receipt already has its exact name and kickoff. Never reread/rewrite it.
            const input = creation.status === 'uncertain' ? { text: creation.intent.kickoff } : await prepare(token.controller.signal)
            if (!current(token) || token.controller.signal.aborted || admission.current.resolvingReceipt || admission.current.resumeId !== resumeId) return
            const requested = requestDesktopCreation(creation, input)
            if (!requested.intent) {
                setFailure(requested.refusal === 'too-long' ? `A description can be at most ${DESKTOP_DESCRIPTION_MAX} characters.` : null)
                return
            }
            token.admitted = true
            setCreate(requested.state)
            setFailure(null)
            let outcome: DesktopCreateOutcome
            try { outcome = await onCreate(requested.intent) }
            catch (error) { outcome = { kind: 'uncertain', error: error instanceof Error ? error.message : '' } }
            if (!lifetime.current.mounted) return // Root retains the durable result across unmount/Quit.
            if (outcome.kind !== 'uncertain') settledReceipt.current = requested.intent.requestId
            setCreate(previous => previous.status !== 'idle' && previous.intent.requestId === requested.intent!.requestId
                ? settleDesktopCreation(previous, outcome) : previous)
            if (current(token)) {
                if (outcome.kind === 'created') changeOpen(false)
                else setFailure(outcome.kind === 'refused' ? outcome.error : null)
            } else if (outcome.kind === 'created' && lifetime.current.open) {
                // An old completion may not dismiss a newly opened dialog or offer the same draft
                // as a new creation. Acknowledge it without replaying its kickoff.
                setCompletedGeneration(lifetime.current.generation)
            }
        } finally {
            if (submission.current === token) {
                submission.current = null
                if (lifetime.current.mounted) setPreparing(false)
            }
        }
    }

    const busy = preparing || creation.status === 'pending'
    return <Dialog open={open} onOpenChange={changeOpen} asSheet={false}>
        {open && <DialogContent className="flex max-h-[90dvh] flex-col overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
                <DialogTitle>{first ? 'Create your first coworker' : 'Add a coworker'}</DialogTitle>
                <DialogDescription>Describe the job the way you would brief a teammate. Your coworker receives that description as its first message after you place it on the board.</DialogDescription>
            </DialogHeader>
            {resolvingReceipt ? <p role="status">Checking your previous creation…</p>
                : completedGeneration === generation ? <div><p role="status">Your coworker was created.</p><Button onClick={() => changeOpen(false)}>Close</Button></div>
                : <DesktopNewAgentForm key={generation} creation={creation} busy={busy} read={read} capabilities={capabilities} onSubmit={submit} />}
            {failure && creation.status !== 'uncertain' && <p role="alert" className="px-1 text-sm text-destructive">{failure}</p>}
        </DialogContent>}
    </Dialog>
}

function DesktopNewAgentForm({ creation, busy, read, capabilities, onSubmit }: {
    creation: DesktopCreateState; busy: boolean; read?: JobReader; capabilities: DesktopNewAgentCapabilities; onSubmit: (prepare: Prepare) => Promise<void>
}) {
    const rootRef = useRef<HTMLDivElement>(null)
    const anchorRef = useRef<HTMLSpanElement>(null)
    const gaze = useFollow({ rootRef, anchorRef })
    const reader = useMemo(() => createDesktopJobReader(), [])
    const [text, setText] = useState(creation.status === 'idle' ? '' : creation.intent.kickoff)
    const [pinned, setPinned] = useState<string | null>(creation.status === 'idle' ? null : creation.intent.name)
    const [editing, setEditing] = useState(false)
    const { reading, pending, settle } = useJobReading(creation.status === 'idle' ? text : '', read ?? reader.read)
    useEffect(() => () => { reader.cancel() }, [reader])
    const uncertain = creation.status === 'uncertain' ? creation : null
    const name = uncertain?.intent.name ?? pinned ?? reading.name
    const submit = () => onSubmit(async signal => ({
        // The optional shared capabilities cannot activate setup actions without real callbacks.
        text, pinnedName: pinned, capabilities: { ...capabilities, apps: false, templates: false, schedule: false },
        reading: pending ? await settled(settle(), reading, signal) : reading,
    }))

    return <div ref={rootRef} className="relative isolate flex min-h-0 flex-col items-center overflow-x-hidden px-1 pt-2 pb-4 sm:overflow-hidden">
        <div className="relative flex w-full flex-col items-center">
            <div className="hidden sm:contents"><Floor fade={FADE} lights={[floorLight(text.trim() !== '')]} style={{ top: ORB_SIZE / 2 }} /><OrbLight focused={text.trim() !== ''} top={ORB_SIZE / 2} className="z-10" /></div>
            <div className="relative z-20"><span ref={anchorRef} aria-hidden className="absolute top-1/2 left-1/2" /><div style={{ transform: 'translate(var(--orb-x, 0px), var(--orb-y, 0px))' }}><Orb state={busy || pending || uncertain ? 'thinking' : 'listening'} size={ORB_SIZE} gaze={gaze} /></div></div>
            <h2 className="mt-5 text-center font-heading text-xl font-medium tracking-tight">{name ? `What should ${name} do?` : 'What should your new coworker do?'}</h2>
            {uncertain ? <div className="mt-5 w-full rounded-2xl border border-border bg-muted/40 p-4">
                <p role="alert" className="text-sm text-foreground">{UNCERTAIN}</p>
                {uncertain.error && <p className="mt-2 text-xs text-muted-foreground">{uncertain.error}</p>}
                <div className="mt-3 flex justify-end"><Button type="button" size="sm" disabled={busy} onClick={() => { void submit() }}>Try again</Button></div>
            </div> : <Composer text={text} onText={next => { if (!busy) { reader.cancel(); setText(next) } }} onSubmit={() => { void submit() }}
                mark={null} preview={null} drawnCaret={false} maxLength={DESKTOP_DESCRIPTION_MAX} className="mt-5 w-full"
                name={name} nameProps={{ editing, onEdit: () => { if (!busy) setEditing(true) }, onRename: next => { if (!busy) { setEditing(false); setPinned(next.slice(0, AGENT_NAME_MAX).trim() || null) } }, onCancel: () => setEditing(false) }}
                catalog={null} apps={[]} onToggleApp={() => {}}
                schedule={{ read: reading.schedule, choice: DESCRIBED, onChoice: () => {}, open: false, onOpenChange: () => {} }}
                canCreate={text.trim().length > 0 && !busy} creating={busy}
                capabilities={{ apps: false, schedule: false }} />}
        </div>
    </div>
}
