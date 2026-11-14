'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { Input } from '@/components/ui/input'
import { DESKTOP_WORKSPACE_UI_COPY } from '@/lib/desktop/workspaces'
import type { DesktopWorkspaceClient } from '@/lib/desktop/workspaces'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'
import { Loader2Icon, PencilIcon } from '@/lib/icons'
import { useEffect, useState } from 'react'
import type { DesktopWorkspaceRecord } from '@rerun/contracts'

/** Local rename surface — name only here; icon changes stay on existing DesktopWorkspaceSettings. */
export function RenameDesktopWorkspaceDialog({
    open,
    onOpenChange,
    workspace,
    client,
    onRenamed,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    workspace: DesktopWorkspaceRecord | null
    client: DesktopWorkspaceClient
    onRenamed: (workspace: DesktopWorkspaceRecord) => void
}) {
    const [name, setName] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!open || !workspace) return
        setName(workspace.name)
        setError(null)
        setBusy(false)
    }, [open, workspace])

    if (!workspace) return null

    const save = async () => {
        if (busy) return
        const trimmed = name.trim()
        if (!trimmed) { setError('Name is required'); return }
        if (trimmed.length > WORKSPACE_NAME_MAX) {
            setError(`Keep the name under ${WORKSPACE_NAME_MAX} characters`)
            return
        }
        setBusy(true)
        setError(null)
        try {
            const result = await client.rename({
                requestId: crypto.randomUUID(),
                workspaceId: workspace.workspaceId,
                name: trimmed,
            })
            if (!result.ok) {
                setError(result.message)
                setBusy(false)
                return
            }
            onRenamed(result.workspace)
            onOpenChange(false)
        } catch {
            setError('The workspace could not be renamed.')
            setBusy(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
            <DialogContent className="flex max-h-[min(100dvh-2rem,32rem)] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
                <form
                    className="flex min-h-0 flex-1 flex-col"
                    onSubmit={event => { event.preventDefault(); void save() }}
                >
                    <DialogHeaderBar icon={PencilIcon} title={DESKTOP_WORKSPACE_UI_COPY.renameTitle} description={DESKTOP_WORKSPACE_UI_COPY.renameHelp} />
                    <div className="space-y-4 p-4">
                        <Input
                            id="desktop-workspace-rename-name"
                            label="Name"
                            required
                            placeholder="e.g. Acme Inc."
                            maxLength={WORKSPACE_NAME_MAX}
                            value={name}
                            disabled={busy}
                            onChange={event => setName(event.target.value)}
                        />
                        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
                    </div>
                    <DialogFooter className="flex flex-wrap gap-2 border-t bg-muted/50 p-4">
                        <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                            {DESKTOP_WORKSPACE_UI_COPY.cancel}
                        </Button>
                        <Button type="submit" disabled={busy || !name.trim()}>
                            {busy && <Loader2Icon className="animate-spin" />}
                            {busy ? DESKTOP_WORKSPACE_UI_COPY.saving : DESKTOP_WORKSPACE_UI_COPY.save}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
