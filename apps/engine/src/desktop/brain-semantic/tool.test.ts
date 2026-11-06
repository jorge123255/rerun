import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBrainSemanticPorts } from '@rerun/contracts'

const config = vi.hoisted(() => ({ current: { enabled: true, tools: { brain: true, desktopToolGrants: { brain: true } } } }))
vi.mock('../../agents/loader.js', () => ({ readAgentConfig: vi.fn(async () => config.current) }))
vi.mock('../agent-lifecycle.js', () => ({ beginDesktopAgentWork: () => () => {}, assertDesktopAgentNotDeleted: vi.fn() }))

import { desktopBrainSemanticTools } from './tool'

function ports(): DesktopBrainSemanticPorts {
    return {
        pages: {
            list: vi.fn(async () => []),
            read: vi.fn(async () => null),
            search: vi.fn(async () => ({ hits: [], related: [] })),
        },
        embedding: { identity: vi.fn(() => null), embed: vi.fn() },
        store: {
            list: vi.fn(async () => []), write: vi.fn(), remove: vi.fn(), removePage: vi.fn(),
            pending: vi.fn(async () => []), queue: vi.fn(), removePending: vi.fn(),
        },
        authority: vi.fn(async () => {}),
    }
}

function ctx() {
    return { agent: { id: 'agent', config: config.current }, sessionId: 'session', runId: 'run', abortSignal: new AbortController().signal } as Parameters<typeof desktopBrainSemanticTools>[0]
}

beforeEach(() => { config.current.enabled = true; config.current.tools.desktopToolGrants.brain = true })

describe('desktop brain_search tool', () => {
    it('keeps an empty result distinct from unavailable semantic indexing', async () => {
        const tools = desktopBrainSemanticTools(ctx(), ports())
        const text = await (tools.brain_search as { execute: (input: unknown, options: unknown) => Promise<string> }).execute({ query: 'unknown' }, { toolCallId: 'tool', abortSignal: new AbortController().signal })
        expect(text).toContain('Nothing in the company brain matches')
        expect(text).toContain('Search mode: keyword-only')
    })

    it('returns no tool when the existing Brain grant is off', () => {
        config.current.tools.desktopToolGrants.brain = false
        expect(desktopBrainSemanticTools(ctx(), ports())).toEqual({})
    })
})
