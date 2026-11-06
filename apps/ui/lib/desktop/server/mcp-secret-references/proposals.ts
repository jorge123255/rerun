import 'server-only'
import {
    DESKTOP_MCP_SECRET_REFERENCE_PENDING_OUTCOME,
    desktopMcpRegistrationLink,
    desktopMcpSecretReferenceError,
    type DesktopMcpCredentialAuthority,
} from '@rerun/contracts'
import type { DesktopMcpSecretLookup } from './lookup'

export type DesktopMcpProposalLink =
    | { accepted: false; outcome: 'rejected'; issue: string }
    | { accepted: false; outcome: 'ready_without_references'; pending: []; authority: DesktopMcpCredentialAuthority }
    | {
          accepted: false
          outcome: typeof DESKTOP_MCP_SECRET_REFERENCE_PENDING_OUTCOME | 'credentials_ready'
          pending: string[]
          present: { name: string; version: number }[]
          authority: DesktopMcpCredentialAuthority
      }

export async function linkDesktopMcpProposalCredentials(value: unknown, agentId: string, lookup: Pick<DesktopMcpSecretLookup, 'version'>, gate: { check: () => void }): Promise<DesktopMcpProposalLink> {
    const classified = desktopMcpRegistrationLink(value)
    if (classified.outcome === 'rejected') return classified
    if (classified.outcome === 'ready_without_references') return classified
    const pending: string[] = []
    const present: { name: string; version: number }[] = []
    for (const name of classified.pending) {
        const version = await lookup.version(agentId, name, gate)
        if (version.state === 'forbidden') return { accepted: false, outcome: 'rejected', issue: desktopMcpSecretReferenceError('forbidden', name).message }
        if (version.state === 'missing') pending.push(name)
        else present.push({ name, version: version.version })
    }
    return {
        accepted: false,
        outcome: pending.length > 0 ? DESKTOP_MCP_SECRET_REFERENCE_PENDING_OUTCOME : 'credentials_ready',
        pending,
        present,
        authority: classified.authority,
    }
}
