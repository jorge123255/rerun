import { z } from 'zod'
import { desktopBrowserPress, type DesktopBrowserPress } from '@rerun/contracts'
import { desktopInternalJson } from '../internal-client.js'
import { ScreenPressHeld } from './refusal.js'
import type { ScreenPressGate } from './types.js'

/**
 * Asks the person before a coworker presses a button in its browser that sends, posts, pays,
 * deletes or changes a credential (packages/contracts/src/desktop-browser-approvals.ts).
 *
 * The engine reads the control and decides whether it asks; the app keeps the request, shows the
 * card and records the answer, exactly as it does for a connector call. A press that waits, was
 * declined, or could not be checked is never made: the gate throws and the screen is not touched.
 */
const reply = z.union([
    z.object({ ok: z.literal(true) }).strict(),
    z.object({ ok: z.literal(false), reason: z.string().min(1).max(900) }).strict(),
])

export type PressIdentity = { engineAgentId: string; sessionId: string; runId: string }
export type PressAsk = (request: { identity: PressIdentity; press: DesktopBrowserPress }, signal: AbortSignal) => Promise<{ ok: true } | { ok: false; reason: string }>

export const askPressThroughApp: PressAsk = async (request, stop) => {
    const signal = AbortSignal.any([stop, AbortSignal.timeout(30_000)])
    const result = reply.parse(await desktopInternalJson('/api/desktop/internal/browser-press', request, signal, 4096))
    signal.throwIfAborted()
    return result
}

export const PRESS_NEEDS_RUN = 'Rerun asks the person before a press like this one, and that needs a current chat run. Nothing was pressed.'
export const PRESS_UNCHECKED = 'Rerun could not ask the person about this press, so nothing was pressed. Tell them, and try again later.'

export function createPressGate(options: {
    identity: PressIdentity | null
    /** The coworker's Extra vigilant switch, read when the press is about to be made. */
    vigilant: (signal: AbortSignal) => Promise<boolean>
    ask?: PressAsk
}): ScreenPressGate {
    const ask = options.ask ?? askPressThroughApp
    return async ({ trigger, probe }, signal) => {
        const press = desktopBrowserPress(probe, trigger, await options.vigilant(signal))
        signal.throwIfAborted()
        if (!press) return 'free'
        if (!options.identity) throw new ScreenPressHeld(PRESS_NEEDS_RUN)
        let answer: Awaited<ReturnType<PressAsk>>
        try { answer = await ask({ identity: options.identity, press }, signal) }
        catch (error) {
            signal.throwIfAborted()
            // Not asked is not allowed.
            throw new ScreenPressHeld(PRESS_UNCHECKED)
        }
        signal.throwIfAborted()
        if (!answer.ok) throw new ScreenPressHeld(answer.reason)
        return 'allowed'
    }
}
