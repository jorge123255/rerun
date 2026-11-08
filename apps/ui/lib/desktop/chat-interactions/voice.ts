import { alignedTranscriptWords, type VoiceTranscriptAlignment } from '../../../../../packages/contracts/src/voice'
import { sameInteraction, type ChatInteractionIdentity } from './identity'
export type SavedVoiceAlignment = {
    identity: ChatInteractionIdentity; src: string; alignment: VoiceTranscriptAlignment
}
export function savedVoiceWords(identity: ChatInteractionIdentity, src: string, transcript: string, durationMs: number, metadata?: SavedVoiceAlignment | null) {
    return metadata && sameInteraction(identity, metadata.identity) && metadata.src === src
        ? alignedTranscriptWords(transcript, durationMs, metadata.alignment) : null
}

/** Same ordinary, human-activated plain-text Copy path as the accepted desktop assistant reply. */
export function copyTranscriptText(text: string, isCurrent: () => boolean): void {
    if (!isCurrent() || window.top !== window || !navigator.userActivation?.isActive) throw Error('Copy requires the current message and an active user gesture.')
    let written = false
    const onCopy = (event: ClipboardEvent) => {
        event.preventDefault()
        if (!isCurrent() || !event.clipboardData) return
        event.clipboardData.setData('text/plain', text); written = true
    }
    document.addEventListener('copy', onCopy, { once: true })
    try { if (!document.execCommand('copy') || !written) throw Error('Could not copy this transcript.') }
    finally { document.removeEventListener('copy', onCopy) }
}
