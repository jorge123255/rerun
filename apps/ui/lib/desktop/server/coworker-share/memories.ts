import 'server-only'
import { scanPathForSecrets, scanTextForSecrets, type DesktopCoworkerShareSource, type DesktopCoworkerShareMemoryPreview } from '@rerun/contracts'
import { captureDesktopCoworkerShareMemory } from '../../../../../engine/src/desktop/coworker-share-memory/capture'
import { memoryArchiveMembersToNotes } from '../../../../../engine/src/desktop/coworker-share-memory/members'
import { measureNotes, packageDigest, renderMemoryMarkdown } from '../../../../../engine/src/desktop/coworker-share-memory/serialize'
import { readPortableArchive, sealPortableManifest, writePortableArchive } from '../../../../../engine/src/desktop/templates/portable-package'
import { isTemplateManifestPath } from '../../../../../engine/src/desktop/templates/install'
import { DesktopHttpError } from '../auth'

/** Existing memory preview contract; no note content is sent to the options panel. */
export function memoryPreviewFromSource(source: DesktopCoworkerShareSource): DesktopCoworkerShareMemoryPreview {
    const notes = memoryArchiveMembersToNotes(source.members.filter(member => member.path.startsWith('memory/') && member.ownership === 'user' && !member.flagged.length && !scanPathForSecrets(member.path).length).map(member => ({ path: member.path, bytes: Buffer.from(member.bytes) })))
    return { available: true, contents: measureNotes(notes), digest: packageDigest(notes) }
}

/** Validate the reviewed archive first; project ONLY template members into its existing installer. */
export async function prepareMemoryShareImport(bytes: Buffer, workspaceId: number, requestId: string) {
    const restored = await readPortableArchive(bytes)
    if (restored.manifest.coworkers.length !== 1) throw new DesktopHttpError(409, 'A coworker share must contain exactly one coworker.')
    const memory = restored.members.filter(member => member.path.startsWith('memory/'))
    const core = restored.members.filter(member => !member.path.startsWith('memory/'))
    if (core.some(member => !isTemplateManifestPath(member.path))) throw new DesktopHttpError(409, 'Database and other non-template content remain unavailable for portable import.')
    if (!memory.length) return { templateBytes: bytes, memories: null }
    const notes = memoryArchiveMembersToNotes(memory)
    for (let index = 0; index < notes.length; index++) {
        if (scanPathForSecrets(memory[index]!.path).length || scanTextForSecrets(memory[index]!.bytes.toString('utf8')).length) throw new DesktopHttpError(409, 'A portable memory is flagged as containing credentials.')
        if (!memory[index]!.bytes.equals(Buffer.from(renderMemoryMarkdown(notes[index]!)))) throw new DesktopHttpError(409, 'Memory bytes do not match the reviewed canonical note format.')
    }
    const memories = await captureDesktopCoworkerShareMemory({ workspaceId, agentId: restored.manifest.packageKey, listOwnedNotes: async () => notes }, { requestId, includeMemories: true, capturedAt: restored.manifest.capturedAt })
    if ('unavailable' in memories) throw new DesktopHttpError(503, memories.reason)
    const { contentDigest: _digest, ...body } = restored.manifest
    const manifest = sealPortableManifest({
        ...body,
        coworkers: body.coworkers.map(coworker => ({ ...coworker, members: coworker.members.filter(member => !member.path.startsWith('memory/')) })),
        excludedCategories: [...new Set([...body.excludedCategories, 'memory' as const, 'private-memory' as const])],
    })
    const projected = await writePortableArchive({ title: manifest.title, packageKey: manifest.packageKey, manifest, members: core, startedAt: Date.now() })
    return { templateBytes: projected.archiveBytes, memories }
}
