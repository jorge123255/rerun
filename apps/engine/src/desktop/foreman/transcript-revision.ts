import { createHash } from 'node:crypto'
import type { DesktopForemanChatRef } from '@rerun/contracts'

type TranscriptMessage = {
    id: string; role: string; contentJson: string; toolCallsJson?: string | null; sourcesJson?: string | null;
    createdAt: string; authorId?: string | null; authorName?: string | null;
}

/** Use the stored message order for both the renderer snapshot and the engine's effect boundary. */
export function foremanTranscriptRevision(chat: DesktopForemanChatRef, sessionId: string, messages: Iterable<TranscriptMessage>) {
    const revision = createHash('sha256')
    revision.update(JSON.stringify(['foreman-transcript-v1', chat.workspaceId, chat.chatId, sessionId]))
    for (const row of messages) {
        revision.update(JSON.stringify([row.id, row.role, row.contentJson, row.toolCallsJson ?? null,
            row.sourcesJson ?? null, row.createdAt, row.authorId ?? null, row.authorName ?? null]))
    }
    return revision.digest('hex')
}
