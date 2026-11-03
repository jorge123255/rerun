import type { ModelMessage, StepResult, ToolSet } from 'ai'
import { desktopSourceParts, type DesktopSourcePart } from '@rerun/contracts'

type Step = Pick<StepResult<ToolSet>, 'sources'> & { response: { messages: ModelMessage[] } }
type TranscriptRow = { message: ModelMessage; sources?: DesktopSourcePart[] }

// Each step reports cumulative model messages. Sources belong to the single assistant row
// in that step. A citation-only step has no model message, so give it a display-only row.
export function desktopSourceRows(messages: ModelMessage[], steps: readonly Step[]): TranscriptRow[] {
    const rows: TranscriptRow[] = []
    let start = 0
    for (const step of steps) {
        const end = step.response.messages.length
        const sources = desktopSourceParts(step.sources.map(source => ({ ...source, type: `source-${source.sourceType}`, sourceId: source.id })))
        const stepMessages = messages.slice(start, end)
        if (sources.length && !stepMessages.some(message => message.role === 'assistant')) {
            rows.push({ message: { role: 'assistant', content: [] }, sources })
        }
        for (const message of stepMessages) {
            rows.push({ message, ...(message.role === 'assistant' && sources.length ? { sources } : {}) })
        }
        start = end
    }
    for (const message of messages.slice(start)) rows.push({ message })
    return rows
}
