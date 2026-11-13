'use client'

import { useState } from 'react'
import { ThreadDividerDialog } from '@/components/chat/ThreadDividerDialog'
import { ThreadDividerDot, ThreadDividerLine, ThreadDividerLink } from '@/components/chat/ThreadDividerLine'
import { Box3Icon, CheckCircle2Icon } from '@/lib/icons'
import { useDesktopLocale } from '../DesktopLocale'
import { DesktopWorkspaceMessage, type DesktopOpenWorkspaceFile } from '../DesktopWorkspaceMessage'

export function DesktopInstallBlock({ agentId, agentName, guide, installing = false, onOpenWorkspaceFile }: {
    agentId?: string
    agentName: string
    guide: string
    installing?: boolean
    onOpenWorkspaceFile?: DesktopOpenWorkspaceFile
}) {
    const { t } = useDesktopLocale()
    const [guideOpen, setGuideOpen] = useState(false)
    return <>
        <ThreadDividerLine flowing={installing} icon={installing ? <Box3Icon className="size-3.5" /> : <CheckCircle2Icon className="size-3.5 text-emerald-500" />}>
            {t(installing ? 'coworkerSetup.install.started' : 'coworkerSetup.install.complete')}
            <ThreadDividerDot />
            <ThreadDividerLink onClick={() => setGuideOpen(true)}>{t('coworkerSetup.install.viewGuide')}</ThreadDividerLink>
        </ThreadDividerLine>
        <ThreadDividerDialog open={guideOpen} onOpenChange={setGuideOpen} icon={<Box3Icon className="size-3.5 text-muted-foreground" />} title={t('coworkerSetup.install.guideTitle', { name: agentName })}>
            <DesktopWorkspaceMessage agentId={agentId} onOpenWorkspaceFile={onOpenWorkspaceFile}>{guide}</DesktopWorkspaceMessage>
        </ThreadDividerDialog>
    </>
}
