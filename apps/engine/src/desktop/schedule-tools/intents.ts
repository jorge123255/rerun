import type { Client } from '@libsql/client'
import { DESKTOP_SCHEDULE_TOOL_SCHEMA_SQL } from './schema.js'
import type { DesktopScheduleIntent, DesktopScheduleIntentStore } from './types.js'

function intentOf(json: string, result: unknown): DesktopScheduleIntent {
    const parsed = JSON.parse(json) as DesktopScheduleIntent
    return { ...parsed, resultJson: result == null ? null : String(result) }
}

export function createDesktopScheduleIntentStore(getClient: (engineAgentId: string) => Promise<Client>): DesktopScheduleIntentStore {
    const ready = new Map<string, Promise<void>>()
    async function clientOf(engineAgentId: string): Promise<Client> {
        let opening = ready.get(engineAgentId)
        if (!opening) {
            opening = getClient(engineAgentId).then(async client => {
                await client.executeMultiple(DESKTOP_SCHEDULE_TOOL_SCHEMA_SQL)
            }).catch(error => {
                ready.delete(engineAgentId)
                throw error
            })
            ready.set(engineAgentId, opening)
        }
        await opening
        return getClient(engineAgentId)
    }
    return {
        async findIntent(engineAgentId, requestId) {
            const row = (await (await clientOf(engineAgentId)).execute({ sql: 'SELECT intent_json, result_json FROM desktop_schedule_tool_intents WHERE request_id=?', args: [requestId] })).rows[0]
            return row ? intentOf(String(row.intent_json), row.result_json) : null
        },
        async findPending(engineAgentId, slug) {
            const row = (await (await clientOf(engineAgentId)).execute({ sql: 'SELECT intent_json FROM desktop_schedule_tool_intents WHERE slug=? AND result_json IS NULL', args: [slug] })).rows[0]
            return row ? intentOf(String(row.intent_json), null) : null
        },
        async listPending(engineAgentId) {
            const rows = (await (await clientOf(engineAgentId)).execute('SELECT intent_json FROM desktop_schedule_tool_intents WHERE result_json IS NULL')).rows
            return rows.map(row => intentOf(String(row.intent_json), null))
        },
        async reserve(engineAgentId, intent) {
            await (await clientOf(engineAgentId)).execute({
                sql: 'INSERT INTO desktop_schedule_tool_intents(request_id, fingerprint, slug, intent_json, result_json) VALUES(?,?,?,?,NULL)',
                args: [intent.requestId, intent.fingerprint, intent.slug, JSON.stringify({ ...intent, resultJson: null })],
            })
        },
        async complete(engineAgentId, requestId, resultJson) {
            const client = await clientOf(engineAgentId)
            const updated = await client.execute({ sql: 'UPDATE desktop_schedule_tool_intents SET result_json=? WHERE request_id=? AND result_json IS NULL', args: [resultJson, requestId] })
            if (Number(updated.rowsAffected) === 1) return
            const existing = (await client.execute({ sql: 'SELECT result_json FROM desktop_schedule_tool_intents WHERE request_id=?', args: [requestId] })).rows[0]
            if (existing?.result_json != null) return
            throw new Error('Schedule receipt was not saved')
        },
    }
}
