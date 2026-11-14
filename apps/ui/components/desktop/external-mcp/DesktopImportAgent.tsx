'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IMPORT_SOURCES } from '@/lib/agent-import/sources'
import { DESKTOP_IMPORT_SOURCES, desktopImportKeyResultSchema, type DesktopImportSource } from '@/lib/desktop/external-mcp/import'
import { Loader2Icon } from '@/lib/icons'

const sources = IMPORT_SOURCES.filter(source => (DESKTOP_IMPORT_SOURCES as readonly string[]).includes(source.id))

/**
 * Brings an agent that runs on this Mac into Rerun as a coworker. It makes a key that lasts 24
 * hours, reaches only the import tools and writes only to the coworker it creates, and shows the
 * text to hand that agent. The text carries the key, so it is shown once.
 */
export function DesktopImportAgent({ workspaceId, listening, onCreated }: { workspaceId: number; listening: boolean; onCreated?: () => void }) {
    const [source, setSource] = useState<DesktopImportSource>('openclaw')
    const [pending, setPending] = useState(false)
    const [prompt, setPrompt] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    // The same request is sent again after a failure, so a key that was made is not made twice.
    const request = useRef<string | null>(null)

    const create = async () => {
        setPending(true); setError(null); setCopied(false)
        try {
            request.current ??= crypto.randomUUID()
            const response = await fetch('/api/desktop/external-mcp/import', {
                method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', credentials: 'same-origin', redirect: 'error',
                body: JSON.stringify({ requestId: request.current, workspaceId, source }),
            })
            const result = desktopImportKeyResultSchema.safeParse(await response.json().catch(() => null))
            if (!result.success) throw new Error('The import key could not be confirmed. Try again.')
            if (!result.data.ok) throw new Error(result.data.message)
            request.current = null
            if (!result.data.prompt) throw new Error('This import key was already made and its text was shown once. Make a new one.')
            setPrompt(result.data.prompt)
            onCreated?.()
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The import key could not be made.')
        } finally { setPending(false) }
    }

    return <section data-testid="desktop-import-agent" className="min-w-0 space-y-2">
        <div className="px-1">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Import an agent</h3>
            <p className="mt-1 text-xs text-muted-foreground">Bring an agent that runs on this Mac into Rerun as a coworker: its persona, skills, schedules, memories and text files. The key lasts 24 hours and only reaches the coworker it creates.</p>
        </div>
        {prompt ? <div className="space-y-2 rounded-lg border border-border/60 p-3">
            <p className="text-xs font-medium">Paste this into {sources.find(item => item.id === source)?.label ?? 'your agent'}. It is shown once.</p>
            <textarea readOnly aria-label="Import instructions" value={prompt} rows={8} className="w-full resize-none rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-snug" />
            <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => { setPrompt(null); setCopied(false) }}>Done</Button>
                <Button type="button" size="sm" onClick={() => { void navigator.clipboard.writeText(prompt).then(() => setCopied(true), () => setError('Could not copy. Select the text and copy it.')) }}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
        </div> : <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 px-3 py-2.5">
            <div role="radiogroup" aria-label="Where the agent comes from" className="flex flex-wrap gap-1">
                {sources.map(item => <button key={item.id} type="button" role="radio" aria-checked={source === item.id} disabled={pending} onClick={() => setSource(item.id as DesktopImportSource)}
                    className={`rounded-md border px-2 py-1 text-xs ${source === item.id ? 'border-foreground bg-accent text-accent-foreground' : 'border-border text-muted-foreground hover:bg-accent/60'}`}>{item.label}</button>)}
            </div>
            <Button type="button" size="sm" className="ml-auto" disabled={pending || !listening} onClick={() => { void create() }}>
                {pending && <Loader2Icon className="animate-spin" />}
                Create import key
            </Button>
            {!listening && <p className="w-full text-xs text-muted-foreground">Enable the local listener above first.</p>}
        </div>}
        {error && <p role="alert" className="px-1 text-xs text-destructive">{error}</p>}
    </section>
}
