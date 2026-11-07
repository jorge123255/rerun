import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateText } from 'ai'
import { createCodexAppServer } from 'ai-sdk-provider-codex-cli'
import { expect, test, vi } from 'vitest'
import { agentConfigSchema, type LoadedAgent } from '../agents/types.js'
import { clearCachedEnvForTests } from '../config/env.js'
import { canonicalDesktopVisionModelPort } from './vision-tools/model.js'

async function writeCodexFixture(cwd: string) {
    const cli = join(cwd, 'codex')
    await writeFile(cli, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0) }
const send = value => console.log(JSON.stringify(value))
let thread
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const {id,method,params} = JSON.parse(line)
    if (id === undefined) return
    if (method === 'initialize') return send({id,result:{userAgent:'fixture'}})
    if (method === 'thread/start') {
        thread = params
        return send({id,result:{thread:{id:'image-thread'}}})
    }
    if (method !== 'turn/start') return send({id,result:{}})
    const turn = {id:'image-turn',items:[],status:'inProgress',error:null}
    send({id,result:{turn}})
    send({method:'item/completed',params:{threadId:'image-thread',turnId:turn.id,item:{id:'answer',type:'agentMessage',phase:'final_answer',text:JSON.stringify({input:params.input,thread})}}})
    send({method:'turn/completed',params:{threadId:'image-thread',turnId:turn.id,turn:{...turn,status:'completed'}}})
})
`, { mode: 0o700 })
    return cli
}

test('desktop Codex forwards frozen image bytes inline instead of inaccessible temporary paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rerun-codex-image-'))
    const cli = await writeCodexFixture(cwd)
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const provider = createCodexAppServer({ defaultSettings: { codexPath: cli, cwd } })
    const bytes = Buffer.from('fixture image bytes')
    const data = `data:image/png;base64,${bytes.toString('base64')}`
    try {
        const { stream } = await provider('fixture-model').doStream({
            prompt: [{ role: 'user', content: [
                { type: 'text', text: 'Describe both saved attachments.' },
                { type: 'file', data: bytes, mediaType: 'image/png' },
                { type: 'file', data: new URL(data), mediaType: 'image/png' },
            ] }],
        })
        const parts = []
        for await (const part of stream) parts.push(part)
        expect(parts.filter(part => part.type === 'error')).toEqual([])
        const answer = parts.filter(part => part.type === 'text-delta').map(part => part.delta).join('')
        const { input } = JSON.parse(answer)
        expect(input.filter((part: { type: string }) => part.type === 'image')).toEqual([
            { type: 'image', url: data }, { type: 'image', url: data },
        ])
        expect(input.some((part: { type: string }) => part.type === 'localImage')).toBe(false)
        expect(input.find((part: { type: string }) => part.type === 'text').text).toContain('Describe both saved attachments.')
    } finally {
        await provider.close()
        vi.unstubAllEnvs()
        await rm(cwd, { recursive: true, force: true })
    }
})

test('one-shot desktop Codex vision sends verified bytes on a read-only stateless thread', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rerun-codex-vision-'))
    try {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        vi.stubEnv('RERUN_DESKTOP_CODEX_RUNNER', await writeCodexFixture(cwd))
        vi.stubEnv('RERUN_DATA_DIR', cwd)
        clearCachedEnvForTests()
        const agent = {
            config: agentConfigSchema.parse({ name: 'viewer' }),
            resolved: { provider: 'codex', model: 'gpt-6.1-sol', connection: { id: 'mac-chatgpt', env: { RERUN_CHATGPT_CONNECTED: '1' } } },
        } as LoadedAgent
        const bytes = Buffer.from('fixture image bytes')
        const { text } = await generateText({
            model: canonicalDesktopVisionModelPort().modelFor(agent, undefined, 'vision-session'),
            messages: [{ role: 'user', content: [{ type: 'image', image: bytes, mediaType: 'image/png' }, { type: 'text', text: 'Describe the image.' }] }],
        })
        const { input, thread } = JSON.parse(text)
        expect(thread).toMatchObject({ model: agent.resolved.model, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true })
        expect(input.filter((part: { type: string }) => part.type !== 'text')).toEqual([
            { type: 'image', url: `data:image/png;base64,${bytes.toString('base64')}` },
        ])
    } finally {
        vi.unstubAllEnvs()
        clearCachedEnvForTests()
        await rm(cwd, { recursive: true, force: true })
    }
})
