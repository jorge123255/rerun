'use client'

import type { ReactNode } from 'react'
import { DeleteCoworkerConfirmation } from './DeleteCoworkerConfirmation'
import { useBoardStore } from '@/stores/board.store'

type DeleteAgentDialogProps = {
    agentId: string
    agentName?: string
    children?: ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
}

export function DeleteAgentDialog({ agentId, ...props }: DeleteAgentDialogProps) {
    const removeAgent = useBoardStore(s => s.removeAgent)
    const selectAgent = useBoardStore(s => s.selectAgent)
    return <DeleteCoworkerConfirmation {...props} onDelete={() => {
        removeAgent(agentId)
        selectAgent(null)
    }} />
}
