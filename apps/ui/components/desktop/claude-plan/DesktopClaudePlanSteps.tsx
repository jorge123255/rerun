'use client'

import { useRef, useState, type ClipboardEvent } from 'react'
import { ForemanTrack, type TrackStep } from '@/components/connections/plan-connect/ForemanTrack'
import { nameStep } from '@/components/connections/plan-connect/NameStep'
import { StepError } from '@/components/connections/plan-connect/step-bits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { ProviderIcon } from '@/lib/engine/provider-icons'
import { ClipboardPasteIcon } from '@/lib/icons'
import { useDesktopClaudePlan, type DesktopClaudePlanRuntime } from '@/lib/desktop/claude-plan-client/use-desktop-claude-plan'

const REMARK = {
    idle: 'I’ll wait right here.',
    waiting: 'Paste what Claude gave you.',
    checking: 'Checking',
    connected: 'All set!',
    error: 'Let’s try that again.',
}

export function DesktopClaudePlanSteps({ runtime, onOpenAuthorization, onDone, lastStep, initialName = 'Claude' }: {
    runtime: DesktopClaudePlanRuntime
    onOpenAuthorization: (url: string) => void
    onDone: (name: string) => void | Promise<void>
    lastStep?: (linked: boolean) => TrackStep
    initialName?: string
}) {
    const oauth = useDesktopClaudePlan({ runtime, onOpenAuthorization })
    const [name, setName] = useState(initialName)
    const [saving, setSaving] = useState(false)
    const [nameError, setNameError] = useState<string | null>(null)
    const linked = oauth.linked
    const opened = oauth.phase !== 'idle'
    const busy = oauth.phase === 'checking' || oauth.attemptPhase === 'checking'
    const finish = async () => {
        if (!linked || saving || !name.trim()) return
        setSaving(true)
        setNameError(null)
        try { await onDone(name.trim()) }
        catch (cause) { setNameError(cause instanceof Error ? cause.message : 'Could not save the connection name.'); setSaving(false) }
    }
    const last = lastStep?.(linked) ?? nameStep({ linked, name, placeholder: initialName, onName: setName, onDone: finish, saving, error: nameError })
    return <ForemanTrack
        at={linked ? 2 : opened ? 1 : 0}
        done={linked ? 3 : opened ? 1 : 0}
        orb={busy ? 'thinking' : linked ? 'speaking' : 'listening'}
        remark={linked ? (last.remark ?? REMARK.connected) : REMARK[oauth.phase]}
        thinking={busy}
        steps={[
            {
                title: 'Approve Rerun on Claude',
                body: <TooltipDisabledReason reason={oauth.opening ? 'Claude is opening in a new tab' : undefined}>
                    <Button type="button" variant={opened ? 'outline' : 'default'} onClick={() => { void oauth.start() }} disabled={busy || linked || oauth.opening} className="gap-1.5">
                        <ProviderIcon provider="claude" className="size-3.5" />
                        {opened ? 'Open Claude again' : 'Open Claude'}
                    </Button>
                </TooltipDisabledReason>,
            },
            { title: 'Paste the code', body: <div className="space-y-2"><CodeInput oauth={oauth} />
                {oauth.phase === 'error' && <Button type="button" size="sm" variant="outline" onClick={() => void oauth.reconcile()}>Check saved state</Button>}
                {(oauth.attemptPhase === 'waiting' || oauth.attemptPhase === 'checking' || oauth.phase === 'waiting' || oauth.phase === 'checking') && <Button type="button" size="sm" variant="ghost" onClick={() => void oauth.cancel()}>Cancel sign-in</Button>}
            </div> },
            last,
        ]}
    />
}

function CodeInput({ oauth }: { oauth: ReturnType<typeof useDesktopClaudePlan> }) {
    const [value, setValue] = useState('')
    const [pasteRefused, setPasteRefused] = useState(false)
    const field = useRef<HTMLInputElement>(null)
    const busy = oauth.phase === 'checking' || oauth.attemptPhase === 'checking'
    const linked = oauth.linked
    const submit = async (text: string) => { if (await oauth.submit(text)) setValue('') }

    const pasteIntoField = (event: ClipboardEvent<HTMLInputElement>) => {
        const text = event.clipboardData.getData('text').trim()
        if (!text || text.startsWith('sk-ant')) return
        event.preventDefault()
        void submit(text)
    }
    const pasteFromClipboard = async () => {
        const text = await navigator.clipboard?.readText?.().catch(() => '')
        setPasteRefused(!text?.trim())
        if (text?.trim()) return submit(text)
        field.current?.focus()
    }

    return <div className="flex flex-col gap-1.5">
        <div className="flex gap-2">
            <div className="min-w-0 flex-1">
                <Input ref={field} hideRequired type="password" value={value} onChange={event => setValue(event.target.value)} onPaste={pasteIntoField}
                    onKeyDown={event => event.key === 'Enter' && void submit(value)} onBlur={() => void submit(value)} disabled={busy || linked}
                    placeholder={busy ? 'Checking the code…' : linked ? 'Code accepted' : 'Code from Claude'} className="h-8 w-full font-mono text-xs" />
            </div>
            <Button type="button" variant={oauth.phase === 'waiting' ? 'default' : 'outline'} onMouseDown={event => event.preventDefault()} onClick={pasteFromClipboard} disabled={busy || linked} className="gap-1.5">
                <ClipboardPasteIcon />
                Paste
            </Button>
        </div>
        {pasteRefused && !oauth.error && <p className="text-[11px] text-muted-foreground">Paste it in the field with ⌘V or Ctrl+V.</p>}
        <StepError error={oauth.error} />
    </div>
}
