// Why a voice conversation with the Chief of Staff could not start or did not last, in the words the
// screen shows (mobileAuth `mac.chief.voice.problems`).
export type VoiceProblem =
    // The Mac answers `not_found`: its "talk from your phone" switch is off, or it is a Mac older than voice.
    | 'notSetUp'
    // `unavailable`: the Mac's voice relay is not connected, or the voice service turned the Mac down.
    | 'unavailable'
    // `send_not_allowed`: the person did not let this phone send messages.
    | 'notAllowed'
    // `rate_limited`: a few conversations a minute per phone.
    | 'rateLimited'
    // The person said no to the microphone.
    | 'microphone'
    // The voice connection dropped while talking.
    | 'dropped'
    // The Mac could not be reached, at the start or while talking.
    | 'unreachable'
    // The Mac removed this phone.
    | 'removed'
    // The voice session itself would not start.
    | 'failed'

// What the Mac's refusal says, read from the code it answers with and, failing that, its status.
export function voiceProblemOf(error: unknown): VoiceProblem {
    const { status, message } = (error ?? {}) as { status?: number; message?: string }
    if (message === 'not_found' || status === 404) return 'notSetUp'
    if (message === 'unavailable' || status === 503) return 'unavailable'
    if (message === 'send_not_allowed') return 'notAllowed'
    if (message === 'rate_limited' || status === 429) return 'rateLimited'
    if (status === 401) return 'removed'
    return 'unreachable'
}

// Asking again changes nothing until the person changes something on the Mac.
export function canRetry(problem: VoiceProblem): boolean {
    return problem !== 'notSetUp' && problem !== 'notAllowed' && problem !== 'removed'
}
