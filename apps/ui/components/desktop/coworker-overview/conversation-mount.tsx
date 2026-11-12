'use client'

import { useLayoutEffect, useRef } from 'react'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { sameDesktopOverviewIdentity, validDesktopOverviewIdentity } from '@/lib/desktop/coworker-overview/identity'
import { DesktopCoworkerOverviewRootMount, type DesktopCoworkerOverviewRootMountProps } from './root-mount'

export type DesktopConversationOverviewAuthority = Pick<DesktopCoworkerOverviewRootMountProps,
    'identity' | 'boxes' | 'canManage' | 'onRenamed' | 'onShare' | 'onDelete' | 'installAuthor' |
    'servicesNeedConfig' | 'computerEnabled' | 'computer' | 'onOpenComputer'> & {
    onRename?: (identity: DesktopCoworkerOverviewRootMountProps['identity'], name: string) => Promise<void>
}

type Props = {
    authority: DesktopConversationOverviewAuthority
    agent: DesktopCoworkerOverviewRootMountProps['agent']
    active: boolean
    working: boolean
    settingsDisabledReason: string | null
    closeControl?: DesktopCoworkerOverviewRootMountProps['closeControl']
    onClose(): void
    onOpenSession: NonNullable<DesktopCoworkerOverviewRootMountProps['onOpenSession']>
    onOpenAcceptedPanel: NonNullable<DesktopCoworkerOverviewRootMountProps['onOpenAcceptedPanel']>
}

export function DesktopConversationOverview(props: Props) {
    const latest = useRef(props)
    latest.current = props
    const live = useRef(true)
    useLayoutEffect(() => { live.current = true; return () => { live.current = false } }, [])
    const identity = props.authority.identity
    const current = () => live.current && latest.current.active && !isDesktopQuitting() &&
        latest.current.agent.id === identity.agentId &&
        sameDesktopOverviewIdentity(identity, latest.current.authority.identity)
    if (!validDesktopOverviewIdentity(identity) || identity.agentId !== props.agent.id) {
        return <p role="alert" className="p-4 text-sm text-destructive">This coworker’s owner is unavailable.</p>
    }
    return <DesktopCoworkerOverviewRootMount
        {...props.authority}
        agent={props.agent}
        working={props.working}
        settingsDisabledReason={props.settingsDisabledReason}
        publishedAccess={false}
        closeControl={props.closeControl}
        onClose={() => { if (current()) latest.current.onClose() }}
        onRenamed={(source, name) => { if (current() && sameDesktopOverviewIdentity(source, identity)) latest.current.authority.onRenamed(source, name) }}
        onOpenSession={(id, title) => { if (current()) latest.current.onOpenSession(id, title) }}
        onOpenAcceptedPanel={tab => { if (current()) latest.current.onOpenAcceptedPanel(tab) }}
        onShare={props.authority.onShare ? () => { if (current()) latest.current.authority.onShare?.() } : undefined}
        onDelete={props.authority.onDelete ? (source, name) => { if (current() && sameDesktopOverviewIdentity(source, identity)) return latest.current.authority.onDelete?.(source, name) } : undefined}
        onOpenComputer={props.authority.onOpenComputer ? () => { if (current()) latest.current.authority.onOpenComputer?.() } : undefined}
    />
}
