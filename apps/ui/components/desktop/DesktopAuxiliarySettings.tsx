'use client'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { desktopAuxiliarySettingsSchema, type DesktopAuxiliaryStatus } from '@/lib/desktop/auxiliary'

const labels = {
    search: { title: 'Web search', provider: 'Brave Search', description: 'Find web results with Rerun’s web_search tool.' },
    embedding: { title: 'Memory search', provider: 'OpenRouter', description: 'Find related saved notes by meaning, using text-embedding-3-small. Keyword search works without a key.' },
    transcription: { title: 'Voice messages', provider: 'OpenRouter', description: 'Turn recordings into chat text, using Whisper large v3 turbo.' },
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
            if (active.current) { setKey(''); onSaved(next) }
        } catch { if (active.current) { setKey(''); setError('The save could not be confirmed. Reopen Tool services to see the saved state.') } }
        finally { pending.current = false; if (active.current) setBusy(false) }
    }
    return <form className="space-y-3 rounded-xl border p-4" onSubmit={event => { event.preventDefault(); if (key.trim()) void save(key.trim()) }}>
        <div className="flex items-center justify-between"><h2 className="font-semibold">{label.title}</h2><span className="text-xs text-muted-foreground">{row.configured ? 'Key saved' : 'Not configured'}</span></div>
        <p className="text-sm text-muted-foreground">{label.description}</p>
        <label className="text-sm font-medium" htmlFor={`tool-service-${row.purpose}`}>{label.provider} API key</label>
        <div className="flex gap-2"><Input id={`tool-service-${row.purpose}`} type="password" autoComplete="off" disabled={busy} value={key} onChange={event => setKey(event.target.value)}/><Button type="submit" disabled={busy || !key.trim()}>Save key</Button></div>
        {row.configured && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save('')}>Remove key</Button>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </form>
}
