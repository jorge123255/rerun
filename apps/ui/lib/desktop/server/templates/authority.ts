import 'server-only'
import type { DesktopTemplateCommit, InitializeImportedSetup } from '@rerun/contracts'

// Root sets these once from desktop startup. Until then install stays recoverable
// and does not report coworkers as installed.
let commitInstalled: DesktopTemplateCommit | null = null
let initializeImportedSetup: InitializeImportedSetup | null = null

export function setDesktopTemplateAuthority(next: {
    commitInstalled: DesktopTemplateCommit
    initializeImportedSetup: InitializeImportedSetup
}): void {
    commitInstalled = next.commitInstalled
    initializeImportedSetup = next.initializeImportedSetup
}

export function desktopTemplateAuthority(): {
    commitInstalled: DesktopTemplateCommit | null
    initializeImportedSetup: InitializeImportedSetup | null
} {
    return { commitInstalled, initializeImportedSetup }
}
