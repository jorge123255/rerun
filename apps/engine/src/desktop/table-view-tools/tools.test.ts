import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TableView } from '@rerun/contracts'
import { desktopTableViewTools } from './tools'

const config = { current: null as any }
vi.mock('../agents/loader.js', () => ({ readAgentConfig: async () => config.current }))

const ctx = () => ({ agent: { id: 'agent-views', config: config.current }, abortSignal: new AbortController().signal }) as any
const view: TableView = { id: 'view-1', table: 'deals', name: 'Pipeline', position: 0, layout: 'table' }

beforeEach(() => {
    config.current = { enabled: true, tools: { desktopToolGrants: { db: true, sharedDb: true } }
})

function adapters() {
    const calls: string[] = []
    return {
        calls,
        save: async (_ctx: unknown, scope: string, input: Record<string, unknown>) => { calls.push(`save:${scope}:${input.name}`); return view },
        delete: async (_ctx: unknown, scope: string, table: string, name: string) => { calls.push(`delete:${scope}:${table}:${name}`); return true },
    }
}

describe('desktop table view tools', () => {
    it('registers nothing without the explicit view-write grant', () => {
        expect(desktopTableViewTools(ctx())).toEqual({})
    })

    it('requires the current view-write and matching scope grants at execution', async () => {
        const allowed = desktopTableViewTools(ctx(), () => true, adapters())
        config.current.tools.desktopToolGrants.db = false
        await expect((allowed.table_view_save as any).execute({ scope: 'agent', table: 'deals', name: 'Pipeline', layout: 'table' }, {})).rejects.toThrow('database is turned off')
        config.current.tools.desktopToolGrants.db = true
        config.current.enabled = false
        await expect((allowed.table_view_delete as any).execute({ scope: 'agent', table: 'deals', name: 'Pipeline' }, {})).rejects.toThrow('turned off')
    })

    it('uses the original save/delete result text and exact scope identity', async () => {
        const ports = adapters()
        const tools = desktopTableViewTools(ctx(), () => true, ports)
        expect(await (tools.table_view_save as any).execute({ scope: 'shared', table: 'deals', name: 'Pipeline', layout: 'table' }, {})).toContain('Saved the table view "Pipeline" on deals')
        expect(await (tools.table_view_delete as any).execute({ scope: 'agent', table: 'deals', name: 'Pipeline' }, {})).toBe('Deleted the view "Pipeline" of deals.')
        expect(ports.calls).toEqual(['save:shared:Pipeline', 'delete:agent:deals:Pipeline'])
    })

    it('preserves the original missing-view outcome without deleting rows', async () => {
        const ports = { ...adapters(), delete: async () => false }
        const tools = desktopTableViewTools(ctx(), () => true, ports)
        expect(await (tools.table_view_delete as any).execute({ scope: 'agent', table: 'deals', name: 'Ghost' }, {})).toBe('deals has no view named "Ghost".')
    })
})
