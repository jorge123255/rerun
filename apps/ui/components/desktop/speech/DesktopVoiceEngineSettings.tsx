'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { desktopVoiceEngineReplySchema, type DesktopVoiceEngineAction, type DesktopVoiceEngineStatus, type DesktopVoiceRelayDeploy } from '@/lib/desktop/voice-engine'

/** Talking to the Chief of Staff from a paired phone, through the owner's own relay and ElevenLabs. */
export function DesktopVoiceEngineSettings({ keySaved }: { keySaved: boolean }) {
    const [status, setStatus] = useState<DesktopVoiceEngineStatus | null>(null)
    const [deploy, setDeploy] = useState<DesktopVoiceRelayDeploy | null>(null)
    const [relay, setRelay] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    useEffect(() => {
        const controller = new AbortController()
        const load = () => fetch('/api/desktop/voice-engine', { cache: 'no-store', signal: controller.signal }).then(async response => {
            if (!response.ok) throw new Error()
            const parsed = desktopVoiceEngineReplySchema.parse(await response.json())
            if (!controller.signal.aborted) { setStatus(parsed.status); setRelay(current => current || parsed.status.relayOrigin || '') }
        })
        load().catch(() => { if (!controller.signal.aborted) setError('Could not load the phone voice settings.') })
        // The relay's connection comes and goes on its own; the status line follows it.
        const timer = setInterval(() => { void load().catch(() => {}) }, 10_000)
        return () => { controller.abort(); clearInterval(timer) }
    }, [keySaved])

    async function act(action: DesktopVoiceEngineAction, failure: string) {
        if (busy) return
        setBusy(true); setError('')
        try {
            const response = await fetch('/api/desktop/voice-engine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action), cache: 'no-store' })
            const body = await response.json().catch(() => null) as { error?: unknown } | null
            if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error.slice(0, 300) : failure)
            const parsed = desktopVoiceEngineReplySchema.parse(body)
            setStatus(parsed.status)
            if (parsed.deploy) setDeploy(parsed.deploy)
        } catch (caught) { setError(caught instanceof Error && caught.message ? caught.message : failure) }
        finally { setBusy(false) }
    }

    if (!status) return <section className="space-y-2 rounded-xl border p-4">
        <h2 className="font-semibold">Talk to the Chief of Staff from your phone</h2>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : <p role="status" className="text-xs text-muted-foreground">Loading…</p>}
    </section>

    const canCreate = !!status.relayOrigin && status.keySaved && !busy
    return <section className="space-y-3 rounded-xl border p-4" data-voice-engine-settings>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Talk to the Chief of Staff from your phone</h2>
            <span className="text-xs text-muted-foreground" role="status">
                {!status.relayOrigin ? 'Not set up' : status.relayConnected ? 'Relay connected' : status.enabled ? 'Relay not connected' : 'Off'}
            </span>
        </div>
        <p className="text-sm text-muted-foreground">
            A paired phone that may send messages can hold a spoken conversation with the Chief of Staff. During one, the phone’s audio goes to
            ElevenLabs, which turns it into text for this Mac, and what the Chief of Staff says goes to ElevenLabs as text, through your relay, to be
            spoken. ElevenLabs bills your account. This Mac only makes outbound connections; it accepts nothing from the internet. Off by default.
        </p>
        <p className="text-sm text-muted-foreground">
            The relay is a small Cloudflare Worker you deploy on your own account, from the <code>cloud-voice-relay</code> folder of Rerun’s source. Enter its address, then give it the values shown below.
        </p>
        <label className="text-sm font-medium" htmlFor="voice-relay-address">Relay address</label>
        <div className="flex flex-col gap-2 sm:flex-row">
            <Input id="voice-relay-address" className="min-w-0 flex-1" placeholder="https://voice.example.com" autoComplete="off" spellCheck={false} disabled={busy}
                value={relay} onChange={event => setRelay(event.target.value)} />
            <Button type="button" disabled={busy || !relay.trim()} onClick={() => void act({ action: 'relay', relayOrigin: relay.trim() }, 'The relay address could not be saved.')}>Save address</Button>
        </div>

        {deploy && <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3" role="note">
            <p className="text-sm font-medium">Give these to your relay now. They are shown only this once.</p>
            <p className="text-xs text-muted-foreground">In the <code>cloud-voice-relay</code> folder, run <code>npx wrangler secret put RELAY_INSTALLS</code> and paste the value below. To see them again you would make new ones.</p>
            <CopyField label="RELAY_INSTALLS value" value={deploy.workerSecret} />
            <CopyField label="This Mac’s id (part of the relay’s paths)" value={deploy.installId} />
            <Button type="button" size="sm" variant="outline" onClick={() => setDeploy(null)}>I have saved them</Button>
        </div>}

        {status.relayOrigin && <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" disabled={!canCreate} onClick={() => void act({ action: 'create-engine' }, 'The voice engine could not be created.')}>
                    {status.engineReady ? 'Create voice engine again' : 'Create voice engine'}
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: 'rotate' }, 'New relay values could not be made.')}>Make new relay values</Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: 'forget' }, 'The voice settings could not be removed.')}>Remove</Button>
            </div>
            {!status.keySaved && <p className="text-xs text-muted-foreground">Save an ElevenLabs key above to create the voice engine.</p>}
            {status.engineStale && <p className="text-xs text-muted-foreground">The ElevenLabs key or the relay changed since the engine was made. Create it again.</p>}
            <p className="text-xs text-muted-foreground">Creating the engine sets up a Speech Engine in your ElevenLabs account that only this Mac can start conversations with, that does not record audio, keeps transcripts as briefly as ElevenLabs allows, and ends a call after ten minutes.</p>
            <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" role="switch" aria-checked={status.enabled} checked={status.enabled} disabled={busy || !status.engineReady && !status.enabled}
                    onChange={event => void act({ action: 'enabled', enabled: event.target.checked }, 'The change could not be saved.')} />
                <span><span className="font-medium">Allow voice conversations from paired phones</span>
                    <span className="block text-muted-foreground">While on, this Mac keeps one outbound connection to your relay. Only phones you allowed to send messages can start one.</span></span>
            </label>
        </div>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
}

function CopyField({ label, value }: { label: string; value: string }) {
    const [copied, setCopied] = useState(false)
    return <div className="space-y-1">
        <p className="text-xs font-medium">{label}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
            <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs">{value}</code>
            <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false))}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
    </div>
}
