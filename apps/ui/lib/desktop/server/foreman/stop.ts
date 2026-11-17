import 'server-only'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { cancelCompanyBriefChat } from '../company-brief/client'
import { desktopForemanVoice } from '../foreman-voice/binding'
import type { DesktopRuntime } from '../runtime'
import type { desktopForeman } from './binding'

/** What the Stop button does to a Chief of Staff conversation. */
export async function stopDesktopForemanChat(runtime: DesktopRuntime, app: Awaited<ReturnType<typeof desktopForeman>>, chat: DesktopForemanChatRef) {
    await cancelCompanyBriefChat(runtime, chat)
    await (await desktopForemanVoice(runtime, app.voiceShutdownSignal)).cancelChat(chat)
    await app.stop(chat)
}
