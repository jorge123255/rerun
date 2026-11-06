import { customProviderSnapshotSchema, type CustomProviderAuthority, type CustomProviderIdentity } from '@rerun/contracts'
import { getConnection } from '../../connections/registry.js'

/** Concrete existing-registry consistency fence. Encrypted custody/revisions remain with the canonical owner. */
export function bindRegisteredCustomConnection(authority: CustomProviderAuthority): CustomProviderAuthority {
    const assertRegistered = async (identity: CustomProviderIdentity, signal: AbortSignal) => {
        await authority.assertCurrent(identity, signal); signal.throwIfAborted()
        const registered = await getConnection(identity.connectionId)
        await authority.assertCurrent(identity, signal); signal.throwIfAborted()
        if (registered.id !== identity.connectionId || String(registered.config.provider) !== 'custom') throw new Error('Custom connection registry identity changed.')
        return registered
    }
    return {
        assertCurrent: (identity, signal) => authority.assertCurrent(identity, signal),
        change: (change, signal) => authority.change(change, signal),
        recordProbe: (identity, result, signal) => authority.recordProbe(identity, result, signal),
        subscribe: listener => authority.subscribe(listener),
        async read(identity, signal) {
            const registered = await assertRegistered(identity, signal)
            const snapshot = customProviderSnapshotSchema.parse(await authority.read(identity, signal))
            await authority.assertCurrent(identity, signal)
            if (snapshot.workspaceId !== identity.workspaceId || snapshot.connectionId !== identity.connectionId || snapshot.revision !== identity.revision || registered.config.baseUrl?.replace(/\/+$/, '') !== snapshot.config.baseUrl.replace(/\/+$/, '')) throw new Error('Custom connection revision changed.')
            return snapshot
        },
        async credential(identity, signal) {
            await assertRegistered(identity, signal)
            const secret = await authority.credential(identity, signal)
            await authority.assertCurrent(identity, signal)
            signal.throwIfAborted()
            return secret
        },
    }
}
