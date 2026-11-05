import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopTemplatesClient } from './templates-client'

const draft = { templateId: 'template-1', revision: 'draft-revision' }
const plan = { planId: 'plan-1', revision: 'plan-revision', plans: [] }
const template = { ...draft, revision: 'saved-revision' }

afterEach(() => vi.unstubAllGlobals())

it('creates a draft before capture and retains its UUID after an unknown acknowledgement', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        if (bodies.length === 1) throw new Error('response lost')
        return Response.json(draft)
    }))
    const client = createDesktopTemplatesClient()

    await expect(client.createDraft('  Research team  ')).rejects.toThrow()
    await expect(client.createDraft('  Research team  ')).resolves.toEqual(draft)

    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({ action: 'create-draft', title: 'Research team' })
    expect(bodies[1]).toEqual(bodies[0])
    expect(String(bodies[0].requestId)).toMatch(/^[0-9a-f-]{36}$/)
    client.dispose()
})

it('pins planning and capture to the server-issued draft and plan revisions', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        calls.push({ url, body })
        if (body.action === 'plan') return Response.json(plan)
        return Response.json({ revision: 'captured-revision', captured: 1, warnings: [] })
    }))
    const client = createDesktopTemplatesClient()
    const selections = [{ agentRowId: 'coworker-1', exclude: ['notes/private.md'], setup: { required: false, prompt: '' } }]

    await client.plan(draft, { workspaceId: 'local', agentIds: ['coworker-1'] })
    await client.capture(draft, plan, selections)

    expect(calls[0]).toEqual({
        url: '/api/desktop/templates/template-1',
        body: { action: 'plan', requestId: calls[0].body.requestId, revision: 'draft-revision', workspaceId: 'local', agentIds: ['coworker-1'] },
    })
    expect(calls[1].body).toMatchObject({
        action: 'capture',
        revision: 'draft-revision',
        planId: 'plan-1',
        planRevision: 'plan-revision',
        selections,
    })
    expect(calls[1].url).toBe('/api/desktop/templates/template-1')
    client.dispose()
})

it('retries an ambiguous installation with one UUID and deliberately starts another for Use again', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        if (bodies.length === 1) throw new Error('response lost')
        return Response.json({ receiptId: `receipt-${bodies.length}`, coworkers: [] })
    }))
    const client = createDesktopTemplatesClient()

    await expect(client.install(template)).rejects.toThrow()
    await client.install(template)
    await client.install(template, { again: true })

    expect(bodies).toHaveLength(3)
    expect(bodies[0]).toMatchObject({ action: 'install', revision: 'saved-revision' })
    expect(bodies[1].requestId).toBe(bodies[0].requestId)
    expect(bodies[2].requestId).not.toBe(bodies[0].requestId)
    client.dispose()
})

it('resumes an interrupted installation with its original request UUID', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json({ receiptId: 'receipt-1', coworkers: [] })
    }))
    const client = createDesktopTemplatesClient()
    const requestId = '11111111-1111-4111-8111-111111111111'

    await client.install(template, { requestId })

    expect(bodies[0]).toMatchObject({ action: 'install', requestId, revision: 'saved-revision' })
    client.dispose()
})
