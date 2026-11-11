import type { ReactElement } from 'react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { messageTime } from '@rerun/i18n/format'

// Moving down the thread crosses one bubble after another: the time only comes up on a pause.
const HOVER_DELAY_MS = 400

export function MessageTimeTooltip({ createdAt, locale, side, children }: { createdAt?: string; locale?: string; side: 'left' | 'right'; children: ReactElement }) {
    if (!createdAt || !Number.isFinite(Date.parse(createdAt))) return children
    return (
        <TooltipProvider delayDuration={HOVER_DELAY_MS} skipDelayDuration={0}>
            <Tooltip>
                <TooltipTrigger asChild>{children}</TooltipTrigger>
                <TooltipContent side={side}>
                    <time dateTime={createdAt}>{messageTime(createdAt, locale)}</time>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    )
}
