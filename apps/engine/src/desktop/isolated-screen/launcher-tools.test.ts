import { agentConfigSchema } from '@rerun/contracts'
import type { z } from 'zod'
import { expect, it } from 'vitest'
import type { RunContext } from '../../runtime/context.js'
import { isolatedScreenTools } from './tools.js'

const context = (grants: Record<string, boolean>) => ({ agent: { id: 'launcher-fixture', config: agentConfigSchema.parse({ name: 'Launcher fixture', tools: { desktopToolGrants: grants } }) }, provider: 'codex', sessionId: 'session', runId: 'run', abortSignal: new AbortController().signal }) as RunContext
it('exposes computer/open_app for an independent launcher while withholding browser-only tools', () => {
    for (const grant of ['terminalLaunch', 'filesLaunch']) {
        const { tools, release } = isolatedScreenTools(context({ computer: true, [grant]: true }))
        expect(Object.keys(tools).sort()).toEqual(['computer', 'computer_open_app'])
        release()
    }
    expect(Object.keys(isolatedScreenTools(context({ terminalLaunch: true })).tools)).toEqual([])
    expect(Object.keys(isolatedScreenTools(context({ computer: true })).tools)).toEqual([])
})
it('keeps a root object schema for Codex, and rejects URL/path/command fields for isolated launchers', () => {
    const { tools } = isolatedScreenTools(context({ computer: true, browser: true, terminalLaunch: true, filesLaunch: true }))
    const schema = tools.computer_open_app!.inputSchema as z.ZodType
    expect(schema.safeParse({ app: 'browser', url: 'https://example.com' }).success).toBe(true)
    expect(schema.safeParse({ app: 'terminal' }).success).toBe(true)
    expect(schema.safeParse({ app: 'files' }).success).toBe(true)
    for (const app of ['terminal', 'files']) {
        for (const key of ['url', 'path', 'command', 'args', 'environment']) expect(schema.safeParse({ app, [key]: 'https://example.com' }).success).toBe(false)
        expect(schema.safeParse({ app, url: undefined }).success).toBe(false)
    }
})
