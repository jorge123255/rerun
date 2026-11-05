import { expect, test } from 'vitest'
import { createServiceRequestRetryJournal, type ServiceRequestRetryStorage } from './retry-journal'

function memoryStorage(): ServiceRequestRetryStorage {
    const rows = new Map<string, string>()
    return { getItem: key => rows.get(key) ?? null, setItem: (key, value) => { rows.set(key, value) }, removeItem: key => { rows.delete(key) } }
}

const intent = { requestId: 'fixture-id', choices: ['skip'], expectedRevision: 'card-revision' }
function parse(value: unknown): typeof intent {
    if (!value || typeof value !== 'object' || !('requestId' in value) || !('choices' in value) || !('expectedRevision' in value)) throw new Error('Invalid fixture')
    return value as typeof intent
}

test('restores the same immutable attempt across a client restart and clears only its exact acknowledgement', () => {
    const storage = memoryStorage()
    createServiceRequestRetryJournal(storage, 'owner/source', parse).save(intent)
    const restarted = createServiceRequestRetryJournal(storage, 'owner/source', parse)
    expect(restarted.read()).toEqual(intent)
    restarted.acknowledge({ ...intent, requestId: 'another-id' })
    expect(restarted.read()).toEqual(intent)
    restarted.acknowledge(intent)
    expect(restarted.read()).toBeNull()
})

test('never overwrites unknown decisions or reads another source scope', () => {
    const storage = memoryStorage()
    const journal = createServiceRequestRetryJournal(storage, 'owner/source', parse)
    journal.save(intent)
    expect(() => journal.save({ ...intent, choices: ['use-connection'] })).toThrow('Retry the saved')
    expect(createServiceRequestRetryJournal(storage, 'another-owner/source', parse).read()).toBeNull()
    expect(journal.read()).toEqual(intent)
})

test('refuses corrupt or unavailable storage without treating it as empty state', () => {
    const storage = memoryStorage()
    storage.setItem('key', '{')
    expect(() => createServiceRequestRetryJournal(storage, 'key', parse).read()).toThrow('could not be read')
    expect(() => createServiceRequestRetryJournal({ ...storage, setItem() { throw new Error('unavailable') } }, 'new', parse).save(intent)).toThrow('unavailable')
})
