import { macFingerprint } from './crypto.mjs'
import { isPrivateAddress, loadLanIdentity, localPairingAddresses } from './lan-identity.mjs'
import { createOfferBook } from './offers.mjs'
import { CREDENTIAL_CLAIM_TTL_MS, DEFAULT_OFFER_TTL_MS, DEVICE_STATUS, ERRORS, LOOPBACK_HOST } from './protocol.mjs'
import { listPublicDevices, publicDevice, readDeviceStore, readSettings, writeDeviceStore, writeSettings } from './store.mjs'
import { createPairingTransport } from './transport.mjs'
import { getWorkspace, listCatalog } from '../workspaces/catalog.mjs'

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

    function newTransport(port, host = listenHost, tls) {
        return createPairingTransport({
            now, host, port, installId, fingerprint, tls, getSettings: settings,
            getStore: store, saveStore, getRuntime, dataRoot, offers, exclusive,
        })
    }

    async function start(current, lanAddress = current.lanAddress, { renew = false } = {}) {
        const host = lanAddress || listenHost
        if (lanAddress && (!isPrivateAddress(host) || !localPairingAddresses().includes(host))) {
            throw refusal(ERRORS.lan_address_unavailable)
        }
        if (transport?.address()?.host === host) return
        const tls = lanAddress ? await loadLanIdentity(dataRoot, host, { renew }) : undefined
        const port = tls ? (host === current.lanAddress ? current.lanPort : undefined) : (listenPort || current.loopbackPort)
        const next = newTransport(port || 0, host, tls)
        await next.listen()
        try {
            const bound = next.address().port
            await writeSettings(dataRoot, {
                ...current, phoneAccessEnabled: true, lanAddress,
                ...(tls ? { lanPort: bound } : { loopbackPort: bound }),
            })
        } catch (error) {
            await next.close()
            throw error
        }
        const previous = transport
        transport = next
        offers.clear()
        await previous?.close()
    }

    async function stop() {
        const stopped = transport
        transport = null
        offers.clear()
        await stopped?.close()
    }

    async function status() {
        const [current, deviceStore, workspaces] = await Promise.all([
            settings(),
            store(),
            // A catalog error should not take away the ability to revoke a paired phone.
            listCatalog(dataRoot, installId).then(({ catalog }) => catalog.workspaces, () => []),
        ])
        const workspaceNames = new Map(workspaces
            .filter(workspace => workspace.pathStatus === 'ready')
            .map(workspace => [workspace.workspaceId, workspace.name]))
        const runtime = getRuntime()
        const selectedWorkspaceId = runtime?.workspaceId ?? null
        const at = now()
        const devices = deviceStore.devices.filter(device => device.status !== DEVICE_STATUS.pending
            || (device.workspaceId === selectedWorkspaceId && transport?.inScope(device)
                && at - Date.parse(device.createdAt) < CREDENTIAL_CLAIM_TTL_MS))
            .map(device => ({
                ...publicDevice(device),
                workspaceName: workspaceNames.get(device.workspaceId) ?? null,
                ...(device.status === DEVICE_STATUS.approved && {
                    // Older records lack a collection marker. Keep their credentials usable.
                    pairingState: device.credentialIssued !== false ? 'paired'
                        : transport?.canClaim(device) ? 'awaiting_phone' : 'incomplete',
                }),
            }))
        const address = transport?.address() ?? null
        return {
            phoneAccessEnabled: current.phoneAccessEnabled,
            lanBindingEnabled: current.lanBindingEnabled,
            lanOffByDefault: true,
            lanAddress: current.lanAddress ?? null,
            lanAddresses: localPairingAddresses(),
            listening: Boolean(address),
            activeOfferId: runtime && address ? offers.activeId(runtime) : null,
            bindHost: address?.host ?? null,
            origin: address?.origin ?? null,
            selectedWorkspaceId,
            selectedWorkspaceName: workspaceNames.get(selectedWorkspaceId) ?? null,
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
                await writeSettings(dataRoot, { ...current, phoneAccessEnabled: false, lanAddress: null })
                await stop()
            }
            return status()
        }),
        setLanAddress: address => exclusive(async () => {
            const current = await settings()
            if (!current.phoneAccessEnabled) throw refusal(ERRORS.disabled)
            if (address !== null && !isPrivateAddress(address)) throw refusal(ERRORS.lan_address_unavailable)
            await start(current, address, { renew: true })
            return status()
        }),
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
                certificateFingerprint: transport.certificateFingerprint, runtime: current,
            })
        }),
        devices: async () => listPublicDevices(await store()),
        approveDevice: deviceId => exclusive(async () => {
            if (!transport || !(await settings()).phoneAccessEnabled) throw refusal(ERRORS.disabled)
            return transport.approve(deviceId)
        }),
        declineDevice: deviceId => exclusive(async () => {
            if (!transport || !(await settings()).phoneAccessEnabled) throw refusal(ERRORS.disabled)
            return transport.revoke(deviceId, { pendingOnly: true })
        }),
        setSendMessages: (deviceId, enabled) => exclusive(async () => {
            const record = await store()
            const device = record.devices.find(entry => entry.deviceId === deviceId)
            if (!device || device.status !== DEVICE_STATUS.approved || !device.certificateFingerprint) throw refusal(ERRORS.not_found)
            if (enabled && (device.credentialIssued === false || !transport?.inScope(device)
                || !transport.address() || getRuntime()?.workspaceId !== device.workspaceId)) {
                throw refusal(ERRORS.workspace_not_active)
            }
            device.sendMessages = enabled === true
            await saveStore(record)
            return publicDevice(device)
        }),
        revokeDevice: deviceId => exclusive(() => (transport ?? newTransport(0)).revoke(deviceId)),
    }
}
