import { createHash } from 'node:crypto'
export const VERSION = 1
export const LIMITS = Object.freeze({ addressBytes: 2048, keyBytes: 4096, responseBytes: 131072, requestBytes: 16384, requestMs: 10000, operationMs: 60000, cleanupMs: 5000, addresses: 8, receipts: 128 })
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const validWorkspace = id => Number.isSafeInteger(id) && id > 0 && id <= 1000000
export const sameIdentity = (a, b) => !!a && !!b && a.protocolVersion === b.protocolVersion && a.machineId === b.machineId && a.workspaceId === b.workspaceId
export const sameOwner = (a, b) => a.installId === b.installId && a.workspaceId === b.workspaceId
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function refusal(code, message, authority) { return Object.assign(new Error(message), { code, ...(authority ? { authority } : {}) }) }
export const missing = authority => refusal('authority_missing', 'This remote-machine capability is not connected to the desktop lifecycle.', authority)
export function actor(value) {
    if (!value || !UUID.test(value.installId) || !validWorkspace(value.workspaceId) || !UUID.test(value.launchNonce) || !UUID.test(value.rendererEpoch)
        || Object.keys(value).some(k => !['installId', 'workspaceId', 'launchNonce', 'rendererEpoch'].includes(k))) throw refusal('invalid', 'This workspace instance is not current.')
    return value
}
export function identity(value) {
    if (!value || value.protocolVersion !== 1 || !UUID.test(value.machineId) || !validWorkspace(value.workspaceId)
        || Object.keys(value).some(k => !['protocolVersion', 'machineId', 'workspaceId'].includes(k))) throw refusal('unsupported', 'This server does not provide a verifiable workspace identity.')
    return value
}
export function command(value) {
    actor(value?.actor)
    if (!UUID.test(value.requestId)) throw refusal('invalid', 'This server request is not valid.')
    const fields = ['action', 'actor', 'requestId']
    if (['pair', 'replace', 'select', 'remove', 'health'].includes(value.action)) {
        fields.push('connectionId', 'expectedRevision')
        if (!UUID.test(value.connectionId) || (value.action === 'pair' ? value.expectedRevision !== 'unconfigured' : !UUID.test(value.expectedRevision))) throw refusal('invalid', 'Refresh the exact server before changing it.')
        if (['pair', 'replace'].includes(value.action)) {
            fields.push('address', 'apiKey')
            if (typeof value.address !== 'string' || value.address.length > LIMITS.addressBytes || typeof value.apiKey !== 'string'
                || value.apiKey.length < 16 || Buffer.byteLength(value.apiKey) > LIMITS.keyBytes || /[^\x21-\x7e]/.test(value.apiKey)) throw refusal('invalid', 'Enter the address and the key of the server.')
        }
        if (value.action === 'remove') { fields.push('confirmation'); if (value.confirmation !== 'Remove') throw refusal('invalid', 'Confirm Remove for this exact server.') }
    } else if (value.action === 'recover') { fields.push('resume', 'expectedReceiptRevision'); if (value.resume !== true || !UUID.test(value.expectedReceiptRevision)) throw refusal('invalid', 'Explicitly confirm resuming this server change.')
    } else if (!['read', 'reconcile', 'receipt', 'cancel'].includes(value.action)) throw refusal('invalid', 'This server request was not understood.')
    if (Object.keys(value).some(k => !fields.includes(k))) throw refusal('invalid', 'This server request was not understood.')
    return value
}
export const emptyHealth = () => ({ state: 'not_checked', checkedAt: null, commit: null, activeAgents: null, reason: null })
export function publicConnection(record) {
    if (!record) return null
    return { connectionId: record.connectionId, revision: record.revision, workspaceId: record.workspaceId, address: record.address,
        identity: record.identity, credentialConfigured: true, removable: true,
        health: Object.fromEntries(['state', 'checkedAt', 'commit', 'activeAgents', 'reason'].map(k => [k, record.health[k]])) }
}
export function publicReceipt(op) {
    if (!op) return null
    const r = op.receipt
    return Object.fromEntries(['version', 'receiptId', 'requestId', 'installId', 'workspaceId', 'kind', 'connectionId', 'configurationRevision', 'expectedRevision', 'revision', 'effectGeneration', 'phase', 'closeAttempted', 'requiresRecovery', 'reason', 'createdAt', 'updatedAt'].map(k => [k, r[k]]))
}
export function publicFailure(error) {
    const messages = { invalid: 'This server request was not understood.', stale: 'This workspace window or server revision is no longer current. Refresh before continuing.',
        busy: 'Wait for the current server change to settle or recover it explicitly.', unavailable: 'The app cannot reach this server securely, or its change was not confirmed.',
        unsupported: 'This server does not provide a verifiable workspace identity.', auth_needed: 'Your server answers, but refused the key.',
        identity_changed: 'The server machine, workspace or certificate identity changed. Review its configuration before reconnecting.',
        authority_missing: 'This remote-machine capability is not connected to the desktop lifecycle.', uncertain: 'The prior server effect is still uncertain. Reconcile this exact request before retrying.',
        cancelled: 'The server change was cancelled. Read its exact receipt; an already-drained transition may still need explicit recovery.',
        storage_full: 'Server recovery storage is full. Existing request identities were preserved.' }
    const code = Object.hasOwn(messages, error?.code) ? error.code : 'unavailable'
    return { code, message: messages[code], ...(code === 'authority_missing' ? { authority: /^W1-[A-Z0-9-]{1,100}$/.test(error.authority ?? '') ? error.authority : 'W1-R-LIFECYCLE' } : {}) }
}
