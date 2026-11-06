import type {
    DesktopGuestShellIdentity,
    DesktopGuestShellPackageEvidence,
    DesktopGuestShellReceipt,
    DesktopGuestShellResult,
    DesktopGuestShellRequest,
} from '@rerun/contracts'

export type DesktopGuestShellAuthority = (identity: Omit<DesktopGuestShellIdentity, 'guest'>, signal: AbortSignal, phase?: 'execute' | 'inspect') => Promise<DesktopGuestShellIdentity['guest']>
export type DesktopGuestShellPackageAuthority = (guest: DesktopGuestShellIdentity['guest'], packages: readonly string[], signal: AbortSignal) => Promise<readonly DesktopGuestShellPackageEvidence[]>

export type DesktopGuestShellTransport = {
    execute(identity: DesktopGuestShellRequest, signal: AbortSignal): Promise<DesktopGuestShellResult>
    inspect(identity: DesktopGuestShellIdentity, signal: AbortSignal): Promise<DesktopGuestShellResult>
    cancel(identity: DesktopGuestShellIdentity, signal: AbortSignal): Promise<void>
}

export type DesktopGuestShellStore = {
    begin(identity: DesktopGuestShellRequest, result: DesktopGuestShellReceipt): Promise<'execute' | DesktopGuestShellReceipt>
    complete(identity: DesktopGuestShellIdentity, receipt: DesktopGuestShellReceipt): Promise<void>
    read(requestId: string): Promise<DesktopGuestShellReceipt | null>
}

export type { DesktopGuestShellIdentity, DesktopGuestShellInput, DesktopGuestShellPackageEvidence, DesktopGuestShellReceipt, DesktopGuestShellResult, DesktopGuestShellRequest } from '@rerun/contracts'
