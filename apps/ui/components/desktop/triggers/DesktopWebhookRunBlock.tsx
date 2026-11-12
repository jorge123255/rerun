'use client'

import { ThreadDividerDialog } from '@/components/chat/ThreadDividerDialog'
import { ThreadDividerDot, ThreadDividerLine, ThreadDividerLink } from '@/components/chat/ThreadDividerLine'
import { DesktopTriggerPayloadDetails, DesktopTriggerPayloadSummary } from '@/components/desktop/triggers/DesktopTriggerPayloadBlock'
import { WebhookIcon } from '@/lib/icons'
import { type TriggerPayload } from '@/lib/desktop/triggers'
import { useState } from 'react'
import { DesktopWorkspaceMessage, type DesktopOpenWorkspaceFile } from '../DesktopWorkspaceMessage'

type OpenDialog = 'prompt' | 'payload' | null

// The webhook speaks, not the user: a divider marks where it fired, with its prompt and what the
// caller sent each one click away.
export function DesktopWebhookRunBlock({ agentId, payload, onOpenWorkspaceFile }: {
    agentId?: string
    payload: TriggerPayload
    onOpenWorkspaceFile?: DesktopOpenWorkspaceFile
}) {
    const [openDialog, setOpenDialog] = useState<OpenDialog>(null)
    const icon = <WebhookIcon className="size-3.5 text-muted-foreground" />
    const closeOn = (dialog: Exclude<OpenDialog, null>) => (open: boolean) => setOpenDialog(open ? dialog : null)

    return (
        <>
            <ThreadDividerLine icon={<WebhookIcon className="size-3.5" />}>
                Webhook received
                <ThreadDividerDot />
                <span className="min-w-0 truncate font-medium text-foreground">{payload.slug}</span>
                {payload.prompt && (
                    <>
                        <ThreadDividerDot />
                        <ThreadDividerLink onClick={() => setOpenDialog('prompt')}>View prompt</ThreadDividerLink>
                    </>
                )}
                <ThreadDividerDot />
                <ThreadDividerLink onClick={() => setOpenDialog('payload')}>View payload</ThreadDividerLink>
            </ThreadDividerLine>
            <ThreadDividerDialog open={openDialog === 'prompt'} onOpenChange={closeOn('prompt')} icon={icon} title={`${payload.slug} prompt`}>
                <DesktopWorkspaceMessage agentId={agentId} onOpenWorkspaceFile={onOpenWorkspaceFile}>{payload.prompt ?? ''}</DesktopWorkspaceMessage>
            </ThreadDividerDialog>
            <ThreadDividerDialog
                open={openDialog === 'payload'}
                onOpenChange={closeOn('payload')}
                icon={icon}
                title={`${payload.slug} payload`}
                aside={
                    <span className="flex shrink-0 items-center gap-2">
                        <DesktopTriggerPayloadSummary payload={payload} />
                    </span>
                }
            >
                <DesktopTriggerPayloadDetails payload={payload} bodyClassName="max-h-none bg-muted" />
            </ThreadDividerDialog>
        </>
    )
}
