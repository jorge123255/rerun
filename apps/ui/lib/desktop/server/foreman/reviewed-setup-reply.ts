import 'server-only'
import { createHash } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import type { DesktopRuntime } from '../runtime'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import { ownedForemanChat } from './chat-store'
import { applyChiefSetupReply } from './setup-coordination'
import { readDesktopTeamChanges } from './team-changes'

// One engine request per approved line, including after a disconnect or a cold restart.
function requestIdFor(chat: DesktopForemanChatRef, cardId: string, lineKey: string) {
    const bytes = createHash('sha256').update(JSON.stringify(['chief-setup-reply', chat.workspaceId, chat.chatId, cardId, lineKey])).digest()
    bytes[6] = (bytes[6]! & 0x0f) | 0x80
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = bytes.toString('hex', 0, 16)
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export async function applySavedChiefSetupReply(runtime: DesktopRuntime, db: Client, chat: DesktopForemanChatRef, cardId: string, lineKey: string, signal: AbortSignal) {
    if (String(runtime.workspaceId) !== chat.workspaceId) throw new DesktopHttpError(404, 'Conversation not found.')
    const currentLine = async () => {
        assertDesktopWorkspaceAdmission(runtime)
        await ownedForemanChat(db, chat)
        const card = await readDesktopTeamChanges(db, chat)
        const line = card?.changes.find(change => change.key === lineKey)
        if (!card || card.id !== cardId || card.state !== 'shown' || line?.action !== 'reply_setup' || !line.agentId || !line.setupReply) {
            throw new DesktopHttpError(409, 'This setup reply is no longer available. Review the current proposal.')
        }
        return { agentId: line.agentId, reply: line.setupReply }
    }
    const { agentId, reply } = await currentLine()
    await applyChiefSetupReply(runtime, db, chat, agentId, reply, requestIdFor(chat, cardId, lineKey), signal, async () => { await currentLine() })
}
