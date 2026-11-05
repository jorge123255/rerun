'use client'

import type { TableCard } from '@rerun/contracts'
import { useRef, useState } from 'react'
import type { DataFocus } from '@/lib/data/source'
import { desktopTableCardOf } from '@/lib/desktop/table-card'
import type { DesktopAgentView } from './DesktopApp'
import { DesktopCoworkerData } from './DesktopCoworkerData'
import { DesktopSharedData } from './DesktopSharedData'
import { DesktopTableCard } from './DesktopTableCard'

/** The transcript supplies the owner; a recorded card may only choose private versus shared. */
export function DesktopTableResult({ card, agent }: { card: TableCard; agent?: DesktopAgentView }) {
    const safe = desktopTableCardOf(card)
    if (!safe) return null
    return <TableResultTarget key={JSON.stringify([agent?.id, safe.scope, safe.table, safe.view])} card={safe} agent={agent} />
}

function TableResultTarget({ card, agent }: { card: TableCard; agent?: DesktopAgentView }) {
    const [focus, setFocus] = useState<DataFocus | null>(null)
    const element = useRef<HTMLDivElement>(null)
    const onCloseAutoFocus = (event: Event) => {
        event.preventDefault()
        const button = [...(element.current?.querySelectorAll<HTMLButtonElement>('[data-desktop-table-card] button') ?? [])]
            .find(button => button.textContent?.trim() === 'Open database')
        button?.focus()
    }
    const dialogControl = { open: focus !== null, onOpenChange: (open: boolean) => { if (!open) setFocus(null) } }
    return <div ref={element}>
        <DesktopTableCard card={card} agentId={agent?.id} onOpen={agent ? setFocus : undefined} />
        {agent && focus && (card.scope === 'shared'
            ? <DesktopSharedData hideTrigger dialogControl={dialogControl} initial={focus} requireInitialView onCloseAutoFocus={onCloseAutoFocus} />
            : <DesktopCoworkerData agent={agent} hideTrigger dialogControl={dialogControl} initial={focus} requireInitialView onCloseAutoFocus={onCloseAutoFocus} />)}
    </div>
}
