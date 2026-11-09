'use client'

import { DesktopHistoricalCardView } from '../../tool-presentations/DesktopHistoricalCardView'
import { DesktopHistoricalStepGroup } from '../../tool-presentations/DesktopHistoricalStepGroup'
import { foremanHistoryParts } from './parts'

/** Pure saved-parts presentation. No action callbacks, resource readers or live widgets. */
export function DesktopForemanHistoryMessage({ messageId, parts }: { messageId: string; parts: readonly unknown[] }) {
    return <div className="flex min-w-0 max-w-full flex-col gap-2 break-words">
        {foremanHistoryParts(messageId, parts).map(part => {
            switch (part.kind) {
                case 'text': return <div key={part.key} className="whitespace-pre-wrap break-words">{part.text}</div>
                case 'reasoning': return <details key={part.key} className="text-xs text-muted-foreground"><summary>Thinking</summary><p className="whitespace-pre-wrap break-words">{part.text}</p></details>
                case 'link': return <a key={part.key} href={part.url} target="_blank" rel="noopener noreferrer" className="break-all text-sm underline">{part.title}</a>
                case 'docs': return <div key={part.key} className="flex flex-col gap-1">{part.links.map((link, index) => <a key={`${index}:${link.url}`} href={link.url} target="_blank" rel="noopener noreferrer" className="break-all text-xs underline">{link.title}</a>)}</div>
                case 'card': return <DesktopHistoricalCardView key={part.key} card={part.card} />
                case 'tool': return <DesktopHistoricalStepGroup key={part.key} items={[part.item]} />
                case 'unknown': return <p key={part.key} className="text-xs text-muted-foreground" role="note">{part.label}</p>
            }
        })}
    </div>
}
