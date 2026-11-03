import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexAppServer } from 'ai-sdk-provider-codex-cli'
import { expect, test, vi } from 'vitest'

test('desktop Codex forwards the requested effort and emits only marked public summaries', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rerun-codex-stream-'))
    const cli = join(cwd, 'codex')
    await writeFile(cli, `#!/usr/bin/env node
const { createInterface } = require('node:readline')
const send = message => console.log(JSON.stringify(message))
const threadId = 'fixture-thread'
createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line)
    if (id === undefined) return
    const respond = result => send({ id, result })
    if (method === 'initialize') return respond({ userAgent: 'codex-cli/0.166.0' })
    if (method === 'thread/start' || method === 'thread/resume') return respond({ thread: { id: threadId } })
    if (method !== 'turn/start') return respond({})
    const turn = { id: 'fixture-turn', items: [], status: 'inProgress', error: null }
    respond({ turn })
    const notify = (event, value) => send({ method: event, params: { threadId, turnId: turn.id, ...value } })
    const raw = 'synthetic private marker'
    notify('item/reasoning/textDelta', { itemId: 'streamed', delta: raw })
    notify('item/reasoning/summaryTextDelta', { itemId: 'streamed', delta: 'Public summary.' })
    notify('item/completed', { item: { id: 'streamed', type: 'reasoning', summary: ['Public summary.'], content: [raw] } })
    notify('item/reasoning/textDelta', { itemId: 'final-only', delta: raw })
    notify('item/completed', { item: { id: 'final-only', type: 'reasoning', summary: ['Final summary.'], content: [raw] } })
    notify('item/completed', { item: { id: 'private-only', type: 'reasoning', summary: [], content: [raw] } })
    notify('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Applied ' + params.effort } })
    notify('turn/completed', { turn: { ...turn, status: 'completed' } })
})
`, { mode: 0o700 })
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const provider = createCodexAppServer({ defaultSettings: { codexPath: cli, cwd } })
    try {
        const { stream } = await provider('fixture-model').doStream({
            prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
            providerOptions: { 'codex-app-server': { threadId: 'fixture-thread', effort: 'catalog-advertised' } },
            includeRawChunks: true,
        })
        const parts = []
        const reader = stream.getReader()
        for (;;) {
            const result = await reader.read()
            if (result.done) break
            parts.push(result.value)
        }
        const reasoning = parts.filter(part => part.type === 'reasoning-start' || part.type === 'reasoning-delta' || part.type === 'reasoning-end')
        expect(reasoning.map(part => part.type)).toEqual([
            'reasoning-start', 'reasoning-delta', 'reasoning-end', 'reasoning-start', 'reasoning-delta', 'reasoning-end',
        ])
        for (const part of reasoning) expect(part.providerMetadata?.['codex-app-server']?.isPublicSummary).toBe(true)
        expect(reasoning.filter(part => part.type === 'reasoning-delta').map(part => part.delta)).toEqual(['Public summary.', 'Final summary.'])
        expect(parts).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: 'Applied catalog-advertised' }))
        expect(parts.some(part => part.type === 'raw')).toBe(false)
        expect(JSON.stringify(parts)).not.toContain('synthetic private marker')
    } finally {
        await provider.close()
        vi.unstubAllEnvs()
        await rm(cwd, { recursive: true, force: true })
    }
})

test.each([false, true])('Code Mode grant %s negotiates only its public tool events and pairs each result once', async enabled => {
    const cwd = await mkdtemp(join(tmpdir(), 'rerun-codex-code-mode-'))
    const cli = join(cwd, 'codex')
    await writeFile(cli, `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin })
const send = message => console.log(JSON.stringify(message))
const threadId = 'fixture-thread', turnId = 'fixture-turn'
let rawRequested
rl.on('line', line => {
    const { id, method, params } = JSON.parse(line)
    if (id === undefined) return
    const respond = result => send({ id, result })
    if (method === 'initialize') return respond({ userAgent: 'codex-cli/0.166.0' })
    if (method === 'thread/start') {
        rawRequested = params.experimentalRawEvents
        return respond({ thread: { id: threadId } })
    }
    if (method !== 'turn/start') return respond({})
    const turn = { id: turnId, items: [], status: 'inProgress', error: null }
    respond({ turn })
    const notify = (method, fields, target = turnId) => send({ method, params: { threadId, turnId: target, ...fields } })
    const raw = (item, target) => notify('rawResponseItem/completed', {item}, target)
    const call = {type: 'custom_tool_call', id: 'native-item', call_id: 'call-1', namespace: 'functions', name: 'exec', input: 'text(6*7)'}
    const result = {type: 'custom_tool_call_output', id: 'native-result', call_id: 'call-1', output: [{type: 'input_text', text: '42'}]}
    raw({type: 'message', role: 'developer', content: 'synthetic private marker'})
    raw({...call, call_id:'other-turn'}, 'other-turn')
    raw({...result, call_id:'orphan'})
    raw({...call, name:'unrelated', call_id:'unrelated'})
    raw(call); raw(call); raw(result); raw(result); raw(call)
    notify('item/completed', {item:{type:'agentMessage', id:'answer', phase:'final_answer', text:'Raw requested: '+rawRequested}})
    notify('turn/completed', {turn:{...turn, status:'completed'}})
})
`, { mode: 0o755 })
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const provider = createCodexAppServer({ defaultSettings: {
        codexPath: cli, cwd, configOverrides: { 'features.code_mode.enabled': enabled },
    } })
    try {
        const { stream } = await provider('fixture').doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Calculate.' }] }] })
        const reader = stream.getReader()
        const parts = []
        for (;;) {
            const result = await reader.read()
            if (result.done) break
            parts.push(result.value)
        }
        expect(parts.filter(p => p.type === 'tool-call')).toEqual(enabled ? [
            expect.objectContaining({ toolName: 'functions.exec', toolCallId: 'call-1', input: '{"code":"text(6*7)"}', providerExecuted: true }),
        ] : [])
        expect(parts.filter(p => p.type === 'tool-result')).toEqual(enabled ? [
            expect.objectContaining({ toolName: 'functions.exec', toolCallId: 'call-1', result: '42' }),
        ] : [])
        expect(parts).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: 'Raw requested: '+enabled }))
        expect(parts.some(p => p.type === 'raw')).toBe(false)
        expect(JSON.stringify(parts)).not.toContain('synthetic private marker')
    } finally {
        await provider.close()
        vi.unstubAllEnvs()
        await rm(cwd, { recursive: true, force: true })
    }
})
