'use client'

import { useEffect, useRef, useState } from 'react'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { FileTextIcon, PencilIcon, WorkflowIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { SETTINGS_CARD, SettingsSection, SwitchRow } from '@/components/notifications/settings/SettingsSection'
import { foremanFilePermissionSnapshotSchema, type ForemanFilePermissionSnapshot } from '@/lib/desktop/foreman-file-permissions'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'

const URL_PATH = '/api/desktop/foreman/file-permissions'
export function DesktopForemanFilePermissions({ chat, disabled = false }: { chat: DesktopForemanChatRef; disabled?: boolean }) {
    const [open, setOpen] = useState(false)
    const [snapshot, setSnapshot] = useState<ForemanFilePermissionSnapshot | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [refresh, setRefresh] = useState(0)
    const owner = JSON.stringify([chat.workspaceId, chat.chatId])
    const live = useRef({ owner, current: true })
    if (live.current.owner !== owner) live.current = { owner, current: true }
    useEffect(() => { const own = live.current; own.current = true; return () => { own.current = false } }, [owner])
    useEffect(() => {
        setSnapshot(null)
        if (!open || disabled) return
        const own = live.current, controller = new AbortController()
        setError(null)
        const current = () => own === live.current && own.current && !controller.signal.aborted && !isDesktopQuitting()
        void fetch(`${URL_PATH}?${new URLSearchParams(chat)}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
            .then(async response => {
                if (!response.ok) throw new Error('Could not read Foreman file permissions.')
                const value = foremanFilePermissionSnapshotSchema.parse(await response.json())
                if (value.workspaceId !== chat.workspaceId) throw new Error('The workspace changed. Reopen Foreman.')
                if (current()) setSnapshot(value)
            }).catch(() => { if (current()) setError('Could not read Foreman file permissions. Refresh to try again.') })
        return () => controller.abort()
    }, [open, disabled, owner, refresh, chat.workspaceId, chat.chatId])
    const change = async (id: keyof ForemanFilePermissionSnapshot['grants'], enabled: boolean) => {
        if (!snapshot || busy || disabled || isDesktopQuitting()) return
        const own = live.current, before = snapshot
        setBusy(true); setError(null)
        try {
            const response = await fetch(URL_PATH, { method: 'PATCH', headers: { 'content-type': 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15_000),
                body: JSON.stringify({ chat, launchNonce: before.launchNonce, expectedGrants: before.grants, id, enabled }) })
            if (!response.ok) throw new Error('Unacknowledged change')
            const value = foremanFilePermissionSnapshotSchema.parse(await response.json())
            if (value.workspaceId !== before.workspaceId || value.launchNonce !== before.launchNonce || value.grants[id] !== enabled) throw new Error('Permission identity changed')
            if (own === live.current && own.current && !isDesktopQuitting()) setSnapshot(value)
        } catch {
            if (own === live.current && own.current) { setSnapshot(null); setError('The change was not acknowledged. Refresh to inspect the saved permissions before choosing again.') }
        } finally { if (own === live.current && own.current) setBusy(false) }
    }
    return <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next) }}>
        <DialogTrigger asChild><Button size="sm" variant="ghost" disabled={disabled}>Permissions</Button></DialogTrigger>
        <DialogContent>
            <DialogHeader><DialogTitle>Foreman permissions</DialogTitle><DialogDescription>Choose whether Foreman can delegate tasks or work with other coworkers’ visible Files. Chats, memories, credentials and hidden stores stay excluded.</DialogDescription></DialogHeader>
            {error ? <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button size="sm" variant="outline" onClick={() => setRefresh(value => value + 1)} disabled={busy}>Refresh permissions</Button></div>
                : !snapshot ? <p role="status" className="text-sm text-muted-foreground">Loading permissions…</p>
                : <><SettingsSection title="Other coworkers’ files"><div className={SETTINGS_CARD}>
                    <SwitchRow icon={FileTextIcon} label="Read coworkers’ files" description="Read, list and search saved visible text files." checked={snapshot.grants.foremanAgentFilesRead} disabled={busy || disabled} onChange={enabled => { void change('foremanAgentFilesRead', enabled) }} />
                    <SwitchRow icon={PencilIcon} label="Edit coworkers’ files" description="Create and edit text and Markdown files. This does not turn on read access." checked={snapshot.grants.foremanAgentFilesWrite} disabled={busy || disabled} onChange={enabled => { void change('foremanAgentFilesWrite', enabled) }} />
                </div></SettingsSection>
                {snapshot.grants.delegate !== undefined && <SettingsSection title="Delegation"><div className={SETTINGS_CARD}>
                    <SwitchRow icon={WorkflowIcon} label="Delegate tasks" description="Run isolated workers that receive only the task and return text." checked={snapshot.grants.delegate} disabled={busy || disabled} onChange={enabled => { void change('delegate', enabled) }} />
                </div></SettingsSection>}</>}
            <p className="text-xs text-muted-foreground">New permissions apply from Foreman’s next reply. Turning a permission off blocks later calls.</p>
        </DialogContent>
    </Dialog>
}
