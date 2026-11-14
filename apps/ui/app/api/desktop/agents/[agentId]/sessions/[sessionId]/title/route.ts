import { CONVERSATION_TITLE_MAX } from '@rerun/contracts'
import { z } from 'zod'
import { conversationSearchKey } from '@/lib/desktop/chat-search'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

const input = z.strictObject({ title: z.string().trim().min(1).max(CONVERSATION_TITLE_MAX).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u) })

export function PATCH(request: Request, { params }: { params: Promise<{ agentId: string; sessionId: string }> }) {
    return desktopRoute(request, async runtime => {
        const { agentId, sessionId } = await params
        const parsed = input.safeParse(await readDesktopJson(request, 4096))
        if (!parsed.success) throw new DesktopHttpError(400, 'Enter a valid conversation name.')
        const db = await openDesktopDatabase(runtime.dataRoot)
        const { title } = parsed.data
        request.signal.throwIfAborted()
        assertDesktopWorkspaceAdmission(runtime)
        const updated = await db.execute({
            sql: `UPDATE desktop_sessions SET title=?, title_search=?, title_edited=1
                WHERE id=? AND agent_id=? AND kind='thread'
                    AND EXISTS(SELECT 1 FROM desktop_agents WHERE id=? AND workspace_id=1)
                    AND NOT EXISTS(SELECT 1 FROM desktop_deletions WHERE agent_id=?)
                RETURNING id, title`,
            args: [title, conversationSearchKey(title), sessionId, agentId, agentId, agentId],
        })
        const row = updated.rows[0]
        if (!row) throw new DesktopHttpError(404, 'This thread cannot be renamed.')
        return Response.json({ id: String(row.id), title: String(row.title) }, { headers: { 'cache-control': 'no-store' } })
    })
}
