import { createMacPairingClient } from '@rerun/mac-pairing-client'
import * as Device from 'expo-device'
import * as SecureStore from 'expo-secure-store'

import { createPinnedTransport } from './pinned-transport'

export type MacClient = ReturnType<typeof createMacPairingClient>

// The pairing lives in the Keychain under its own key, apart from a hub's session and from the
// custom server: leaving the Mac never touches either.
const storage = {
    getItem: (key: string) => SecureStore.getItemAsync(key),
    setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
    removeItem: (key: string) => SecureStore.deleteItemAsync(key),
}

// The name the Mac lists the phone under, for the person to tell their devices apart.
const deviceName = (Device.deviceName ?? Device.modelName ?? 'Phone').slice(0, 80)

export const macClient: MacClient = createMacPairingClient({ storage, deviceName, ...createPinnedTransport() })
