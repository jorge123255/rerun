import type { DesktopCoworkerShareMemoryPackage } from '@rerun/contracts'
import { memoryMemberPath, parseMemoryMarkdown, renderMemoryMarkdown } from './serialize.ts'

export type DesktopCoworkerShareMemoryArchiveMember = {
    path: string
    bytes: Buffer
}

/** Project an A package into original-style memory/*.md members for archive composition by root/E. */
export function memoryPackageToArchiveMembers(pkg: DesktopCoworkerShareMemoryPackage): DesktopCoworkerShareMemoryArchiveMember[] {
    return pkg.notes.map(note => ({
        path: memoryMemberPath(note.id),
        bytes: Buffer.from(renderMemoryMarkdown(note), 'utf8'),
    }))
}

export function memoryArchiveMembersToNotes(members: readonly DesktopCoworkerShareMemoryArchiveMember[]) {
    return members.map(member => parseMemoryMarkdown(member.path, member.bytes.toString('utf8')))
}
