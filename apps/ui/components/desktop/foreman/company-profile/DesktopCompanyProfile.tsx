'use client'

import { useEffect, useMemo, type MutableRefObject } from 'react'
import type { DesktopCompanyProfileCorrection, DesktopForemanChatRef } from '@rerun/contracts'
import { createDesktopCompanyProfileClient, type DesktopCompanyProfileClient } from '@/lib/desktop/company-profile/client'
import { useDesktopCompanyProfile, type DesktopCompanyProfileController } from '@/lib/desktop/company-profile/use-desktop-company-profile'
import { DesktopCompanyProfileBoardPreview } from './DesktopCompanyProfileBoardPreview'
import { DesktopCompanyProfileStatus } from './DesktopCompanyProfileStatus'

export function DesktopCompanyProfile({ chat, client: suppliedClient, active, emptyWorkspace, onboarding, draftRevision, compact = false, controllerRef, onCorrection }: {
    chat: DesktopForemanChatRef
    client?: DesktopCompanyProfileClient
    active: boolean
    emptyWorkspace: boolean
    onboarding: boolean
    draftRevision: number
    compact?: boolean
    controllerRef?: MutableRefObject<DesktopCompanyProfileController | null>
    onCorrection?: (correction: DesktopCompanyProfileCorrection) => void
}) {
    const client = useMemo(() => suppliedClient ?? createDesktopCompanyProfileClient(), [suppliedClient])
    const flow = useDesktopCompanyProfile({ chat, client, active, draftRevision })
    useEffect(() => {
        if (controllerRef) controllerRef.current = flow
        return () => { if (controllerRef) controllerRef.current = null }
    }, [controllerRef, flow])
    const scope = useMemo(() => ({ workspaceId: chat.workspaceId, chatId: chat.chatId, active, emptyWorkspace, onboarding }), [chat.workspaceId, chat.chatId, active, emptyWorkspace, onboarding])
    return <div className="pointer-events-none absolute inset-0 z-10">
        <DesktopCompanyProfileBoardPreview scope={scope} view={flow.view} compact={compact} />
        <DesktopCompanyProfileStatus
            attempts={[flow.view?.decision ?? null, flow.view?.enrichment ?? null]}
            error={flow.error}
            onRetry={kind => { if (kind === 'decide') void flow.decide(); else void flow.enrich(true) }}
            onStop={kind => { void flow.stop(kind) }}
            onCorrection={onCorrection}
            onRefresh={() => { void flow.read() }}
        />
    </div>
}
