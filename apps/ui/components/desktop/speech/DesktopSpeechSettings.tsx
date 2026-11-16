'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DESKTOP_SPEECH_DEFAULT_VOICE, desktopSpeechSettingsSchema, desktopSpeechVoicesSchema, type DesktopSpeechSettings as Settings, type DesktopSpeechVoice } from '@/lib/desktop/speech'
import { announceDesktopSpeechChange, DESKTOP_SPEECH_PREVIEW_KEY, desktopSpeechPlayer, useDesktopSpeechPlayer } from '@/lib/desktop/speech-player'

/** Shown under the ElevenLabs key once one is saved: the voice, a preview, and automatic reading. */
export function DesktopSpeechSettings({ player = desktopSpeechPlayer }: { player?: typeof desktopSpeechPlayer }) {
    const [settings, setSettings] = useState<Settings | null>(null)
    const [voices, setVoices] = useState<DesktopSpeechVoice[] | null>(null)
    const [voicesError, setVoicesError] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const speech = useDesktopSpeechPlayer(player)
    useEffect(() => {
        const controller = new AbortController()
        const live = () => !controller.signal.aborted
        void fetch('/api/desktop/speech', { cache: 'no-store', signal: controller.signal }).then(async response => {
            if (!response.ok) throw new Error()
            const parsed = desktopSpeechSettingsSchema.parse(await response.json())
            if (live()) setSettings(parsed)
        }).catch(() => { if (live()) setError('Could not load the voice settings.') })
        void fetch('/api/desktop/speech/voices', { cache: 'no-store', signal: controller.signal }).then(async response => {
            if (!response.ok) {
                const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null
                if (live()) setVoicesError(typeof body?.code === 'string' && body.code.startsWith('speech_') && typeof body.error === 'string' ? body.error.slice(0, 400) : 'Could not load your ElevenLabs voices.')
                return
            }
            const parsed = desktopSpeechVoicesSchema.parse(await response.json())
            if (live()) setVoices(parsed.voices)
        }).catch(() => { if (live()) setVoicesError('Could not load your ElevenLabs voices.') })
        return () => { controller.abort(); player.stopWithin(DESKTOP_SPEECH_PREVIEW_KEY) }
    }, [player])

    async function change(body: { voiceId: string } | { autoRead: boolean }) {
        if (busy) return
        setBusy(true); setError('')
        try {
            const response = await fetch('/api/desktop/speech', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
            if (!response.ok) throw new Error()
            setSettings(desktopSpeechSettingsSchema.parse(await response.json()))
            announceDesktopSpeechChange()
        } catch { setError('The change could not be saved. Try again.') }
        finally { setBusy(false) }
    }

    if (!settings) return error ? <p role="alert" className="text-xs text-destructive">{error}</p> : <p role="status" className="text-xs text-muted-foreground">Loading the voice settings…</p>
    const listed = voices ?? []
    const options = listed.some(voice => voice.id === settings.voiceId) ? listed
        : [{ id: settings.voiceId, name: settings.voiceId === DESKTOP_SPEECH_DEFAULT_VOICE.id ? DESKTOP_SPEECH_DEFAULT_VOICE.name : 'Saved voice', detail: settings.voiceId === DESKTOP_SPEECH_DEFAULT_VOICE.id ? 'default' : '' }, ...listed]
    const previewing = speech.key === DESKTOP_SPEECH_PREVIEW_KEY
    const previewError = speech.error?.key === DESKTOP_SPEECH_PREVIEW_KEY ? speech.error.message : ''
    return <div className="space-y-3 border-t pt-3" data-speech-settings>
        <h3 className="text-sm font-semibold">Replies read aloud</h3>
        <p className="text-sm text-muted-foreground">Each reply gets a “Read aloud” button. When you use it, the reply’s text (up to its first 4,000 characters) is sent to ElevenLabs and billed to your ElevenLabs account. Code and tables are left out.</p>
        <label className="text-sm font-medium" htmlFor="speech-voice">Voice</label>
        <div className="flex gap-2">
            <select id="speech-voice" className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" disabled={busy} value={settings.voiceId}
                onChange={event => void change({ voiceId: event.target.value })}>
                {options.map(voice => <option key={voice.id} value={voice.id}>{voice.detail ? `${voice.name} (${voice.detail})` : voice.name}</option>)}
            </select>
            <Button type="button" variant="outline" disabled={busy} onClick={() => previewing ? player.stop() : void player.play(DESKTOP_SPEECH_PREVIEW_KEY, { preview: true })}>
                {previewing ? (speech.phase === 'loading' ? 'Preparing…' : 'Stop') : 'Preview'}
            </Button>
        </div>
        {!voices && !voicesError && <p role="status" className="text-xs text-muted-foreground">Loading your ElevenLabs voices…</p>}
        {voicesError && <p role="alert" className="text-xs text-destructive">{voicesError}</p>}
        {previewError && <p role="alert" className="text-xs text-destructive">{previewError}</p>}
        <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" role="switch" aria-checked={settings.autoRead} checked={settings.autoRead} disabled={busy} onChange={event => void change({ autoRead: event.target.checked })} />
            <span><span className="font-medium">Read replies aloud automatically</span>
                <span className="block text-muted-foreground">Off by default. When on, a new reply in the conversation you are looking at is spoken once when it finishes, in this workspace. Routine runs are never read, and nothing is read while the app is in the background. Every reply read this way is sent to ElevenLabs and billed to your account.</span></span>
        </label>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
}
