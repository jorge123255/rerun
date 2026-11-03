import { createClient } from '@libsql/client'
import { resolve } from 'node:path'

export async function seedRecordedToolFixture(dataRoot, agentId, sessionId) {
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error('Invalid fixture agent ID')
    const db = createClient({ url: `file:${resolve(dataRoot, 'workspaces/1/engine/agents', agentId, 'data/system.db')}` })
    const runId = 'fixture-recorded-tools'
    const now = new Date().toISOString()
    try {
        await db.batch([
            { sql: 'INSERT INTO runs (id,agent_id,session_id,status,step_count,provider,model,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?)',
                args: [runId, agentId, sessionId, 'done', 1, 'fixture', 'Synthetic saved telemetry', now, now] },
            { sql: 'INSERT INTO run_steps (id,run_id,agent_id,session_id,step_number,finish_reason,tool_call_count,text_length,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
                args: ['fixture-step', runId, agentId, sessionId, 1, 'tool-calls', 2, 0, 0, now] },
            ...[
                ['fixture-ok', 1, 'fixture_lookup', 0, '{"answer":"Recorded fixture answer"}'],
                ['fixture-failed', 1, 'fixture_failed_lookup', 1, '{"error":"Recorded fixture failure"}'],
                ['fixture-incomplete', 2, 'fixture_incomplete_lookup', 0, null],
            ].map(([id, step, name, isError, result]) => ({
                sql: 'INSERT INTO tool_calls (id,run_id,agent_id,session_id,step_number,tool_name,result_json,is_error,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
                args: [id, runId, agentId, sessionId, step, name, result, isError, 0, now],
            })),
        ], 'write')
    } finally { db.close() }
    return runId
}
