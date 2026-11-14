import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import type { DesktopRuntime } from '../runtime'

export function foremanAlternateSnapshot(runtime: DesktopRuntime, chat: DesktopForemanChatRef, sessionId: string, revision: string) {
    return createHmac('sha256', runtime.engine.apiKey)
        .update(JSON.stringify(['foreman-rendered-history-v1', chat.workspaceId, chat.chatId, sessionId, revision]))
        .digest('hex')
}

export function matchesForemanAlternateSnapshot(actual: string, expected: string) {
    return actual.length === expected.length && timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'))
}
