import { requestRecordingPermissionsAsync } from 'expo-audio'

import { ApiError, macHub } from '@/api/client'
import { yieldAudio } from '@/lib/audio-yield'
import { onLeavingMac } from '@/mac/session'

import { loadElevenLabsEngine } from './engine'
import { watchInterruptions } from './interruptions'
import type { VoiceDeps } from './useVoiceSession'

// A voice conversation on the paired Mac: the token comes from the Mac's `voice/start`, the Mac is
// read through the hub (which sends a removed phone back to sign in), and the session is ElevenLabs'.
export const macVoiceDeps: VoiceDeps = {
    requestSession: (chatId, signal) => {
        if (!macHub) return Promise.reject(new ApiError(404, 'not_found'))
        return macHub.startVoice(chatId, signal)
    },
    loadEngine: loadElevenLabsEngine,
    requestMicrophone: async () => (await requestRecordingPermissionsAsync()).granted,
    yieldAudio,
    checkPairing: signal => (macHub ? macHub.api('/api/chat/foreman/state', { signal }) : Promise.resolve()),
    watchInterruptions,
    onLeavingMac,
}
