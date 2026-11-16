export type ScreenRefusalKind = 'refused' | 'stale' | 'closed' | 'prerequisite' | 'conflict'

export class IsolatedScreenRefusal extends Error {
    readonly kind: ScreenRefusalKind

    constructor(message: string, kind: ScreenRefusalKind) {
        super(message)
        this.name = 'IsolatedScreenRefusal'
        this.kind = kind
    }
}

/** A press on a web page that was not made: it waits for the person, they declined it, or it could not be checked. */
export class ScreenPressHeld extends IsolatedScreenRefusal {
    constructor(message: string) {
        super(message, 'refused')
        this.name = 'ScreenPressHeld'
    }
}

export function abortError(signal: AbortSignal): Error {
    if (signal.reason instanceof Error) return signal.reason
    return new DOMException('This operation was aborted', 'AbortError')
}

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
}

export function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortError(signal)
}
