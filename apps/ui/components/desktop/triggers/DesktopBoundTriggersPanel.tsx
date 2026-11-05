'use client'
import { useEffect, useState } from 'react'
import { desktopModelViewSchema } from '@/lib/desktop/chat-model'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import { unavailableTriggerRunModelCatalog, type DesktopTriggerRunModelCatalog } from '@/lib/desktop/triggers'
import { DesktopCoworkerTriggersPanel } from './DesktopCoworkerTriggersPanel'

export function DesktopBoundTriggersPanel({ agent, dialogControl, onOpenChat }: {
    agent: { id: string; name: string }; dialogControl?: DesktopDialogControl; onOpenChat: (id: string, title?: string) => void
}) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    const [catalog, setCatalog] = useState<DesktopTriggerRunModelCatalog>(() => unavailableTriggerRunModelCatalog())
    useEffect(() => {
        if (!open) return
        const controller = new AbortController()
        void (async () => {
            const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agent.id)}/model`, { cache: 'no-store', signal: controller.signal })
            if (!response.ok) throw new Error('Could not load models')
            const value = desktopModelViewSchema.parse(await response.json())
            if (!controller.signal.aborted) setCatalog({ available: value.catalog.length > 0, agentModelLabel: value.effective.available ? value.effective.label : null,
                availableGroups: value.catalog.map(group => ({ connectionId: group.connectionId, provider: group.provider, label: group.name, models: group.models })) })
        })().catch(() => { if (!controller.signal.aborted) setCatalog(unavailableTriggerRunModelCatalog()) })
        return () => controller.abort()
    }, [agent.id, open])
    return <DesktopCoworkerTriggersPanel agent={agent} dialogControl={{ open, onOpenChange: setOpen }} onOpenChat={onOpenChat} ingressAvailable modelCatalog={catalog} />
}
