import type { DesktopToolInstallSnapshot } from '@rerun/contracts'

export const desktopToolInstallActivity = { name: 'tool_install', label: 'Installing' } as const

export function desktopToolInstallApprovalItems(snapshot: DesktopToolInstallSnapshot): Array<{ action: string; detail: string }> {
    const packages = snapshot.packages.map(item => item.package).join(', ')
    return [{
        action: `Install npm packages: ${packages}`,
        detail: 'These exact package versions execute in this coworker’s isolated computer. Package scripts are code execution. Approval permits installation only in that guest, not on the host.',
    }]
}

export function desktopToolInstallOutcomeText(snapshot: DesktopToolInstallSnapshot): string {
    const packages = snapshot.packages.map(item => item.package).join(', ')
    switch (snapshot.status) {
        case 'pending-approval': return `Approval required to install ${packages} in this coworker’s isolated computer.`
        case 'approved':
        case 'installing': return `Installing ${packages} in this coworker’s isolated computer.`
        case 'installed': return `Installed ${packages} in this coworker’s isolated computer. Packages remain available only in that guest.`
        case 'partial': return `Installation incomplete for ${packages}. Review the per-package evidence before retrying.`
        case 'failed': return `Install failed: ${snapshot.message ?? packages}`
        case 'declined': return 'Install declined.'
        case 'cancelled': return 'Install cancelled.'
        case 'uncertain': return 'Installation outcome is uncertain. Inspect it in the same isolated computer; do not reinstall automatically.'
        case 'interrupted': return 'Installation was interrupted and was not restarted.'
    }
}

export function desktopToolInstallAttention(snapshot: DesktopToolInstallSnapshot): { id: string; kind: 'tool-install'; summary: string; requestedAt: string } | null {
    if (snapshot.status === 'pending-approval') return { id: snapshot.operationId, kind: 'tool-install', summary: desktopToolInstallOutcomeText(snapshot), requestedAt: snapshot.createdAt }
    if (['installing', 'uncertain', 'interrupted'].includes(snapshot.status)) return { id: snapshot.operationId, kind: 'tool-install', summary: desktopToolInstallOutcomeText(snapshot), requestedAt: snapshot.updatedAt }
    return null
}
