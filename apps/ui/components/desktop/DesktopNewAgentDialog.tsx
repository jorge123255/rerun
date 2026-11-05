'use client'

import { Orb } from '@rerun/ui/foreman'
import { Composer, fall, Floor, type FloorLight, OrbLight, useFollow, useJobReading, type JobReader, type JobReading } from '@rerun/ui/new-agent'
import { DESCRIBED } from '@rerun/ui/new-agent/schedule'
import { AGENT_NAME_MAX } from '@rerun/ui/new-agent/reading'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
    DESKTOP_DESCRIPTION_MAX, DESKTOP_NEW_AGENT_CAPABILITIES, IDLE_CREATION, createDesktopJobReader,
    requestDesktopCreation, settleDesktopCreation, type DesktopCreateOutcome, type DesktopCreateState,
    type DesktopCreationIntent, type DesktopNewAgentCapabilities,
} from '@/lib/desktop/new-agent'
import { useEffect, useMemo, useRef, useState } from 'react'

const ORB_SIZE = 56
// How long Create waits for the reading of what was just typed before going without it, as on the
// hosted dialog. The description is never held back by an optional hint.
const SETTLE_MS = 2500

function settled(reading: Promise<JobReading>, fallback: JobReading): Promise<JobReading> {
    return Promise.race([reading, new Promise<JobReading>(resolve => setTimeout(() => resolve(fallback), SETTLE_MS))])
}

// The same light the hosted dialog draws, so the two surfaces read as one product.
const FADE = 'radial-gradient(ellipse 820px 520px at 50% calc(50% + 240px), #000 0%, rgba(0,0,0,0.6) 50%, transparent 100%)'

function floorLight(focused: boolean): FloorLight {
    const source = 'calc(50% + var(--orb-x, 0px)) calc(50% + var(--orb-y, 0px))'
    return {
        masks: [fall(focused ? 60 : 80, source), `radial-gradient(760px 440px at ${source}, #000, rgba(0,0,0,0.55) 35%, rgba(0,0,0,0.18) 70%, transparent)`],
        light: 'rgb(104 80 252 / 0.2)',
        dark: 'rgb(200 190 255 / 0.18)',
    }
}

const UNCERTAIN = 'We could not confirm whether your coworker was created. Trying again checks the same attempt; it does not create a second one.'

/**
 * The hosted New agent flow, ported to this Mac: the Orb, the description field and its name pill,
 * and a Create that only ever returns an intent. Nothing here posts an agent, opens a chat, sends a
 * message or grants a tool — typing and name hints included. Root takes the intent, creates the
 * coworker, places it on the board and sends the kickoff exactly once.
 *
 * The Apps picker, Template browser and Schedule planner are not drawn because this build has no
 * connector install, no template import and no schedule store (see `DesktopNewAgentCapabilities`).
 */
export function DesktopNewAgentDialog({ open, onOpenChange, onCreate, read, capabilities = DESKTOP_NEW_AGENT_CAPABILITIES, first = false }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** Root creates the coworker and its first message, then reports what it knows. */
    onCreate: (intent: DesktopCreationIntent) => Promise<DesktopCreateOutcome>
    /** Usually omitted: the dialog reads through the bounded local-provider adapter. */
    read?: JobReader
    capabilities?: DesktopNewAgentCapabilities
    first?: boolean
}) {
    const rootRef = useRef<HTMLDivElement>(null)
    const anchorRef = useRef<HTMLSpanElement>(null)
    const gaze = useFollow({ rootRef, anchorRef })
    const reader = useMemo(() => createDesktopJobReader(), [])
    const [text, setText] = useState('')
    const [pinned, setPinned] = useState<string | null>(null)
    const [editing, setEditing] = useState(false)
    const [failure, setFailure] = useState<string | null>(null)
    // The creation lives here, not in the dialog body: closing and reopening keeps an uncertain
    // creation so its retry resolves the same receipt instead of making a second coworker.
    const [create, setCreate] = useState<DesktopCreateState>(IDLE_CREATION)
    const inFlight = useRef(false)
    const wasOpen = useRef(false)
    const { reading, pending, settle } = useJobReading(text, read ?? reader.read)

    useEffect(() => () => { reader.cancel() }, [reader])

    // A fresh dialog starts from an empty field. A refusal or an uncertain creation does not: the
    // description, and the one intent, stay exactly as they were.
    useEffect(() => {
        if (open && !wasOpen.current && create.status === 'idle') {
            setText('')
            setPinned(null)
            setEditing(false)
            setFailure(null)
        }
        wasOpen.current = open
    }, [open, create.status])

    const name = pinned ?? reading.name

    function rename(next: string) {
        const trimmed = next.slice(0, AGENT_NAME_MAX).trimEnd()
        setEditing(false)
        setPinned(trimmed || null)
    }

    async function submit() {
        if (inFlight.current || create.status === 'pending') return
        inFlight.current = true
        try {
            // A hint that has not come back yet is worth a short wait, never a blocked Create.
            const latest = pending ? await settled(settle(), reading) : reading
            const requested = requestDesktopCreation(create, { text, pinnedName: pinned, reading: latest, capabilities })
            setCreate(requested.state)
            if (!requested.intent) {
                setFailure(requested.refusal === 'too-long' ? `A description can be at most ${DESKTOP_DESCRIPTION_MAX} characters.` : null)
                return
            }
            setFailure(null)
            let outcome: DesktopCreateOutcome
            try {
                outcome = await onCreate(requested.intent)
            } catch (error) {
                // The request may have reached the server before it broke: uncertain, never a clean
                // failure, and never an invitation to create a second coworker.
                outcome = { kind: 'uncertain', error: error instanceof Error ? error.message : '' }
            }
            setCreate(current => settleDesktopCreation(current, outcome))
            if (outcome.kind === 'created') {
                setText('')
                setPinned(null)
                onOpenChange(false)
                return
            }
            setFailure(outcome.kind === 'uncertain' ? null : outcome.error)
        } finally {
            inFlight.current = false
        }
    }

    const busy = create.status === 'pending'
    const uncertainCreate = create.status === 'uncertain' ? create : null

    return <Dialog open={open} onOpenChange={onOpenChange} asSheet={false}>
        {open && <DialogContent className="flex max-h-[90dvh] flex-col overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
                <DialogTitle>{first ? 'Create your first coworker' : 'Add a coworker'}</DialogTitle>
                <DialogDescription>
                    Describe the job the way you would brief a teammate. Your coworker receives that description as its first message; nothing is created until you press Create.
                </DialogDescription>
            </DialogHeader>
            <div ref={rootRef} className="relative isolate flex min-h-0 flex-col items-center overflow-x-hidden px-1 pt-2 pb-4 sm:overflow-hidden">
                <div className="relative flex w-full flex-col items-center">
                    <div className="hidden sm:contents">
                        <Floor fade={FADE} lights={[floorLight(text.trim() !== '')]} style={{ top: ORB_SIZE / 2 }} />
                        <OrbLight focused={text.trim() !== ''} top={ORB_SIZE / 2} className="z-10" />
                    </div>
                    <div className="relative z-20">
                        <span ref={anchorRef} aria-hidden className="absolute top-1/2 left-1/2" />
                        <div style={{ transform: 'translate(var(--orb-x, 0px), var(--orb-y, 0px))' }}>
                            <Orb state={busy || pending || Boolean(uncertainCreate) ? 'thinking' : 'listening'} size={ORB_SIZE} gaze={gaze} />
                        </div>
                    </div>
                    <h2 className="mt-5 text-center font-heading text-xl font-medium tracking-tight">{name ? `What should ${name} do?` : 'What should your new coworker do?'}</h2>
                    {uncertainCreate
                        ? <div className="mt-5 w-full rounded-2xl border border-border bg-muted/40 p-4">
                            <p role="alert" className="text-sm text-foreground">{UNCERTAIN}</p>
                            {uncertainCreate.error && <p className="mt-2 text-xs text-muted-foreground">{uncertainCreate.error}</p>}
                            <div className="mt-3 flex justify-end gap-2">
                                <Button type="button" variant="outline" size="sm" onClick={() => { setCreate(IDLE_CREATION); setFailure(null) }}>Start over</Button>
                                <Button type="button" size="sm" onClick={() => { void submit() }}>Try again</Button>
                            </div>
                        </div>
                        : <Composer
                            text={text}
                            onText={setText}
                            onSubmit={() => { void submit() }}
                            mark={null}
                            preview={null}
                            drawnCaret={false}
                            maxLength={DESKTOP_DESCRIPTION_MAX}
                            className="mt-5 w-full"
                            name={name}
                            nameProps={{
                                editing,
                                onEdit: () => setEditing(true),
                                onRename: rename,
                                onCancel: () => setEditing(false),
                            }}
                            catalog={null}
                            apps={[]}
                            onToggleApp={() => {}}
                            schedule={{ read: reading.schedule, choice: DESCRIBED, onChoice: () => {}, open: false, onOpenChange: () => {} }}
                            canCreate={text.trim().length > 0 && !busy}
                            creating={busy}
                            capabilities={{ apps: capabilities.apps, schedule: capabilities.schedule }}
                        />}
                </div>
            </div>
            {failure && !uncertainCreate && <p role="alert" className="px-1 text-sm text-destructive">{failure}</p>}
        </DialogContent>}
    </Dialog>
}
