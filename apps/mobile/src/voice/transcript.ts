export type VoiceLine = { from: 'you' | 'chief'; text: string; eventId: number; responseId?: string }
export type PartialCaption = { text: string; eventId: number }

export type Transcript = { lines: VoiceLine[]; partial: PartialCaption | null; finalUserEvent: number; awaitingReply: boolean }
export const emptyTranscript: Transcript = { lines: [], partial: null, finalUserEvent: -1, awaitingReply: false }

export type TranscriptAction =
    | { type: 'partial'; caption: PartialCaption }
    | { type: 'line' | 'correction'; line: VoiceLine }
    | { type: 'discardPartial' }
    | { type: 'speaking' }
    | { type: 'reset' }

// The speech engine may resend a response or correct the words it actually spoke after an interruption.
// Event numbers are scoped to one call; user and agent messages may share a number.
export function transcriptReducer(state: Transcript, action: TranscriptAction): Transcript {
    if (action.type === 'reset') return emptyTranscript
    if (action.type === 'speaking') return state.awaitingReply ? { ...state, awaitingReply: false } : state
    if (action.type === 'discardPartial') return state.partial ? { ...state, partial: null } : state
    if (action.type === 'partial') {
        const { caption } = action
        if (caption.eventId <= state.finalUserEvent || (state.partial && caption.eventId < state.partial.eventId)) return state
        return { ...state, partial: caption.text ? caption : null }
    }
    const { line } = action
    const index = state.lines.findIndex(row => {
        if (row.from !== line.from) return false
        if (row.responseId && line.responseId) return row.responseId === line.responseId
        return row.eventId === line.eventId
    })
    if (action.type === 'correction' && index === -1) return state
    const lines = state.lines.slice()
    if (line.text) {
        if (index === -1) lines.push(line)
        else lines[index] = line
    } else if (index !== -1) {
        lines.splice(index, 1)
    }
    if (line.from !== 'you') {
        const newReply = index === -1 && line.text.length > 0
        return { ...state, lines, awaitingReply: !newReply && state.awaitingReply }
    }
    return {
        lines,
        awaitingReply: state.awaitingReply || (line.text.length > 0 && line.eventId > state.finalUserEvent),
        finalUserEvent: Math.max(line.eventId, state.finalUserEvent),
        partial: state.partial && state.partial.eventId > line.eventId ? state.partial : null,
    }
}
