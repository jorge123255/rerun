import { createHmac } from 'node:crypto'
import { sameOwner, sameIdentity, identity, UUID, refusal } from './protocol.mjs'
import { remoteAddress } from './network.mjs'
const scopeOf = (owner, connection) => ({ installId: owner.installId, workspaceId: owner.workspaceId, connectionId: connection.connectionId, revision: connection.revision,
    address: remoteAddress(connection.address), identity: connection.identity ? identity(connection.identity) : null, tlsPin: connection.tlsPin ?? null })
const sameScope = (a, b) => a && sameOwner(a, b) && a.connectionId === b.connectionId && a.revision === b.revision
    && a.address === b.address && a.tlsPin === b.tlsPin && (a.identity === null && b.identity === null || sameIdentity(a.identity, b.identity))
export function createSafeStorageCustody({ safeStorage, workspaceKey }) {
    if (!safeStorage || typeof workspaceKey !== 'function') throw refusal('authority_missing', 'Secure server credential storage is unavailable.', 'W1-R-CUSTODY')
    return {
        tag(owner, key) { return createHmac('sha256', workspaceKey(owner.workspaceId)).update(JSON.stringify(['remote-machine-key-v1', owner.installId, owner.workspaceId, key])).digest('hex') },
        async seal(owner, connection, key) {
            if (!safeStorage.isEncryptionAvailable()) throw refusal('unavailable', 'Mac secure storage is unavailable.')
            const scope = scopeOf(owner, connection)
            if (!UUID.test(scope.connectionId) || !UUID.test(scope.revision)) throw refusal('invalid', 'This server credential has no exact identity.')
            return safeStorage.encryptString(JSON.stringify({ version: 2, scope, key })).toString('base64')
        },
        async use(owner, connection, consume) {
            if (!safeStorage.isEncryptionAvailable()) throw refusal('unavailable', 'Mac secure storage is unavailable.')
            let value
            try { value = JSON.parse(safeStorage.decryptString(Buffer.from(connection.sealedKey, 'base64'))) }
            catch { throw refusal('unavailable', 'This saved server credential could not be opened.') }
            if (value.version !== 2 || !sameScope(value.scope, scopeOf(owner, connection))
                || typeof value.key !== 'string' || value.key.length < 16 || value.key.length > 4096 || /[^\x21-\x7e]/.test(value.key)) throw refusal('stale', 'This saved server credential belongs to another configuration.')
            try { return await consume(value.key) } finally { value.key = null }
        },
    }
}
