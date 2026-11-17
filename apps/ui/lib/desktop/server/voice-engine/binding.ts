import 'server-only'
import { DESKTOP_SPEECH_KEY_PURPOSE } from '../../speech'
import { desktopAuxiliaryStore } from '../auxiliary/store'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { readDesktopSpeechSettings } from '../speech'
import { desktopVoiceChief } from './chief'
import { voiceEngineApi } from './elevenlabs'
import { createVoiceEngineService, type VoiceEngineService } from './service'
import { desktopVoiceEngineStore } from './store'

type Entry = { identity: string; value: Promise<VoiceEngineService> }
const KEY = Symbol.for('rerun.desktop.voice-engine.v1')
const slot = () => (globalThis as unknown as Record<symbol, { current?: Entry }>)[KEY] ??= {}
const identityOf = (runtime: DesktopRuntime) => JSON.stringify([runtime.dataRoot, String(runtime.workspaceId), runtime.launchNonce, runtime.app.origin])

async function create(runtime: DesktopRuntime) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const aux = desktopAuxiliaryStore(db)
    const service = createVoiceEngineService({
        store: desktopVoiceEngineStore(db),
        // The ElevenLabs key saved under Tool services for speech, through that store's own read path.
        async keyInfo() {
            const row = (await aux.list()).find(entry => entry.purpose === DESKTOP_SPEECH_KEY_PURPOSE)
            return { configured: !!row?.configured, revision: row?.revision ?? 'unconfigured' }
        },
        async readKey() {
            const saved = await aux.read(DESKTOP_SPEECH_KEY_PURPOSE)
            return saved.key ? { revision: saved.revision, key: saved.key } : null
        },
        voiceId: async () => (await readDesktopSpeechSettings(db, aux)).voiceId,
        api: voiceEngineApi(),
        chief: desktopVoiceChief(runtime),
    })
    await service.sync()
    return service
}

/** The voice service of this workspace's app. Making it connects to the relay only when the owner turned the feature on. */
export function desktopVoiceEngine(runtime: DesktopRuntime): Promise<VoiceEngineService> {
    const identity = identityOf(runtime), state = slot()
    if (state.current?.identity === identity) return state.current.value
    const previous = state.current
    const entry: Entry = {
        identity,
        value: (async () => {
            if (previous) (await previous.value.catch(() => null))?.close()
            return create(runtime)
        })(),
    }
    state.current = entry
    void entry.value.catch(() => { if (state.current === entry) state.current = undefined })
    return entry.value
}

/** Closes the relay connection on quit. Never creates the service. */
export async function shutdownDesktopVoiceEngine(runtime: DesktopRuntime) {
    const state = slot()
    if (state.current?.identity !== identityOf(runtime)) return
    const entry = state.current
    state.current = undefined
    ;(await entry.value.catch(() => null))?.close()
}
