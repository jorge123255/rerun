import { PHONE_SESSION_KEY } from '@rerun/mac-pairing-client'
import { reloadAppAsync } from 'expo'
import * as SecureStore from 'expo-secure-store'

// The Mac this phone is paired with: where its phone listener answers, the certificate it must
// present, the workspace the person approved the phone for, and the phone's own token.
export type MacLink = {
    origin: string
    certificateFingerprint?: string
    macId: string
    workspaceId: number
    deviceId: string
    credential: string
}

export function parseMacLink(raw: string | null): MacLink | null {
    if (!raw) return null
    try {
        const saved = JSON.parse(raw) as Record<string, unknown>
        if (saved.kind !== 'rerun-mac-phone-pairing' || saved.status !== 'approved') return null
        const { origin, certificateFingerprint, macId, workspaceId, deviceId, credential } = saved
        if (typeof origin !== 'string' || typeof macId !== 'string' || typeof deviceId !== 'string' || typeof credential !== 'string') return null
        if (typeof workspaceId !== 'number' || !Number.isInteger(workspaceId) || workspaceId < 1) return null
        if (certificateFingerprint !== undefined && typeof certificateFingerprint !== 'string') return null
        return { origin, certificateFingerprint, macId, workspaceId, deviceId, credential }
    } catch {
        return null
    }
}

// Read synchronously, like the custom server: the whole app is bound to one server for as long as it
// runs. A pairing still waiting for the person's approval on the Mac is not a link yet.
export function readMacLink(): MacLink | null {
    return parseMacLink(SecureStore.getItem(PHONE_SESSION_KEY))
}

// The app starts again on the Mac once the pairing is approved, and on the server the build was made
// for once the phone leaves it.
export async function restartOnMac(): Promise<void> {
    await reloadAppAsync('paired with a Mac')
}

// What has to stop before the phone lets go of the Mac, a voice conversation above all: the app
// starts again right after, and a microphone left open across that restart would be nobody's.
const leaving = new Set<() => Promise<void> | void>()

export function onLeavingMac(listener: () => Promise<void> | void): () => void {
    leaving.add(listener)
    return () => void leaving.delete(listener)
}

export async function leaveMac(): Promise<void> {
    await Promise.allSettled([...leaving].map(async listener => listener()))
    await SecureStore.deleteItemAsync(PHONE_SESSION_KEY).catch(() => {})
    await reloadAppAsync('left the Mac')
}
