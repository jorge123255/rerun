export const PROTOCOL_VERSION = 1
export const SERVICE_NAME = 'rerun-mac-phone-pairing'
export const API_PREFIX = '/api/mac-pairing/v1'
export const PHONE_SESSION_KEY = 'rerun.mac-pairing.session'
// Upstream custom-server key from apps/mobile/src/config/custom-server.ts at 5222e848.
// A Mac-paired session must never read or write this key, or any Supabase auth key.
export const CUSTOM_SERVER_KEY = 'rerun.server'
export const SUPABASE_AUTH_KEY_PREFIX = 'sb-'
export const UPSTREAM_WORKSPACE_KEY = 'rerun.workspace-id'

export const START_ENTRIES = Object.freeze([
    { id: 'cloud', kind: 'cloud' },
    { id: 'own-server', kind: 'server-picker', label: 'Use your own server' },
    { id: 'this-mac', kind: 'mac-pairing', label: 'Connect to This Mac' },
])
