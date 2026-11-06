import 'server-only'
import { readPortableArchive, type PortablePackageMemberBytes } from '../../../../../engine/src/desktop/templates/portable-package'
import { createDesktopCoworkerSharePlan, createDesktopCoworkerSnapshot, type DesktopCoworkerShareSource } from '../../../../../engine/src/desktop/coworker-share/snapshot'
import { desktopCoworkerShareExportInputSchema, desktopCoworkerShareImportInputSchema, desktopCoworkerShareRevokeInputSchema, desktopCoworkerShareSourceSchema, type DesktopCoworkerShareReceipt } from '../../../../../../packages/contracts/src/desktop-coworker-share'
import { DesktopHttpError } from '../auth'
import type { DesktopCoworkerShareStore } from './store'

export type DesktopCoworkerShareInstallAuthority = {
    install: (input: { manifest: Parameters<typeof readPortableArchive>[0] extends Promise<infer R> ? R extends { manifest: infer M } ? M : never : never; members: PortablePackageMemberBytes[]; targetWorkspaceId: number; requestId: string }) => Promise<string>
    recoverImport?: (input: { snapshotId: string; targetWorkspaceId: number; requestId: string }) => Promise<string>
}

export function createDesktopCoworkerShareService(store: DesktopCoworkerShareStore, authority: DesktopCoworkerShareInstallAuthority) {
    return {
        plan: (source: DesktopCoworkerShareSource) => createDesktopCoworkerSharePlan(desktopCoworkerShareSourceSchema.parse(source)),

        async export(input: Parameters<typeof desktopCoworkerShareExportInputSchema.parse>[0], source: DesktopCoworkerShareSource) {
            const parsed = desktopCoworkerShareExportInputSchema.parse(input)
            const current = desktopCoworkerShareSourceSchema.parse(source)
            if (parsed.agentId !== current.agentId || parsed.sourceRevision !== current.revision || parsed.workspaceId !== current.workspaceId) throw new DesktopHttpError(409, 'The coworker changed. Review the current content before exporting.')
            const snapshot = await createDesktopCoworkerSnapshot(current, parsed.include, parsed.workspaceId)
            const created = await store.create(snapshot, current.agentId, parsed.include, current.revision)
            return { manifest: snapshot.manifest, archiveSha256: snapshot.archiveSha256, archiveBytes: snapshot.archiveBytes.length, reused: created.reused }
        },

        async preview(snapshotId: string) {
            const manifest = await store.readManifest(snapshotId)
            if (!manifest) throw new DesktopHttpError(404, 'Local share not found.')
            const archive = await store.readArchive(snapshotId)
            const restored = await readPortableArchive(archive.bytes)
            if (restored.manifest.contentDigest !== manifest.contentDigest) throw new DesktopHttpError(409, 'This package does not match its recorded digest.')
            return restored.manifest
        },

        async download(snapshotId: string) {
            return store.readArchive(snapshotId)
        },

        async import(input: Parameters<typeof desktopCoworkerShareImportInputSchema.parse>[0]): Promise<{ status: 'imported' | 'uncertain'; importedAgentId?: string; recoverable?: boolean; reason?: string }> {
            const parsed = desktopCoworkerShareImportInputSchema.parse(input)
            const manifest = await store.readManifest(parsed.snapshotId)
            if (!manifest || manifest.contentDigest !== parsed.expectedDigest) throw new DesktopHttpError(409, 'This local share changed or is no longer available.')
            const previous = await store.readImport(parsed.snapshotId, parsed.targetWorkspaceId)
            if (previous?.status === 'imported') return { status: 'imported', importedAgentId: previous.importedAgentId }
            if (previous?.status === 'rolled_back' && !authority.recoverImport) return { status: 'uncertain', recoverable: true, reason: 'Import acknowledgement is unavailable. Retry the same package.' }
            try {
                const archive = await store.readArchive(parsed.snapshotId)
                const restored = await readPortableArchive(archive.bytes)
                if (restored.manifest.contentDigest !== parsed.expectedDigest) throw new DesktopHttpError(409, 'This package does not match its recorded digest.')
                const importedAgentId = previous?.status === 'rolled_back' && authority.recoverImport
                    ? await authority.recoverImport({ snapshotId: parsed.snapshotId, targetWorkspaceId: parsed.targetWorkspaceId, requestId: parsed.requestId })
                    : await authority.install({ manifest: restored.manifest, members: restored.members, targetWorkspaceId: parsed.targetWorkspaceId, requestId: parsed.requestId })
                await store.markImported(parsed.snapshotId, parsed.targetWorkspaceId, parsed.requestId, importedAgentId)
                return { status: 'imported', importedAgentId }
            } catch (cause) {
                const reason = cause instanceof Error ? cause.message.slice(0, 400) : 'Import acknowledgement is unavailable.'
                await store.rollbackImport(parsed.snapshotId, parsed.targetWorkspaceId, parsed.requestId, reason)
                return { status: 'uncertain', recoverable: true, reason }
            }
        },

        async revoke(input: Parameters<typeof desktopCoworkerShareRevokeInputSchema.parse>[0]): Promise<DesktopCoworkerShareReceipt> {
            const parsed = desktopCoworkerShareRevokeInputSchema.parse(input)
            return store.revoke(parsed.snapshotId, parsed.expectedRevision)
        },
    }
}

export type DesktopCoworkerShareService = ReturnType<typeof createDesktopCoworkerShareService>
