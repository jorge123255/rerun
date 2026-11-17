import type { Session } from '@supabase/supabase-js'
import { useMemo, type ReactNode } from 'react'

import { AuthContext, type AuthState } from '@/auth/AuthProvider'
import { clearLocalCache } from '@/data/local-cache'

import { macMe, macUserId } from './hub'
import { leaveMac, type MacLink } from './session'

// What the screens read as the signed-in account, for a phone paired with a Mac: the token is the
// phone's own, handed over once the Mac's owner approved it, and the workspace is the one they
// approved it for. Nothing here talks to Supabase, registers for push or identifies the person.
export function macSession(link: MacLink): Session {
    const id = macUserId(link)
    const user = { id, app_metadata: {}, user_metadata: {}, aud: 'mac', created_at: new Date(0).toISOString() }
    return { access_token: link.credential, refresh_token: '', expires_in: 0, token_type: 'bearer', user }
}

export function MacAuthProvider({ link, children }: { link: MacLink; children: ReactNode }) {
    const value = useMemo<AuthState>(
        () => ({
            ready: true,
            session: macSession(link),
            me: macMe(link),
            switchWorkspace: async () => {},
            refreshMe: async () => {},
            // Leaving forgets the pairing on the phone. The Mac still lists the phone until it is removed there.
            signOut: async () => {
                clearLocalCache()
                await leaveMac()
            },
        }),
        [link]
    )
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
