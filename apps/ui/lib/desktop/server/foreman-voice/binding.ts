import 'server-only'
import type { DesktopRuntime } from '../runtime'
import { desktopForeman } from '../foreman/binding'
import { createForemanVoiceRuntime, canonicalForemanVoiceSend } from './runtime'

type Entry = { identity: string; value: Promise<ReturnType<typeof createForemanVoiceRuntime>> }
let current: Entry | undefined
const identityOf = (runtime: DesktopRuntime) => JSON.stringify([runtime.dataRoot, String(runtime.workspaceId), runtime.launchNonce, runtime.app.origin, runtime.engine.origin])
export function desktopForemanVoice(runtime: DesktopRuntime, shutdownSignal: AbortSignal) {
    const identity = identityOf(runtime)
    if (current?.identity === identity) return current.value
    const previous = current
    const entry = { identity, value: undefined as unknown as Entry['value'] }
    current = entry
    entry.value = (async () => {
        if (previous) await (await previous.value).close()
        const foreman = await desktopForeman(runtime)
        return createForemanVoiceRuntime(runtime, foreman.db, { isCurrent: () => current === entry, shutdownSignal, send: canonicalForemanVoiceSend(foreman) })
    })()
    void entry.value.catch(() => { if (current === entry) current = undefined })
    return entry.value
}
/** Does not create a voice runtime, chat, provider request or microphone during shutdown. */
export async function shutdownDesktopForemanVoice(runtime: DesktopRuntime) {
    if (current?.identity === identityOf(runtime)) await (await current.value).close()
}
