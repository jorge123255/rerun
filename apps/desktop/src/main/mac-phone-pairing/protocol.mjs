export const PROTOCOL_VERSION = 1
export const SERVICE_NAME = 'rerun-mac-phone-pairing'
export const MAX_OFFER_TTL_MS = 120_000
export const DEFAULT_OFFER_TTL_MS = 120_000
export const CREDENTIAL_CLAIM_TTL_MS = 120_000
export const STORAGE_DIR = 'mac-phone-pairing'
export const SETTINGS_FILE = 'settings.json'
export const DEVICES_FILE = 'devices.json'
export const API_PREFIX = '/api/mac-pairing/v1'
export const HASH_PREFIX = 'rerun-mac-phone-pairing-v1:'
export const FINGERPRINT_PREFIX = 'rerun-mac-phone-pairing-fingerprint-v1:'
export const LOOPBACK_HOST = '127.0.0.1'
export const PHONE_SESSION_KEY = 'rerun.mac-pairing.session'
export const CUSTOM_SERVER_KEY = 'rerun.server'

export const DEVICE_STATUS = Object.freeze({
    pending: 'pending',
    approved: 'approved',
    revoked: 'revoked',
})

export const ERRORS = Object.freeze({
    unauthorized: 'unauthorized',
    invalid_offer: 'invalid_offer',
    not_found: 'not_found',
    disabled: 'disabled',
    lan_off: 'lan_off',
    lan_address_unavailable: 'lan_address_unavailable',
    workspace_not_active: 'workspace_not_active',
})

export function defaultSettings() {
    return { version: PROTOCOL_VERSION, phoneAccessEnabled: false, lanBindingEnabled: false }
}

export function publicError(code, status = 401) {
    return { status, body: { error: code } }
}
