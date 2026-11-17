import 'server-only'
import type { Client } from '@libsql/client'
import { desktopSidebarListSchema, desktopWorkspaceViewStateSchema, type DesktopSidebarList, type DesktopSidebarListChange, type DesktopWorkspaceViewChange, type DesktopWorkspaceViewState } from '../workspace-view'

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

export async function readDesktopSidebarList(db: Pick<Client, 'execute'>): Promise<DesktopSidebarList> {
    const collapsed = (await db.execute('SELECT box_id FROM desktop_sidebar_collapsed ORDER BY box_id')).rows.map(row => String(row.box_id))
    const rows = (await db.execute('SELECT kind,id,box_id,rank FROM desktop_sidebar_order')).rows
    return desktopSidebarListSchema.parse({
        collapsed,
        boxes: Object.fromEntries(rows.filter(row => row.kind === 'box').map(row => [String(row.id), Number(row.rank)])),
        agents: Object.fromEntries(rows.filter(row => row.kind === 'agent').map(row => [String(row.id), { box: String(row.box_id), rank: Number(row.rank) }])),
    })
}

const marks = (ids: readonly string[]) => ids.map(() => '?').join(',')

// One change is one transaction: a list is never left half renumbered.
export async function saveDesktopSidebarList(db: Client, change: DesktopSidebarListChange): Promise<DesktopSidebarList> {
    const upsert = `INSERT INTO desktop_sidebar_order(kind,id,box_id,rank) VALUES(?,?,?,?)
        ON CONFLICT(kind,id) DO UPDATE SET box_id=excluded.box_id,rank=excluded.rank`
    if (change.kind === 'collapsed') await db.batch([
        'DELETE FROM desktop_sidebar_collapsed',
        ...[...new Set(change.ids)].map(id => ({ sql: 'INSERT INTO desktop_sidebar_collapsed(box_id) VALUES(?)', args: [id] })),
    ], 'write')
    else if (change.kind === 'boxes') await db.batch(change.writes.map(write => ({ sql: upsert, args: ['box', write.id, null, write.order] })), 'write')
    else if (change.kind === 'agents') await db.batch(change.writes.map(write => ({ sql: upsert, args: ['agent', write.id, change.boxId, write.order] })), 'write')
    else {
        const statements = [
            ...(change.boxes.length ? [
                { sql: `DELETE FROM desktop_sidebar_collapsed WHERE box_id IN (${marks(change.boxes)})`, args: change.boxes },
                { sql: `DELETE FROM desktop_sidebar_order WHERE kind='box' AND id IN (${marks(change.boxes)})`, args: change.boxes },
            ] : []),
            ...(change.agents.length ? [{ sql: `DELETE FROM desktop_sidebar_order WHERE kind='agent' AND id IN (${marks(change.agents)})`, args: change.agents }] : []),
        ]
        if (statements.length) await db.batch(statements, 'write')
    }
    return readDesktopSidebarList(db)
}
