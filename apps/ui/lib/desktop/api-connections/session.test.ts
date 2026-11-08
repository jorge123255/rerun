import { expect, test, vi } from 'vitest'
import { ApiConnectionsSession } from './session'
import { apiFixture, catalogFixture, connectionFixture, planFixture, resultFixture, FIXTURE_REQUEST_ID } from './fixtures'
import { removalConsequences, apiEndpointDisplay } from './presentation'

test('same-provider siblings remain independently selectable by exact ID and revision', async () => {
    const catalog = catalogFixture(), api = apiFixture(catalog), select = vi.spyOn(api, 'select')
    const session = new ApiConnectionsSession(1, api, () => 1); await session.refresh()
    expect(session.snapshot().catalog?.default?.connectionId).toBe('codex-existing')
    const second = catalog.connections[1]
    await session.execute({ kind: 'select', input: { requestId: FIXTURE_REQUEST_ID, workspaceId: 1, connectionId: second.connectionId,
        expectedRevision: second.revision, model: second.models[0], source: 'workspace', runId: 'fixture-selection', sessionId: 'fixture-settings' } })
    expect(select.mock.calls[0][0].connectionId).toBe(second.connectionId)
    expect(select.mock.calls[0][0].expectedRevision).toBe(second.revision)
    session.navigate({ kind: 'detail', connectionId: second.connectionId })
    expect(session.connection(second.connectionId)?.name).toBe(second.name)
})
test('stale connection forms and stale workspace results cannot change the current selection', async () => {
    const catalog = catalogFixture(), api = apiFixture(catalog), rename = vi.spyOn(api, 'rename')
    let current: number | null = 1
    const session = new ApiConnectionsSession(1, api, () => current); await session.refresh()
    session.navigate({ kind: 'detail', connectionId: catalog.connections[1].connectionId })
    await session.execute({ kind: 'rename', input: { requestId: FIXTURE_REQUEST_ID, workspaceId: 1, connectionId: catalog.connections[0].connectionId, expectedRevision: catalog.connections[0].revision, name: 'Wrong sibling' } })
    expect(rename).not.toHaveBeenCalled()
    let resolve!: (value: ReturnType<typeof catalogFixture>) => void
    api.list = async () => new Promise(done => { resolve = done })
    const read = session.refresh(); current = 2; resolve({ ...catalog, connections: [] }); await read
    expect(session.snapshot().catalog?.connections).toHaveLength(2)
    expect(session.snapshot().page).toEqual({ kind: 'detail', connectionId: catalog.connections[1].connectionId })
})
test('Cancel and suspension retain private drafts; uncertain writes retry the identical request only', async () => {
    const catalog = catalogFixture(), api = apiFixture(catalog), session = new ApiConnectionsSession(1, api, () => 1)
    await session.refresh(); session.navigate({ kind: 'add', provider: 'openai' })
    session.draft('add:openai', { name: 'My connection' }); session.changeDraft('add:openai', { secret: 'offline-fixture-value' })
    session.navigate({ kind: 'list' }); session.suspend(); session.navigate({ kind: 'add', provider: 'openai' })
    expect(session.draft('add:openai').secret).toBe('offline-fixture-value')
    const create = vi.spyOn(api, 'create').mockImplementationOnce(async () => { throw Error('Lost ACK') })
    const input = { requestId: FIXTURE_REQUEST_ID, workspaceId: 1, provider: 'openai' as const, name: 'My connection', secret: 'offline-fixture-value', models: ['gpt-fixture'], extraModels: [] }
    await session.execute({ kind: 'create', input })
    expect(session.snapshot().uncertain?.requestId).toBe(FIXTURE_REQUEST_ID)
    expect(JSON.stringify(session.snapshot())).not.toContain(input.secret)
    expect(await session.execute({ kind: 'create', input: { ...input, requestId: crypto.randomUUID() } })).toBeNull()
    await session.retry()
    expect(create.mock.calls[1][0]).toEqual(create.mock.calls[0][0])
    session.close(); expect(session.draft('add:openai').secret).toBe('')
})
test('dirty revision remains bound to the edited connection and requires explicit revision review', async () => {
    const catalog = catalogFixture(), api = apiFixture(catalog), session = new ApiConnectionsSession(1, api, () => 1)
    await session.refresh()
    const old = catalog.connections[0], draftKey = `key:${old.connectionId}`
    session.navigate({ kind: 'detail', connectionId: old.connectionId })
    session.draft(draftKey, { revision: old.revision }); session.changeDraft(draftKey, { secret: 'offline-fixture' })
    const next = connectionFixture('one', { revision: 'rev_fixture-newer' }); api.list = async () => ({ ...catalog, connections: [next, catalog.connections[1]] })
    await session.refresh(); expect(session.draft(draftKey, { revision: next.revision }).revision).toBe(old.revision)
    const update = vi.spyOn(api, 'credential')
    await session.execute({ kind: 'credential', input: { requestId: FIXTURE_REQUEST_ID, workspaceId: 1, connectionId: old.connectionId, expectedRevision: old.revision, secret: 'offline-fixture' } })
    expect(update).not.toHaveBeenCalled()
    session.reviewDraftRevision(draftKey, next)
    expect(session.draft(draftKey).secret).toBe('offline-fixture')
    expect(session.draft(draftKey).revision).toBe(next.revision)
})
test('a changed consequence review requires another human confirmation and never removes on Cancel', async () => {
    const catalog = catalogFixture(), api = apiFixture(catalog), session = new ApiConnectionsSession(1, api, () => 1)
    await session.refresh(); session.navigate({ kind: 'detail', connectionId: catalog.connections[0].connectionId })
    const remove = vi.spyOn(api, 'remove'), controller = new AbortController(), reviewed = await session.review(catalog.connections[0], controller.signal)
    api.removalPlan = async () => ({ ...reviewed, usage: { ...reviewed.usage, isBoxDefault: false } })
    expect(await session.removeReviewed(catalog.connections[0], reviewed, controller.signal)).toHaveProperty('changed')
    expect(remove).not.toHaveBeenCalled()
    controller.abort(); await expect(session.review(catalog.connections[0], controller.signal)).rejects.toThrow()
    expect(remove).not.toHaveBeenCalled()
    const warning = removalConsequences(planFixture()).join(' ')
    expect(warning).toContain('Writer (coworker-a)'); expect(warning).toContain('Schedule daily (coworker-a)')
    expect(warning).toContain('saved default will be cleared'); expect(warning).toContain(connectionFixture('two').connectionId)
})
test('pending runs or missing removal authority are displayed and cannot be removed', async () => {
    const catalog = catalogFixture(), api = apiFixture(catalog), session = new ApiConnectionsSession(1, api, () => 1)
    await session.refresh(); session.navigate({ kind: 'detail', connectionId: catalog.connections[0].connectionId })
    const blocked = { ...planFixture(), canRemove: false, reason: 'Stop the pending runs before removing this connection.',
        pendingRuns: [{ runId: 'fixture-run', sessionId: 'fixture-chat', connectionId: catalog.connections[0].connectionId, connectionRevision: catalog.connections[0].revision, status: 'stopping' as const }] }
    api.removalPlan = async () => blocked
    const remove = vi.spyOn(api, 'remove')
    const plan = await session.review(catalog.connections[0], new AbortController().signal)
    expect(removalConsequences(plan).join(' ')).toContain('fixture-run, chat fixture-chat: stopping')
    expect(await session.removeReviewed(catalog.connections[0], plan, new AbortController().signal)).toHaveProperty('changed')
    expect(remove).not.toHaveBeenCalled()
})
test('late mutation after suspension cannot publish over a resumed exact-request retry', async () => {
    const catalog = catalogFixture(), api = apiFixture(catalog), session = new ApiConnectionsSession(1, api, () => 1)
    await session.refresh(); session.navigate({ kind: 'add', provider: 'openai' })
    let resolve!: (value: ReturnType<typeof resultFixture>) => void
    api.create = async () => new Promise(done => { resolve = done })
    const operation = { kind: 'create' as const, input: { requestId: FIXTURE_REQUEST_ID, workspaceId: 1, provider: 'openai' as const, name: 'Fixture', models: [], extraModels: [], secret: 'fixture-only' } }
    const write = session.execute(operation); session.suspend()
    resolve(resultFixture(operation, { ...catalog, connections: [] })); await write
    expect(session.snapshot().catalog?.connections).toHaveLength(2)
    expect(session.snapshot().uncertain?.requestId).toBe(FIXTURE_REQUEST_ID)
    expect(apiEndpointDisplay('https://username:password@example.invalid/path?secret=fixture#private')).toBe('https://example.invalid')
})
