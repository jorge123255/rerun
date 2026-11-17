import type { TakeoverResult } from '@rerun/contracts'

// The chat waits on the screen it opened: the desktop page settles the wait when the person hands
// the browser back, with the page it was left on and whether its window is still on the screen.
const waiting = new Map<string, (result: TakeoverResult) => void>()

export function awaitHandBack(callId: string): Promise<TakeoverResult> {
    return new Promise(resolve => waiting.set(callId, resolve))
}

export function handBack(callId: string, result: TakeoverResult) {
    waiting.get(callId)?.(result)
    waiting.delete(callId)
}
