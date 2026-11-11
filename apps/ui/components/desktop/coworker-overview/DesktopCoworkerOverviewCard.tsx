'use client'

import { useDesktopLocale } from '../DesktopLocale'
import { DesktopCoworkerNotificationControl } from '@/components/desktop/DesktopCoworkerNotificationBell'
import { DeleteCoworkerConfirmation } from '@/components/dialogs/DeleteCoworkerConfirmation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { acceptDesktopOverviewRename, desktopOverviewRenameBody, DESKTOP_OVERVIEW_RENAME_UNCONFIRMED } from '@/lib/desktop/coworker-overview/rename'
import { DESKTOP_OVERVIEW_MANAGE_REASON, desktopOverviewFocusGroups, moveDesktopOverviewFocus, type DesktopOverviewControl, type DesktopOverviewDestination } from '@/lib/desktop/coworker-overview'
import type { DesktopOverviewIdentity } from '@/lib/desktop/coworker-overview/identity'
import { sameDesktopOverviewIdentity } from '@/lib/desktop/coworker-overview/identity'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { BlocksIcon, BrainIcon, CalendarClockIcon, ChevronRightIcon, FolderIcon, GaugeIcon, Layers, Link2, SettingsIcon, TableIcon, Trash2Icon, XIcon } from '@/lib/icons'
import { AgentBuddy } from '@rerun/ui/iso-grid'
import { useEffect, useRef, useState, type ComponentType, type MouseEvent, type ReactNode } from 'react'
import { DesktopCoworkerOverviewComputer, type DesktopOverviewComputer } from './DesktopCoworkerOverviewComputer'

const ICONS: Record<DesktopOverviewDestination, ComponentType<{ className?: string }>> = {
    services: BlocksIcon,
    skills: Layers,
    memories: BrainIcon,
    scheduled: CalendarClockIcon,
    files: FolderIcon,
    data: TableIcon,
    monitoring: GaugeIcon,
    settings: SettingsIcon,
}
const TILES: DesktopOverviewDestination[] = ['services', 'skills', 'memories', 'scheduled']
const ROWS: DesktopOverviewDestination[] = ['files', 'data']
const FOOTER: DesktopOverviewDestination[] = ['monitoring', 'settings']

export function DesktopCoworkerOverviewCard({ identity, name, boxName, enabled, canManage, mood, servicesNeedConfig, needsMachineReason, settingsDisabledReason, computerEnabled, computer, working, loadingSlot, visible, focus, onFocus, onOpen, onClose, onShare, onDelete, onOpenComputer, onRenamed }: {
    identity: DesktopOverviewIdentity
    name: string
    boxName: string
    enabled: boolean
    canManage: boolean | null
    mood: 'asleep' | 'working' | 'idle'
    servicesNeedConfig: boolean
    needsMachineReason: string | null
    settingsDisabledReason: string | null
    computerEnabled: boolean
    computer: DesktopOverviewComputer
    working: boolean
    loadingSlot?: ReactNode
    visible: boolean
    focus: DesktopOverviewControl
    onFocus: (target: DesktopOverviewControl) => void
    onOpen: (tab: DesktopOverviewDestination, from: HTMLElement) => void
    onClose: () => void
    onShare?: () => void
    onDelete?: (identity: DesktopOverviewIdentity, confirmationName: string) => void | Promise<void>
    onOpenComputer?: () => void
    onRenamed: (identity: DesktopOverviewIdentity, name: string) => void
}) {
    const { t } = useDesktopLocale()
    const root = useRef<HTMLDivElement>(null)
    const [deleteOpen, setDeleteOpen] = useState(false)
    useEffect(() => {
        if (!visible) return
        const node = root.current?.querySelector<HTMLElement>(`[data-overview-focus="${CSS.escape(focus)}"]`)
        if (node && document.activeElement !== node) node.focus()
    }, [focus, visible])
    const offReason = enabled ? null : 'This coworker is off.'
    const manageReason = canManage === true ? null : DESKTOP_OVERVIEW_MANAGE_REASON
    const shareReason = needsMachineReason ?? manageReason ?? (onShare ? null : 'Sharing this coworker is not available in this window.')
    const deleteReason = needsMachineReason ?? manageReason ?? (onDelete ? null : 'Delete this coworker from its Box on the board.')
    const destinationReason = (tab: DesktopOverviewDestination) => tab === 'settings' ? settingsDisabledReason : offReason
    const move = (current: DesktopOverviewControl, key: string) => {
        if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Home' && key !== 'End') return
        onFocus(moveDesktopOverviewFocus(current, key, desktopOverviewFocusGroups(computerEnabled)))
    }
    return (
        <div ref={root} className="flex min-h-0 flex-col overflow-y-auto" onKeyDown={event => {
            const target = (event.target as HTMLElement).closest('[data-overview-focus]')
            const current = target?.getAttribute('data-overview-focus')
            if (!current) return
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            move(current as DesktopOverviewControl, event.key)
        }}>
            <CardIdentity identity={identity} name={name} boxName={boxName} mood={mood} canManage={canManage === true} shareReason={shareReason} onClose={onClose} onShare={onShare} onRenamed={onRenamed} />
            <div className="grid shrink-0 grid-cols-4 gap-1.5 px-3 pb-3">
                {TILES.map(tab => <DestinationButton key={tab} tab={tab} shape="tile" reason={destinationReason(tab)} selected={focus === tab} servicesNeedConfig={servicesNeedConfig} onFocus={() => onFocus(tab)} onOpen={onOpen} />)}
            </div>
            <div className="shrink-0 space-y-4 px-3 pb-3">
                <div className="space-y-1.5">
                    {ROWS.map(tab => <DestinationButton key={tab} tab={tab} shape="row" reason={destinationReason(tab)} selected={focus === tab} servicesNeedConfig={false} onFocus={() => onFocus(tab)} onOpen={onOpen} />)}
                </div>
                {computerEnabled && <DesktopCoworkerOverviewComputer computer={computer} working={working} disabledReason={needsMachineReason} loadingSlot={loadingSlot} selected={focus === 'computer'} onFocus={() => onFocus('computer')} onOpen={onOpenComputer} />}
            </div>
            <div className="shrink-0 space-y-2 border-t border-border p-3">
                <div className="grid grid-cols-2 gap-2">
                    {FOOTER.map(tab => <DestinationButton key={tab} tab={tab} shape="button" reason={destinationReason(tab)} selected={focus === tab} servicesNeedConfig={false} onFocus={() => onFocus(tab)} onOpen={onOpen} />)}
                </div>
                <div data-overview-focus="delete" tabIndex={focus === 'delete' ? 0 : -1} onFocus={() => onFocus('delete')} className="min-w-0 outline-none">
                <TooltipDisabledReason reason={deleteReason ?? undefined} className="flex w-full">
                    <button type="button" tabIndex={-1} disabled={!!deleteReason} onClick={() => setDeleteOpen(true)} className="flex w-full items-center justify-center gap-2 rounded-lg bg-destructive/10 py-2.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50 disabled:hover:bg-destructive/10">
                        <Trash2Icon className="size-4" />
                        {t('coworker.deleteCard')}
                    </button>
                </TooltipDisabledReason>
                </div>
            </div>
            {onDelete && <DeleteCoworkerConfirmation agentName={name} open={deleteOpen} onOpenChange={setDeleteOpen} description={t('coworker.deleteDescription')} labels={{
                title: t('coworker.deleteTitle'), input: t('coworker.deleteInput'),
                confirm: name => <>{t.rich('coworker.deleteConfirm', { name, b: chunks => <span className="font-medium text-foreground">{chunks}</span> })}</>,
                failed: t('coworker.deleteFailed'), cancel: t('cancel'), deleting: t('coworker.deleting'), submit: t('coworker.delete'),
            }} onDelete={confirmationName => onDelete(identity, confirmationName)} />}
        </div>
    )
}

function CardIdentity({ identity, name: confirmed, boxName, mood, canManage, shareReason, onClose, onShare, onRenamed }: {
    identity: DesktopOverviewIdentity
    name: string
    boxName: string
    mood: 'asleep' | 'working' | 'idle'
    canManage: boolean
    shareReason: string | null
    onClose: () => void
    onShare?: () => void
    onRenamed: (identity: DesktopOverviewIdentity, name: string) => void
}) {
    const { t } = useDesktopLocale()
    const [editing, setEditing] = useState(false)
    const [name, setName] = useState(confirmed)
    const [error, setError] = useState('')
    const [pending, setPending] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const request = useRef(0)
    const identityRef = useRef(identity)
    identityRef.current = identity
    useEffect(() => { request.current += 1; setPending(false); setEditing(false); setError('') }, [identity.ownerId, identity.workspaceId, identity.agentId])
    useEffect(() => { setName(confirmed) }, [confirmed])
    useEffect(() => { if (editing) inputRef.current?.select() }, [editing])
    const commit = () => {
        if (pending) return
        const body = desktopOverviewRenameBody(name)
        setEditing(false)
        if (!body.ok) { setName(confirmed); setError(body.message); return }
        if (!canManage) { setName(confirmed); setError(DESKTOP_OVERVIEW_MANAGE_REASON); return }
        if (body.name === confirmed) { setError(''); return }
        if (isDesktopQuitting()) { setName(confirmed); setError(DESKTOP_OVERVIEW_RENAME_UNCONFIRMED); return }
        const token = ++request.current
        const started = identity
        setPending(true)
        setError('')
        void fetch(`/api/desktop/agents/${encodeURIComponent(started.agentId)}`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: body.name }), credentials: 'same-origin', cache: 'no-store',
        }).then(async response => {
            const payload = await response.json().catch(() => null)
            if (token !== request.current || !sameDesktopOverviewIdentity(started, identityRef.current)) return
            if (!response.ok) { setName(confirmed); setError(typeof payload?.error === 'string' ? payload.error : DESKTOP_OVERVIEW_RENAME_UNCONFIRMED); return }
            const accepted = acceptDesktopOverviewRename({ identity: started, responseIdentity: identityRef.current, requestedName: body.name, response: payload })
            if (!accepted.ok) { setName(confirmed); setError(accepted.message); return }
            onRenamed(started, accepted.name)
        }).catch(() => {
            if (token !== request.current || !sameDesktopOverviewIdentity(started, identityRef.current)) return
            setName(confirmed)
            setError(DESKTOP_OVERVIEW_RENAME_UNCONFIRMED)
        }).finally(() => { if (token === request.current) setPending(false) })
    }
    return (
        <div className="relative flex shrink-0 flex-col items-center px-4 pb-3 pt-4">
            <div className="absolute left-3 top-3 flex items-center gap-0.5">
                <DesktopCoworkerNotificationControl agentId={identity.agentId} name={confirmed} />
                <TooltipDisabledReason reason={shareReason ?? undefined}>
                    <Button variant="ghost" size="sm" disabled={!!shareReason} onClick={onShare} className="text-muted-foreground">
                        <Link2 className="size-4" />
                        {t('coworker.share')}
                    </Button>
                </TooltipDisabledReason>
            </div>
            <div className="absolute right-3 top-3">
                <Button aria-label={t('coworker.closeCard')} variant="ghost" size="icon-sm" onClick={onClose}><XIcon className="size-4" /></Button>
            </div>
            <AgentBuddy agentId={identity.agentId} mood={mood} size={116} facing="left" />
            {editing ? (
                <Input ref={inputRef} aria-label={t('coworker.nameField')} hideRequired value={name} onChange={event => setName(event.target.value)} onBlur={commit} onKeyDown={event => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') { event.preventDefault(); setName(confirmed); setEditing(false) }
                }} className="-mt-1 h-8 w-48 text-center text-base font-semibold" />
            ) : (
                <TooltipDisabledReason reason={canManage ? undefined : DESKTOP_OVERVIEW_MANAGE_REASON} className="-mt-1 max-w-full">
                    <button type="button" aria-label={t('coworker.renameName', { name: confirmed })} disabled={pending || !canManage} onClick={() => { setName(confirmed); setError(''); setEditing(true) }} className="max-w-full truncate rounded-md px-2 py-0.5 text-base font-semibold leading-tight transition-colors hover:bg-accent disabled:opacity-50">{confirmed}</button>
                </TooltipDisabledReason>
            )}
            <span className="text-xs text-muted-foreground">{boxName}</span>
            {error && <p role="alert" className="mt-1 max-w-full text-center text-xs text-destructive">{error}</p>}
        </div>
    )
}

function DestinationButton({ tab, shape, reason, selected, servicesNeedConfig, onFocus, onOpen }: {
    tab: DesktopOverviewDestination
    shape: 'tile' | 'row' | 'button'
    reason: string | null
    selected: boolean
    servicesNeedConfig: boolean
    onFocus: () => void
    onOpen: (tab: DesktopOverviewDestination, from: HTMLElement) => void
}) {
    const { t } = useDesktopLocale()
    const label = t(`coworker.destinations.${tab}`)
    const Glyph = ICONS[tab]
    const open = (event: MouseEvent<HTMLButtonElement>) => onOpen(tab, event.currentTarget)
    const body = shape === 'row' ? (
            <TooltipDisabledReason reason={reason ?? undefined} className="flex w-full">
                <button type="button" tabIndex={-1} disabled={!!reason} onClick={open} className="flex w-full items-center gap-3 rounded-lg bg-muted/60 px-3 py-2.5 text-left transition-colors hover:bg-muted disabled:opacity-50">
                    <Glyph className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
                </button>
            </TooltipDisabledReason>
    ) : (
        <TooltipDisabledReason reason={reason ?? undefined} className={shape === 'button' ? 'flex w-full' : undefined}>
            <Button type="button" variant="outline" size={shape === 'button' ? 'sm' : 'default'} tabIndex={-1} disabled={!!reason} onClick={open} className={shape === 'tile' ? 'relative h-auto w-full flex-col gap-1 py-2 text-[11px]' : 'w-full'}>
                <Glyph className="size-4" />
                {label}
                {tab === 'services' && servicesNeedConfig && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-red-500 ring-2 ring-background" />}
            </Button>
        </TooltipDisabledReason>
    )
    return <div data-overview-focus={tab} tabIndex={selected ? 0 : -1} onFocus={onFocus} className="min-w-0 outline-none">{body}</div>
}
