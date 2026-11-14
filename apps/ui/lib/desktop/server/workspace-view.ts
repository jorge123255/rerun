import 'server-only'
import type { Client } from '@libsql/client'
import { desktopWorkspaceViewStateSchema, type DesktopWorkspaceViewChange, type DesktopWorkspaceViewState } from '../workspace-view'

export async function readDesktopWorkspaceView(db: Pick<Client, 'execute'>): Promise<DesktopWorkspaceViewState> {
    const row = (await db.execute('SELECT view,last_opened FROM desktop_workspace_view WHERE workspace_id=1')).rows[0]
    return desktopWorkspaceViewStateSchema.parse({ view: row?.view ?? null, lastOpened: row?.last_opened ?? null })
}

// Each field is written on its own: choosing a view never forgets the coworker open last.
export async function saveDesktopWorkspaceView(db: Client, change: DesktopWorkspaceViewChange): Promise<DesktopWorkspaceViewState> {
    await db.execute({
        sql: `INSERT INTO desktop_workspace_view(workspace_id,view,last_opened) VALUES(1,?,?)
            ON CONFLICT(workspace_id) DO UPDATE SET view=COALESCE(excluded.view,view),last_opened=COALESCE(excluded.last_opened,last_opened)`,
        args: [change.view ?? null, change.lastOpened ?? null],
    })
    return readDesktopWorkspaceView(db)
}
