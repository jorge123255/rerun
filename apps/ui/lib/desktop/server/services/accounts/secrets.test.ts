import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { accountDigest } from './installs'
import { openStoredHeaderBundle, sealHeaderBundle } from './header-secret-codec'
import { DESKTOP_SERVICE_ACCOUNT_SCHEMA_SQL } from './schema'
import { memoryHeaderSecrets, secretWriteDecision } from './secret-store'
import { DESKTOP_SERVICE_ACCOUNT_MESSAGES as M } from '@rerun/contracts'

const key = Buffer.alloc(32, 9)
const token = 'fixture-header-value'
const bundle = { headers: { Authorization: `Bearer ${token}` }, inputs: { TOKEN: token } }

it('seals a header bundle for one owner, installation and revision', () => {
    const sealed = sealHeaderBundle(key, 'owner', 'install', 'rev-1', bundle)
    expect(sealed).not.toContain(token)
    expect(openStoredHeaderBundle(key, 'owner', 'install', 'rev-1', sealed)).toEqual(bundle)
    expect(() => openStoredHeaderBundle(key, 'owner', 'install', 'rev-2', sealed)).toThrow(M.secretConflict)
    expect(() => openStoredHeaderBundle(key, 'other', 'install', 'rev-1', sealed)).toThrow(M.secretConflict)
    try {
        openStoredHeaderBundle(key, 'owner', 'install', 'rev-1', `@@@${token}@@@`)
    } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe(M.secretConflict)
        expect((error as Error).message).not.toContain(token)
    }
})

it('decides secret writes without treating a missing row as a revision match', () => {
    expect(secretWriteDecision(null, { expectedRevision: null, revision: 'next', samePlaintext: false })).toBe('insert')
    expect(secretWriteDecision(null, { expectedRevision: 'old', revision: 'next', samePlaintext: false })).toBe('conflict')
    expect(secretWriteDecision({ revision: 'same' }, { expectedRevision: null, revision: 'same', samePlaintext: true })).toBe('unchanged')
    expect(secretWriteDecision({ revision: 'same' }, { expectedRevision: null, revision: 'same', samePlaintext: false })).toBe('conflict')
    expect(secretWriteDecision({ revision: 'old' }, { expectedRevision: 'old', revision: 'next', samePlaintext: false })).toBe('replace')
    expect(secretWriteDecision({ revision: 'other' }, { expectedRevision: 'old', revision: 'next', samePlaintext: false })).toBe('conflict')
})

it('keeps memory secrets scoped to owner, installation and revision', async () => {
    const secrets = memoryHeaderSecrets()
    await secrets.write({ owner: 'owner', installationId: 'install', expectedRevision: null, revision: 'rev-1', bundle })
    expect(await secrets.read('owner', 'install', 'rev-1')).toEqual(bundle)
    expect(await secrets.read('owner', 'install', 'rev-2')).toBeNull()
    await expect(secrets.write({ owner: 'owner', installationId: 'install', expectedRevision: 'rev-1', revision: 'rev-1', bundle: { headers: { Authorization: 'Bearer other-fixture-value' }, inputs: { TOKEN: 'other-fixture-value' } } })).rejects.toThrow(M.secretConflict)
    await secrets.write({ owner: 'owner', installationId: 'install', expectedRevision: 'rev-1', revision: 'rev-2', bundle })
    await secrets.remove('owner', 'install', 'rev-2')
    expect(await secrets.has('owner', 'install')).toBe(false)
    await secrets.remove('owner', 'install', 'rev-2')
})

it('canonicalizes fingerprints and describes only ciphertext columns', () => {
    const key = Buffer.alloc(32, 4)
    expect(accountDigest(key, 'owner', { b: 1, a: { d: true, c: 'x' } })).toBe(accountDigest(key, 'owner', { a: { c: 'x', d: true }, b: 1 }))
    expect(DESKTOP_SERVICE_ACCOUNT_SCHEMA_SQL).toContain('desktop_service_header_secrets')
    expect(DESKTOP_SERVICE_ACCOUNT_SCHEMA_SQL).toContain('desktop_service_account_mutations')
    expect(DESKTOP_SERVICE_ACCOUNT_SCHEMA_SQL).toContain('desktop_service_account_tombstones')
    expect(DESKTOP_SERVICE_ACCOUNT_SCHEMA_SQL).not.toContain(token)
})
