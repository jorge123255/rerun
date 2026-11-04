'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { NewBoxForm } from '@/components/dialogs/new-box/NewBoxForm'
import { SplitDialogContent } from '@/components/dialogs/SplitDialogContent'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BOX_NAME_MAX, UNNAMED_BOX_LABEL } from '@/lib/board/types'
import { boxNameSuggestions } from '@/lib/onboarding/box-name-suggestions'
import { isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import type { DesktopSpace, DesktopSpaceCommand } from '@/lib/desktop/spaces'
import type { ContainerSide } from '@rerun/ui/iso-grid'

export type DesktopSpaceDialogTarget = { kind: 'create'; sourceId?: string; side?: ContainerSide }
    | { kind: 'rename' | 'delete'; spaceId: string }

// Original ClaimSpaceDialog/NewBoxForm, RenameBoxDialog and DeleteSpaceDialog surfaces, with
// local awaited writes. A failed write leaves the same form and draft available for retry.
export function DesktopSpaceDialogs({ target, spaces, memberCount, onCommand, onClose, onRestoreFocus, disabled = false }: {
    target: DesktopSpaceDialogTarget; spaces: DesktopSpace[]; memberCount: number
    onCommand: (command: DesktopSpaceCommand) => Promise<void>; onClose: () => void; disabled?: boolean
    onRestoreFocus?: () => void
}) {
    const space = target.kind === 'create' ? undefined : spaces.find(space => space.id === target.spaceId)
    const [name, setName] = useState(space?.name ?? '')
    const [confirmation, setConfirmation] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const quitting = useSyncExternalStore(subscribeDraftShutdown, isDesktopQuitting, () => false)
    const alive = useRef(true), busy = useRef(false)
    const latest = useRef({ target, space, memberCount, onCommand, onClose, disabled })
    latest.current = { target, space, memberCount, onCommand, onClose, disabled }
    useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    const blocked = saving || disabled || quitting
    function close() { if (alive.current && !busy.current && !isDesktopQuitting()) latest.current.onClose() }
    async function submit(command: DesktopSpaceCommand) {
        if (!alive.current || busy.current || latest.current.disabled || isDesktopQuitting()) throw new Error('Wait for the current change to finish.')
        const live = latest.current
        if (command.kind !== 'create' && (!live.space || live.space.id !== command.spaceId)) throw new Error('This Box no longer exists.')
        if (command.kind === 'delete' && (live.memberCount > 0 || command.confirmationName !== live.space?.name)) throw new Error('Move the coworkers out and type the current Box name to confirm.')
        busy.current = true; setSaving(true); setError('')
        try {
            await live.onCommand(command)
            if (alive.current) live.onClose()
        } finally {
            busy.current = false
            if (alive.current) setSaving(false)
        }
    }
    async function save(command: DesktopSpaceCommand) {
        try { await submit(command) } catch (cause) {
            if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not save this Box. Try again.')
        }
    }
    if (target.kind === 'create') return <Dialog open onOpenChange={next => { if (!next) close() }} asSheet={false} dismissible={!blocked}>
        <SplitDialogContent aside={null} gridClassName="sm:grid-cols-1" showCloseButton={!blocked} onCloseAutoFocus={event => { if (onRestoreFocus) { event.preventDefault(); onRestoreFocus() } }}
            onEscapeKeyDown={event => { if (busy.current || isDesktopQuitting()) event.preventDefault() }}
            onInteractOutside={event => { if (busy.current || isDesktopQuitting()) event.preventDefault() }}>
            <DialogTitle className="sr-only">New Box</DialogTitle>
            <DialogDescription className="sr-only">Name the Box, or pick a suggested name.</DialogDescription>
            <fieldset disabled={blocked} className="flex min-h-0 flex-1 flex-col border-0 p-0">
                <NewBoxForm suggestions={boxNameSuggestions(null, spaces.map(space => space.name))}
                    onCreate={name => submit({ kind: 'create', name, ...(target.sourceId && { sourceId: target.sourceId, side: target.side }) })}
                    controls={<Button type="button" variant="ghost" disabled={blocked} onClick={close}>Cancel</Button>} />
            </fieldset>
        </SplitDialogContent>
    </Dialog>

    if (!space) return null
    if (target.kind === 'rename') return <Dialog open onOpenChange={next => { if (!next) close() }} asSheet={false} dismissible={!blocked}>
        <DialogContent className="sm:max-w-md" showCloseButton={!blocked} onCloseAutoFocus={event => { if (onRestoreFocus) { event.preventDefault(); onRestoreFocus() } }}
            onEscapeKeyDown={event => { if (busy.current || isDesktopQuitting()) event.preventDefault() }}
            onInteractOutside={event => { if (busy.current || isDesktopQuitting()) event.preventDefault() }}>
            <form className="flex flex-col gap-4" onSubmit={event => {
                event.preventDefault()
                if (!name.trim() || name.trim().length > BOX_NAME_MAX) return
                if (name.trim() === latest.current.space?.name) { close(); return }
                void save({ kind: 'rename', spaceId: space.id, name: name.trim() })
            }}>
                <DialogHeader><DialogTitle>Rename Box</DialogTitle><DialogDescription>The name you read on the board. Nothing else depends on it.</DialogDescription></DialogHeader>
                <Input label="Name" required autoFocus maxLength={BOX_NAME_MAX} placeholder={UNNAMED_BOX_LABEL} value={name} disabled={blocked} onChange={event => setName(event.target.value)} />
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <DialogFooter><Button type="button" variant="outline" disabled={blocked} onClick={close}>Cancel</Button><Button type="submit" disabled={blocked || !name.trim()}>{saving ? 'Renaming…' : 'Rename'}</Button></DialogFooter>
            </form>
        </DialogContent>
    </Dialog>

    const holdsAgents = memberCount > 0
    const canDelete = !blocked && !holdsAgents && confirmation.trim() === space.name
    const remove = () => { if (canDelete) void save({ kind: 'delete', spaceId: space.id, confirmationName: confirmation.trim() }) }
    return <AlertDialog open onOpenChange={next => { if (!next) close() }}>
        <AlertDialogContent size="sm" onCloseAutoFocus={event => { if (onRestoreFocus) { event.preventDefault(); onRestoreFocus() } }} onEscapeKeyDown={event => { if (busy.current || isDesktopQuitting()) event.preventDefault() }}>
            <AlertDialogHeader><AlertDialogTitle>Delete Box?</AlertDialogTitle><AlertDialogDescription>{holdsAgents
                ? `This Box still holds ${memberCount} coworker${memberCount === 1 ? '' : 's'}. Move ${memberCount === 1 ? 'it' : 'them'} to another Box or delete ${memberCount === 1 ? 'it' : 'them'} first.`
                : 'This action cannot be undone. The Box will be permanently removed.'}</AlertDialogDescription></AlertDialogHeader>
            {!holdsAgents && <div className="grid gap-2"><p className="text-sm text-muted-foreground">Type <span className="font-medium text-foreground">{space.name}</span> to confirm.</p>
                <Input value={confirmation} disabled={blocked} onChange={event => setConfirmation(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); remove() } }} placeholder={space.name} autoFocus />
            </div>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <AlertDialogFooter><AlertDialogCancel disabled={blocked}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={!canDelete} onClick={event => { event.preventDefault(); remove() }}>{saving ? 'Deleting…' : 'Delete'}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
    </AlertDialog>
}
