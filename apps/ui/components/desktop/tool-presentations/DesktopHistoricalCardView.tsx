'use client'

import { DesktopHistoricalBrainChange } from './DesktopHistoricalBrainChange'
import { DesktopHistoricalMcpOutcome } from './DesktopHistoricalMcpOutcome'
import { DesktopHistoricalNotification } from './DesktopHistoricalNotification'
import type { DesktopHistoricalCard } from './select'

export function DesktopHistoricalCardView({ card, onOpenBrain }: {
    card: DesktopHistoricalCard
    /** Local navigation only. The package never calls brain revert or a tool. */
    onOpenBrain?: () => void
}) {
    switch (card.kind) {
        case 'notification':
            return <DesktopHistoricalNotification message={card.message} identity={card.identity} toolCallId={card.toolCallId} />
        case 'mcp':
            return <DesktopHistoricalMcpOutcome name={card.name} host={card.host} outcome={card.outcome} failure={card.failure} identity={card.identity} toolCallId={card.toolCallId} />
        case 'brain-change':
            return <DesktopHistoricalBrainChange headline={card.headline} note={card.note} brainStatus={card.brainStatus} identity={card.identity} toolCallId={card.toolCallId} onOpen={card.showOpen ? onOpenBrain : undefined} />
    }
}
