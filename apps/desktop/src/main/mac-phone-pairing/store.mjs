import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicPrivateJSON, pathExists, readJSON } from '../workspaces/paths.mjs'
import { macFingerprint } from './crypto.mjs'
import { defaultSettings, DEVICES_FILE, DEVICE_STATUS, PROTOCOL_VERSION, SETTINGS_FILE, STORAGE_DIR } from './protocol.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const validPort = port => Number.isInteger(port) && port >= 1 && port <= 65535

export function pairingDir(dataRoot) {
    return join(dataRoot, STORAGE_DIR)
}

function settingsPath(dataRoot) {
    return join(pairingDir(dataRoot), SETTINGS_FILE)
}

function devicesPath(dataRoot) {
    return join(pairingDir(dataRoot), DEVICES_FILE)
}

function iso(now) {
    return new Date(now).toISOString()
}

export async function ensurePairingDir(dataRoot) {
    await mkdir(pairingDir(dataRoot), { recursive: true, mode: 0o700 })
}

export async function readSettings(dataRoot) {
    const path = settingsPath(dataRoot)
    if (!await pathExists(path)) return defaultSettings()
    const saved = await readJSON(path)
    if (saved?.version !== PROTOCOL_VERSION || typeof saved.phoneAccessEnabled !== 'boolean' || typeof saved.lanBindingEnabled !== 'boolean') {
        return defaultSettings()
    }
    const { loopbackPort, lanAddress, lanPort } = saved
    if (saved.lanBindingEnabled && typeof lanAddress !== 'string') return defaultSettings()
    return {
        version: PROTOCOL_VERSION, phoneAccessEnabled: saved.phoneAccessEnabled, lanBindingEnabled: saved.lanBindingEnabled,
        ...(validPort(loopbackPort) ? { loopbackPort } : {}),
        ...(saved.lanBindingEnabled ? { lanAddress, ...(validPort(lanPort) ? { lanPort } : {}) } : {}),
    }
}

export async function writeSettings(dataRoot, settings) {
    await ensurePairingDir(dataRoot)
    const { loopbackPort, lanAddress, lanPort } = settings
    const next = {
        version: PROTOCOL_VERSION,
        phoneAccessEnabled: settings.phoneAccessEnabled === true,
        lanBindingEnabled: Boolean(lanAddress),
        ...(validPort(loopbackPort) ? { loopbackPort } : {}),
        ...(lanAddress ? { lanAddress, ...(validPort(lanPort) ? { lanPort } : {}) } : {}),
    }
    await atomicPrivateJSON(settingsPath(dataRoot), next)
    return next
}

function publicDevice(device) {
    return {
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        name: device.name,
        status: device.status,
        createdAt: device.createdAt,
        approvedAt: device.approvedAt,
        revokedAt: device.revokedAt,
        lastSeenAt: device.lastSeenAt,
        network: device.certificateFingerprint ? 'lan' : 'loopback',
    }
}

function emptyStore(installId) {
    return { version: PROTOCOL_VERSION, macId: installId, fingerprint: macFingerprint(installId), devices: [] }
}

function validateStore(value, installId) {
    if (!value || value.version !== PROTOCOL_VERSION || value.macId !== installId || value.fingerprint !== macFingerprint(installId) || !Array.isArray(value.devices)) {
        throw new Error('Phone pairing records need recovery.')
    }
    const seen = new Set()
    for (const device of value.devices) {
        if (!UUID.test(device.deviceId) || seen.has(device.deviceId) || !Number.isInteger(device.workspaceId) || device.workspaceId < 1
            || (device.name !== null && (typeof device.name !== 'string' || device.name.length > 80))
            || (device.credentialHash !== null && !HASH.test(device.credentialHash))
            || (device.requestTokenHash !== null && !HASH.test(device.requestTokenHash))
            || (device.certificateFingerprint !== undefined && !HASH.test(device.certificateFingerprint))
            || !Object.values(DEVICE_STATUS).includes(device.status)
            || !Number.isFinite(Date.parse(device.createdAt))) {
            throw new Error('Phone pairing records need recovery.')
        }
        seen.add(device.deviceId)
    }
    return value
}

export async function readDeviceStore(dataRoot, installId) {
    const path = devicesPath(dataRoot)
    if (!await pathExists(path)) return emptyStore(installId)
    return validateStore(await readJSON(path), installId)
}

export async function writeDeviceStore(dataRoot, installId, store) {
    await ensurePairingDir(dataRoot)
    const next = validateStore({
        version: PROTOCOL_VERSION,
        macId: installId,
        fingerprint: macFingerprint(installId),
        devices: store.devices,
    }, installId)
    await atomicPrivateJSON(devicesPath(dataRoot), next)
    return next
}

export function listPublicDevices(store) {
    return store.devices.map(publicDevice)
}

export { publicDevice, emptyStore, iso }
