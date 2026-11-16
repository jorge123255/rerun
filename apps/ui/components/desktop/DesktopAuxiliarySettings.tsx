'use client'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DesktopSpeechSettings } from './speech/DesktopSpeechSettings'
import { announceDesktopSpeechChange } from '@/lib/desktop/speech-player'
import { DESKTOP_SPEECH_KEY_PURPOSE } from '@/lib/desktop/speech'
import { DESKTOP_KEYLESS_SEARCH_ON, DESKTOP_LOCAL_EMBEDDING_DEFAULT, desktopAuxiliarySettingsSchema, desktopLocalEmbeddingModel, desktopLocalEmbeddingStatusSchema, type DesktopAuxiliaryStatus, type DesktopLocalEmbeddingStatus } from '@/lib/desktop/auxiliary'

const labels = {
    search: { title: 'Web search', provider: 'Brave Search', description: 'Find web results with Rerun’s web_search tool.' },
    'keirolabs-search': { title: 'Keirolabs web search', provider: 'Keirolabs', description: 'Rerun uses Keirolabs when no Brave Search key is saved.' },
    'browser-use-search': { title: 'Web search with Browser Use', provider: 'Browser Use', description: 'Search by a cloud browser run by Browser Use. Slower than a search API (up to 90 seconds) and billed by Browser Use for each search; your coworkers’ queries are sent to them. Used when no Brave Search or Keirolabs key is saved.' },
    'keenable-search': { title: 'Web search without a key', provider: 'Keenable', description: 'Search the web through Keenable with no key. Off by default: when it is on, your coworkers’ search queries are sent to Keenable. A saved Brave Search or Keirolabs key is used first.' },
    'github-read': { title: 'GitHub (read your repositories)', provider: 'GitHub', description: 'Lets the Chief of Staff read your private repositories when you list them as projects. Not needed when GitHub is signed in in the Vault. Use a fine-grained personal access token limited to the repositories you choose, with read-only access to Contents and Metadata. It is sent to api.github.com only, and never to a coworker or a model.' },
    embedding: { title: 'Memory search', provider: 'OpenRouter', description: 'Find related saved notes by meaning, using text-embedding-3-small. Keyword search works without a key.' },
    'local-embedding': { title: 'Memory search on this Mac', provider: 'Ollama', description: 'Find related saved notes by meaning with a model running on this Mac. No key, and the notes never leave the Mac. Used when no OpenRouter memory key is saved.' },
    transcription: { title: 'Voice messages', provider: 'OpenRouter', description: 'Turn recordings into chat text, using Whisper large v3 turbo.' },
    'elevenlabs-transcription': { title: 'Voice with ElevenLabs', provider: 'ElevenLabs', description: 'One key for both directions: turn recordings into chat text with ElevenLabs Scribe, and have replies read aloud in an ElevenLabs voice. Recordings go to ElevenLabs when no OpenRouter voice key is saved.' },
}

export function DesktopAuxiliarySettings() {
    const [rows, setRows] = useState<DesktopAuxiliaryStatus[] | null>(null)
    const [error, setError] = useState('')
    useEffect(() => {
        const controller = new AbortController()
        void fetch('/api/desktop/auxiliary', { cache: 'no-store', signal: controller.signal }).then(async response => {
            if (!response.ok) throw new Error()
            const parsed = desktopAuxiliarySettingsSchema.parse(await response.json())
            if (!controller.signal.aborted) setRows(parsed)
        }).catch(() => { if (!controller.signal.aborted) setError('Could not load tool services.') })
        return () => controller.abort()
    }, [])
    return <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Rerun uses these services for search, memories and voice. Enter a service API key to enable it. ChatGPT sign-in continues to power your chats.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!rows && !error && <p role="status" className="text-sm text-muted-foreground">Loading tool services…</p>}
        {rows?.map(row => <ServiceKey key={row.purpose + row.revision} row={row} onSaved={setRows}/>)}
    </div>
}

function ServiceKey({ row, onSaved }: { row: DesktopAuxiliaryStatus; onSaved: (rows: DesktopAuxiliaryStatus[]) => void }) {
    const label = labels[row.purpose]
    const [key, setKey] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const active = useRef(true), pending = useRef(false)
    useEffect(() => { active.current = true; return () => { active.current = false } }, [])
    async function save(secret: string) {
        if (pending.current) return
        pending.current = true; setBusy(true); setError('')
        try {
            const response = await fetch('/api/desktop/auxiliary', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: row.purpose, expectedRevision: row.revision, key: secret }), cache: 'no-store' })
            if (!response.ok) throw new Error()
            const next = desktopAuxiliarySettingsSchema.parse(await response.json())
            // Open conversations show or hide “Read aloud” as the ElevenLabs key comes and goes.
            if (row.purpose === DESKTOP_SPEECH_KEY_PURPOSE) announceDesktopSpeechChange()
            if (active.current) { setKey(''); onSaved(next) }
        } catch { if (active.current) { setKey(''); setError('The save could not be confirmed. Reopen Tool services to see the saved state.') } }
        finally { pending.current = false; if (active.current) setBusy(false) }
    }
    if (row.purpose === 'local-embedding') return <LocalEmbedding row={row} busy={busy} error={error} onSave={save} />
    if (row.purpose === 'keenable-search') return <div className="space-y-3 rounded-xl border p-4">
        <div className="flex items-center justify-between"><h2 className="font-semibold">{label.title}</h2><span className="text-xs text-muted-foreground">{row.configured ? 'On' : 'Off'}</span></div>
        <p className="text-sm text-muted-foreground">{label.description}</p>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save(row.configured ? '' : DESKTOP_KEYLESS_SEARCH_ON)}>{row.configured ? 'Turn off keyless search' : 'Turn on keyless search'}</Button>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
    return <form className="space-y-3 rounded-xl border p-4" onSubmit={event => { event.preventDefault(); if (key.trim()) void save(key.trim()) }}>
        <div className="flex items-center justify-between"><h2 className="font-semibold">{label.title}</h2><span className="text-xs text-muted-foreground">{row.configured ? 'Key saved' : 'Not configured'}</span></div>
        <p className="text-sm text-muted-foreground">{label.description}</p>
        <label className="text-sm font-medium" htmlFor={`tool-service-${row.purpose}`}>{label.provider} API key</label>
        <div className="flex gap-2"><Input id={`tool-service-${row.purpose}`} type="password" autoComplete="off" disabled={busy} value={key} onChange={event => setKey(event.target.value)}/><Button type="submit" disabled={busy || !key.trim()}>Save key</Button></div>
        {row.configured && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save('')}>Remove key</Button>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {row.configured && row.purpose === DESKTOP_SPEECH_KEY_PURPOSE && <DesktopSpeechSettings />}
    </form>
}

function LocalEmbedding({ row, busy, error, onSave }: { row: DesktopAuxiliaryStatus; busy: boolean; error: string; onSave: (value: string) => Promise<void> }) {
    const label = labels['local-embedding']
    const [status, setStatus] = useState<DesktopLocalEmbeddingStatus | null>(null)
    const [model, setModel] = useState('')
    const [tick, setTick] = useState(0)
    const downloading = status?.download?.state === 'downloading'
    useEffect(() => {
        const controller = new AbortController()
        void fetch('/api/desktop/auxiliary/local-embedding', { cache: 'no-store', signal: controller.signal })
            .then(async response => { if (response.ok && !controller.signal.aborted) setStatus(desktopLocalEmbeddingStatusSchema.parse(await response.json())) })
            .catch(() => { if (!controller.signal.aborted) setStatus({ running: false, models: [], embeddingModels: [] }) })
        return () => controller.abort()
    }, [row.revision, tick])
    // While Ollama downloads, ask how far it has come once a second.
    useEffect(() => {
        if (!downloading) return
        const timer = setTimeout(() => setTick(value => value + 1), 1_000)
        return () => clearTimeout(timer)
    }, [downloading, status])
    async function download() {
        const response = await fetch('/api/desktop/auxiliary/local-embedding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'download', model: DESKTOP_LOCAL_EMBEDDING_DEFAULT }), cache: 'no-store' }).catch(() => null)
        if (response?.ok) setStatus(desktopLocalEmbeddingStatusSchema.parse(await response.json()))
        else setStatus(current => current && { ...current, download: { model: DESKTOP_LOCAL_EMBEDDING_DEFAULT, state: 'failed', percent: 0, message: 'The download could not be started.' } })
    }
    const suggested = status?.embeddingModels[0] ?? DESKTOP_LOCAL_EMBEDDING_DEFAULT
    const chosen = model.trim() || suggested
    const valid = desktopLocalEmbeddingModel.safeParse(chosen).success
    const needsModel = !!status?.running && status.embeddingModels.length === 0
    const hint = !status ? 'Looking for Ollama on this Mac…'
        : !status.running ? 'Ollama is not running on this Mac. Ollama is a free app that runs models on your own computer.'
        : needsModel ? 'Ollama is running, but it has no model for memory search yet. Rerun can download one for you (about 270 MB).'
        : `Ollama is running. Models for memory search: ${status.embeddingModels.join(', ')}.`
    return <form className="space-y-3 rounded-xl border p-4" onSubmit={event => { event.preventDefault(); if (valid) void onSave(chosen) }}>
        <div className="flex items-center justify-between"><h2 className="font-semibold">{label.title}</h2><span className="text-xs text-muted-foreground">{row.configured ? 'On' : 'Off'}</span></div>
        <p className="text-sm text-muted-foreground">{label.description}</p>
        <p role="status" className="text-xs text-muted-foreground">{hint}</p>
        {status && !status.running && <div className="flex flex-wrap items-center gap-2">
            <a className="text-sm font-medium underline" href="https://ollama.com/download" target="_blank" rel="noreferrer">Install Ollama</a>
            <Button type="button" size="sm" variant="outline" onClick={() => setTick(value => value + 1)}>Check again</Button>
        </div>}
        {needsModel && !downloading && <Button type="button" size="sm" onClick={() => void download()}>Download model</Button>}
        {status?.download && status.download.state !== 'done' && <div className="space-y-1">
            {downloading && <div role="progressbar" aria-label="Model download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status.download.percent} className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-foreground transition-[width]" style={{ width: `${status.download.percent}%` }} />
            </div>}
            <p role={status.download.state === 'failed' ? 'alert' : 'status'} className={status.download.state === 'failed' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {downloading ? `Downloading ${status.download.model}: ${status.download.percent}%` : `The download did not finish: ${status.download.message}`}
            </p>
        </div>}
        <label className="text-sm font-medium" htmlFor="tool-service-local-embedding">Ollama embedding model</label>
        <div className="flex gap-2"><Input id="tool-service-local-embedding" autoComplete="off" spellCheck={false} disabled={busy} placeholder={suggested} value={model} onChange={event => setModel(event.target.value)}/><Button type="submit" disabled={busy || !valid || !status?.running || needsModel}>{row.configured ? 'Change model' : 'Turn on'}</Button></div>
        {row.configured && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void onSave('')}>Turn off</Button>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </form>
}
