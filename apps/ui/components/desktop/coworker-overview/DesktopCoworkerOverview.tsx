'use client'

import { CardDestinationGhost, type CardDestinationShape } from '@/components/agent/sheet/AgentCard'
import { AgentViewExpander, measureCardOrigin, type CardOrigin } from '@/components/agent/sheet/AgentViewExpander'
import { resolveDesktopOverviewBox } from '@/lib/desktop/coworker-overview/box'
import { desktopOverviewIdentityKey, validDesktopOverviewIdentity, type DesktopOverviewIdentity } from '@/lib/desktop/coworker-overview/identity'
import { closedDesktopOverview, openDesktopOverviewDestination, selectDesktopOverviewTab, type DesktopOverviewControl } from '@/lib/desktop/coworker-overview/navigation'
import { desktopOverviewServicesDot, shownDesktopOverviewTab, type DesktopOverviewDestination, type DesktopOverviewAcceptedPanelTab, type DesktopOverviewTab, type DesktopOverviewVisibility } from '@/lib/desktop/coworker-overview/sections'
import { useDesktopPanelCloseGuard, type DesktopPanelCloseGuard, type RegisterDesktopPanelCloseGuard } from '@/lib/desktop/use-dialog-control'
import { AnimatePresence } from 'motion/react'
import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { DesktopCoworkerOverviewCard } from './DesktopCoworkerOverviewCard'
import type { DesktopOverviewComputer } from './DesktopCoworkerOverviewComputer'
import { DesktopCoworkerOverviewScreen } from './DesktopCoworkerOverviewScreen'

const SHAPE: Record<DesktopOverviewDestination, CardDestinationShape> = {
    services: 'tile', skills: 'tile', memories: 'tile', scheduled: 'tile', files: 'row', data: 'row', monitoring: 'button', settings: 'button',
}

export function DesktopCoworkerOverview({ identity, agent, boxes, installAuthor = false, publishedAccess = false, canManage = null, phase = 'ready', error, servicesNeedConfig = null, needsMachineReason = null, settingsDisabledReason = null, computerEnabled = false, computer = { status: 'closed' }, working = false, mood = 'idle', loadingSlot, onClose, onShare, onDelete, onOpenComputer, onRenamed, onOpenAcceptedPanel, closeGuardRef, renderTab }: {
    identity: DesktopOverviewIdentity
    agent: { id: string; name: string; enabled?: boolean; spaceId?: string }
    boxes: readonly { id: string; name: string }[] | null
    installAuthor?: boolean
    publishedAccess?: boolean
    canManage?: boolean | null
    phase?: 'ready' | 'loading' | 'error' | 'empty'
    error?: string
    servicesNeedConfig?: boolean | null
    needsMachineReason?: string | null
    settingsDisabledReason?: string | null
    computerEnabled?: boolean
    computer?: DesktopOverviewComputer
    working?: boolean
    mood?: 'asleep' | 'working' | 'idle'
    loadingSlot?: ReactNode
    onClose: () => void
    onShare?: () => void
    onDelete?: (identity: DesktopOverviewIdentity, confirmationName: string) => void | Promise<void>
    onOpenComputer?: () => void
    onRenamed: (identity: DesktopOverviewIdentity, name: string) => void
    onOpenAcceptedPanel?: (tab: DesktopOverviewAcceptedPanelTab) => void
    closeGuardRef?: RefObject<DesktopPanelCloseGuard | null>
    renderTab?: (tab: DesktopOverviewTab, registerCloseGuard: RegisterDesktopPanelCloseGuard) => ReactNode
}) {
    const visibility: DesktopOverviewVisibility = { installAuthor, publishedAccess }
    const identityKey = desktopOverviewIdentityKey(identity)
    const { register, requestClose } = useDesktopPanelCloseGuard(closeGuardRef)
    const [navigation, setNavigation] = useState(closedDesktopOverview)
    const [origin, setOrigin] = useState<CardOrigin | null>(null)
    const [focus, setFocus] = useState<DesktopOverviewControl>('services')
    useEffect(() => { setNavigation(closedDesktopOverview); setOrigin(null); setFocus('services') }, [identityKey])
    const box = resolveDesktopOverviewBox(agent.spaceId, boxes)
    const enabled = agent.enabled !== false
    const tab = navigation.tab ? shownDesktopOverviewTab(navigation.tab, visibility) : null
    const open = (destination: DesktopOverviewDestination, from: HTMLElement) => {
        if (destination !== 'settings' && !enabled) return
        if (destination === 'settings' && settingsDisabledReason) return
        let measured: CardOrigin | null = null
        try { measured = measureCardOrigin(destination, SHAPE[destination], from) } catch { measured = null }
        setOrigin(measured)
        setNavigation(openDesktopOverviewDestination(destination, visibility))
    }
    if (!validDesktopOverviewIdentity(identity) || identity.agentId !== agent.id) {
        return <p role="alert" className="p-4 text-sm text-destructive">This coworker’s owner is unavailable.</p>
    }
    if (phase === 'loading') return <div role="status" className="flex min-h-40 items-center justify-center p-4">{loadingSlot ?? <p className="text-sm text-muted-foreground">Loading this coworker…</p>}</div>
    if (phase === 'error') return <p role="alert" className="p-4 text-sm text-destructive">{error || 'This coworker could not be opened. Nothing was retried.'}</p>
    if (phase === 'empty' || box.status === 'unavailable') return <p role="status" className="p-4 text-sm text-muted-foreground">This coworker is not in this workspace.</p>
    const returnToCard = () => {
        setFocus(origin?.tab ?? focus)
        setNavigation(closedDesktopOverview)
        setOrigin(null)
    }
    const screen = tab && (
            <DesktopCoworkerOverviewScreen agentId={agent.id} name={agent.name} mood={enabled ? mood : 'asleep'} tab={tab} visibility={visibility} servicesNeedConfig={desktopOverviewServicesDot(servicesNeedConfig)} onTab={next => {
                if (next !== tab) requestClose(() => setNavigation(current => current.tab ? selectDesktopOverviewTab(current.tab, next, visibility) : current))
            }} onBack={() => requestClose(returnToCard)} onClose={() => requestClose(onClose)} onOpenAcceptedPanel={onOpenAcceptedPanel}>
            {renderTab?.(tab, register)}
        </DesktopCoworkerOverviewScreen>
    )
    return (
        <div data-side-panel-body className="relative flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={event => {
            if (event.key !== 'Escape' || event.defaultPrevented) return
            const target = event.target as HTMLElement
            if (target.closest('input, textarea, [role="dialog"], [role="alertdialog"]')) return
            event.preventDefault()
            requestClose(tab ? returnToCard : onClose)
        }}>
            <div className={tab ? 'invisible absolute inset-0 overflow-hidden' : 'min-h-0 flex-1'} aria-hidden={tab ? true : undefined}>
                <DesktopCoworkerOverviewCard identity={identity} name={agent.name} boxName={box.name} enabled={enabled} canManage={canManage} mood={enabled ? mood : 'asleep'} servicesNeedConfig={desktopOverviewServicesDot(servicesNeedConfig)} needsMachineReason={needsMachineReason} settingsDisabledReason={settingsDisabledReason} computerEnabled={computerEnabled} computer={computer} working={working} loadingSlot={loadingSlot} visible={!tab} focus={focus} onFocus={setFocus} onOpen={open} onClose={onClose} onShare={onShare} onDelete={onDelete} onOpenComputer={onOpenComputer} onRenamed={onRenamed} />
            </div>
            <AnimatePresence>
                {screen && origin && <AgentViewExpander key={origin.tab} origin={origin} ghost={<CardDestinationGhost tab={origin.tab} shape={origin.shape} />}>{screen}</AgentViewExpander>}
            </AnimatePresence>
            {screen && !origin && <div className="absolute inset-0 flex flex-col">{screen}</div>}
        </div>
    )
}
