import { macFingerprint } from './crypto.mjs'
import { createOfferBook } from './offers.mjs'
import { DEFAULT_OFFER_TTL_MS, ERRORS, LOOPBACK_HOST } from './protocol.mjs'
import { listPublicDevices, readDeviceStore, readSettings, writeDeviceStore, writeSettings } from './store.mjs'
import { createPairingTransport } from './transport.mjs'
import { getWorkspace } from '../workspaces/catalog.mjs'

function refusal(code) {
    return Object.assign(new Error(code), { code })
}

export function createMacPhonePairingService({
    dataRoot,
    installId,
    getRuntime,
    now = Date.now,
    offerTtlMs = DEFAULT_OFFER_TTL_MS,
    listenHost = LOOPBACK_HOST,
    listenPort = 0,
}) {
    const fingerprint = macFingerprint(installId)
    const offers = createOfferBook({ now, ttlMs: offerTtlMs })
    const settings = () => readSettings(dataRoot)
    const store = () => readDeviceStore(dataRoot, installId)
    const saveStore = value => writeDeviceStore(dataRoot, installId, value)
    let transport = null
    let pending = Promise.resolve()

    // Every settings and device mutation shares one queue, including HTTP redemption.
    // Reads from the workspace run outside it and recheck authorization before release.
    function exclusive(operation) {
        const work = pending.then(operation)
        pending = work.then(() => {}, () => {})
        return work
    }

    function newTransport(port) {
        return createPairingTransport({
            now, host: listenHost, port, installId, fingerprint, getSettings: settings,
            getStore: store, saveStore, getRuntime, dataRoot, offers, exclusive,
        })
    }

    async function start(current) {
        if (transport?.address()) return
        if (listenHost !== LOOPBACK_HOST || current.lanBindingEnabled) throw refusal(ERRORS.lan_off)
        const next = newTransport(listenPort || current.loopbackPort || 0)
        await next.listen()
        try {
            await writeSettings(dataRoot, { ...current, phoneAccessEnabled: true, loopbackPort: next.address().port })
            transport = next
        } catch (error) {
            await next.close()
            throw error
        }
    }

    async function stop() {
        const stopped = transport
        transport = null
        offers.clear()
        await stopped?.close()
    }

    async function status() {
        const current = await settings()
        const devices = listPublicDevices(await store())
        const address = transport?.address() ?? null
        return {
            phoneAccessEnabled: current.phoneAccessEnabled,
            lanBindingEnabled: false,
            lanOffByDefault: true,
            listening: Boolean(address),
            bindHost: address?.host ?? null,
            origin: address?.origin ?? null,
            selectedWorkspaceId: getRuntime()?.workspaceId ?? null,
            macId: installId,
            fingerprint,
            devices,
        }
    }

    return {
        fingerprint, settings, status,
        origin: () => transport?.address()?.origin ?? null,
        address: () => transport?.address() ?? null,
        setPhoneAccessEnabled: enabled => exclusive(async () => {
            const current = await settings()
            if (enabled === true) await start(current)
            else {
                await writeSettings(dataRoot, { ...current, phoneAccessEnabled: false })
                await stop()
            }
            return status()
        }),
        // LAN activation requires an authenticated transport. This preview binds loopback only.
        async setLanBindingEnabled() { throw refusal(ERRORS.lan_off) },
        restore: () => exclusive(async () => {
            const current = await settings()
            if (current.phoneAccessEnabled) await start(current)
            return status()
        }),
        stop: () => exclusive(stop),
        createOffer: workspaceId => exclusive(async () => {
            if (!(await settings()).phoneAccessEnabled || !transport?.address()) throw refusal(ERRORS.disabled)
            const current = getRuntime()
            if (!current || (workspaceId !== undefined && workspaceId !== current.workspaceId)) {
                throw refusal(ERRORS.workspace_not_active)
            }
            const { workspace } = await getWorkspace(dataRoot, installId, current.workspaceId)
            if (!workspace || getRuntime() !== current) throw refusal(ERRORS.not_found)
            return offers.issue({
                workspaceId: current.workspaceId, macId: installId, fingerprint, origin: transport.address().origin,
            })
        }),
        devices: async () => listPublicDevices(await store()),
        approveDevice: deviceId => exclusive(async () => {
            if (!transport || !(await settings()).phoneAccessEnabled) throw refusal(ERRORS.disabled)
            return transport.approve(deviceId)
        }),
        revokeDevice: deviceId => exclusive(() => (transport ?? newTransport(0)).revoke(deviceId)),
    }
}
