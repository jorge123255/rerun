import * as Updates from 'expo-updates'

import { readCustomServer, type CustomServer } from '@/config/custom-server'
import { readMacLink, type MacLink } from '@/mac/session'
import { PRODUCTION, STAGING } from '@rerun/cloud-mobile/environments'

export type Environment = {
    name: 'production' | 'staging' | 'local' | 'custom' | 'mac'
    apiUrl: string
    supabaseUrl: string
    supabasePublishableKey: string
}

// A store build is bound to its environment by the update channel baked in at build time, never by
// EXPO_PUBLIC_* values: those are inlined by whoever runs `eas update`, so an update published from a
// laptop on the production profile would otherwise point a staging build at production.
export function environmentForChannel(channel: string | null): Environment {
    if (channel === 'production') return PRODUCTION
    if (channel === 'staging') return STAGING

    return {
        name: 'local',
        apiUrl: process.env.EXPO_PUBLIC_API_URL ?? STAGING.apiUrl,
        supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? STAGING.supabaseUrl,
        supabasePublishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? STAGING.supabasePublishableKey,
    }
}

// A Mac has no Supabase: the client is built for an address nothing answers at and is never asked.
const NO_SUPABASE = { supabaseUrl: 'http://127.0.0.1:9', supabasePublishableKey: 'not-used-on-a-mac' }

// A Mac the phone is paired with comes first, then a server the person picked in the app, their own
// Rerun, then the one the build was made for.
export function environmentAtLaunch(channel: string | null, custom: CustomServer | null, mac: MacLink | null = null): Environment {
    if (mac) return { name: 'mac', apiUrl: mac.origin, ...NO_SUPABASE }
    if (custom) return { name: 'custom', ...custom }
    return environmentForChannel(channel)
}

export const macLink = readMacLink()

export const environment = environmentAtLaunch(Updates.channel, readCustomServer(), macLink)

// Paired with the Mac app on the local network: no account, no hub, one workspace.
export const onMac = environment.name === 'mac'

export const onCustomServer = environment.name === 'custom'

// Where a person is sent to do what the app does not: rerun.build, or their own server.
export const webHost = onCustomServer || onMac ? new URL(environment.apiUrl).host : 'rerun.build'
