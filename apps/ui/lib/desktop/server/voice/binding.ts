import 'server-only'

import { DesktopHttpError } from '../auth'
import type { DesktopVoiceService } from './service'

const state = globalThis as typeof globalThis & { desktopVoiceService?: DesktopVoiceService }

export function bindDesktopVoiceService(service: DesktopVoiceService): void {
    if (state.desktopVoiceService) throw new Error('Desktop voice authority is already bound')
    state.desktopVoiceService = service
}

export function desktopVoiceService(): DesktopVoiceService {
    if (!state.desktopVoiceService) throw new DesktopHttpError(503, 'Voice messaging is not configured on this Mac.')
    return state.desktopVoiceService
}
