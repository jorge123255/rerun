'use client'
import { DesktopServiceAccounts } from './accounts/DesktopServiceAccounts'

type ServiceFocus = { agentId: string; focusSlug?: string; focusRequestKey?: string }

/** The existing Apps entry keeps Rerun's list → account setup navigation. */
export function DesktopCoworkerServices(props: ServiceFocus) {
    return <DesktopServiceAccounts key={props.agentId} {...props} />
}
