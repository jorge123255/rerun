import { foremanChatRefSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { ownedForemanChat } from '@/lib/desktop/server/foreman/chat-store'
import { foremanSharedCatalogAccounts } from '@/lib/desktop/server/foreman/shared-app-catalog'
import { desktopRoute } from '@/lib/desktop/server/http'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const dynamic = 'force-dynamic'

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const params = new URL(request.url).searchParams
        const parsed = foremanChatRefSchema.safeParse({ workspaceId: params.get('workspaceId'), chatId: params.get('chatId') })
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose the current Chief of Staff conversation.')
        const chat = parsed.data
        if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Foreman conversation not found.')
        assertDesktopWorkspaceAdmission(runtime)
        const db = await openDesktopDatabase(runtime.dataRoot)
        await ownedForemanChat(db, chat)
        // The Chief has no coworker row. Only the workspace-wide share grants it an account.
        const { rows } = await db.execute(`
            SELECT id, catalog_name AS name, catalog_label AS label
            FROM desktop_vault_mcp_servers AS s
            WHERE ${foremanSharedCatalogAccounts} AND catalog_name IS NOT NULL
            ORDER BY COALESCE(catalog_label, catalog_name) COLLATE NOCASE, id
        `)
        assertDesktopWorkspaceAdmission(runtime)
        const apps = rows.map(({ id, name, label }) => ({ id, name, label }))
        return Response.json({ chat, apps }, { headers: { 'cache-control': 'no-store' } })
    })
}
