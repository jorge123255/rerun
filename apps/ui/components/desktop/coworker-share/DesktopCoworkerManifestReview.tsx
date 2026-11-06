'use client'

import type { DesktopCoworkerSnapshotManifest } from '@rerun/contracts'
import { Checkbox } from '@/components/ui/checkbox'
import { Field } from '@/components/ui/field'
import { formatBytes } from '@/lib/files/format'

export function DesktopCoworkerManifestReview({ manifest, archiveBytes, archiveSha256, sourceRevision, approved, onApprovedChange, disabled = false }: {
    manifest: DesktopCoworkerSnapshotManifest
    archiveBytes?: number
    archiveSha256?: string
    sourceRevision?: string
    approved: boolean
    onApprovedChange: (approved: boolean) => void
    disabled?: boolean
}) {
    const coworker = manifest.coworkers[0]
    if (!coworker || manifest.coworkers.length !== 1) return <p role="alert" className="text-xs text-destructive">A coworker portable file must contain exactly one coworker.</p>
    const instructions = coworker.members.filter(member => member.kind === 'instruction')
    const skills = coworker.members.filter(member => member.kind === 'skill')
    const totalBytes = coworker.members.reduce((total, member) => total + member.bytes, 0)
    return <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
            <p className="font-medium">{coworker.name} · {coworker.members.length} files · {formatBytes(totalBytes)}</p>
            <p className="mt-1 text-muted-foreground">{instructions.length} instruction file{instructions.length === 1 ? '' : 's'}, {skills.length} skill file{skills.length === 1 ? '' : 's'}; {coworker.members.filter(member => member.binary).length} binary file{coworker.members.filter(member => member.binary).length === 1 ? '' : 's'}.</p>
            {archiveBytes !== undefined && <p className="mt-1 text-muted-foreground">Portable archive: {formatBytes(archiveBytes)}</p>}
        </div>

        <p className="text-xs text-amber-500">Saved logins, chats and inherited permissions are excluded. Private information in selected instructions, files and skills is not automatically removed; review every path and digest before exporting.</p>
        <p className="text-xs text-muted-foreground">Binary files are copied byte-for-byte and are not text-scanned for secrets. Each member below is identified by its exact SHA-256.</p>

        {coworker.setup.prompt && <details open className="rounded-lg border border-border/60 p-3">
            <summary className="cursor-pointer text-xs font-medium">Setup instructions</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{coworker.setup.prompt}</pre>
        </details>}

        <details open className="rounded-lg border border-border/60 p-3">
            <summary className="cursor-pointer text-xs font-medium">Instructions, skills and files · {coworker.members.length}</summary>
            <ul className="mt-3 flex max-h-72 flex-col gap-3 overflow-y-auto">
                {coworker.members.map(member => <li key={member.path} className="min-w-0 border-t border-border/40 pt-2 first:border-t-0 first:pt-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <code className="min-w-0 break-all text-xs text-foreground">{member.path}</code>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{member.kind} · {formatBytes(member.bytes)}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">{member.binary ? 'Binary · not text-scanned' : member.textScanned ? 'Text scanned' : 'Not text-scanned'}{member.flagged.length ? ` · flagged: ${member.flagged.join(', ')}` : ''}</p>
                    <code className="mt-1 block break-all text-[10px] text-muted-foreground">SHA-256 {member.contentDigest}</code>
                </li>)}
            </ul>
        </details>

        {(coworker.exclusions.length > 0 || coworker.redactions.length > 0) && <details className="rounded-lg border border-border/60 p-3">
            <summary className="cursor-pointer text-xs font-medium">Excluded and redacted content</summary>
            <ul className="mt-2 space-y-1.5 text-xs">
                {coworker.exclusions.map(item => <li key={`${item.path}:${item.reason}`}><code className="break-all">{item.path}</code><span className="text-muted-foreground"> · excluded: {item.reason}</span></li>)}
                {coworker.redactions.map(item => <li key={`${item.path}:${item.reason}`}><code className="break-all">{item.path}</code><span className="text-muted-foreground"> · {item.reason}</span></li>)}
            </ul>
        </details>}

        {coworker.requirements.length > 0 && <section className="rounded-lg border border-amber-500/20 p-3">
            <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To provide again on a copy</h4>
            <ul className="mt-2 space-y-1 text-xs">{coworker.requirements.map(requirement => <li key={`${requirement.kind}:${requirement.name}`}><code>{requirement.name}</code><span className="text-muted-foreground"> · {requirement.kind}</span></li>)}</ul>
            <p className="mt-2 text-[11px] text-muted-foreground">Apps arrive disconnected. Values and permissions must be provided locally.</p>
        </section>}

        <details className="rounded-lg border border-border/60 p-3">
            <summary className="cursor-pointer text-xs font-medium">Archive and source identities</summary>
            <div className="mt-2 space-y-2 text-[10px] text-muted-foreground">
                <code className="block break-all">Manifest SHA-256 {manifest.contentDigest}</code>
                {archiveSha256 && <code className="block break-all">Archive SHA-256 {archiveSha256}</code>}
                {sourceRevision && <code className="block break-all">Source revision {sourceRevision}</code>}
            </div>
        </details>

        <div className="border-t border-border/60 pt-3">
            <Field orientation="row" label="I reviewed what this coworker carries" helperText="I reviewed the selected content, hashes, exclusions and setup requirements.">
                <Checkbox size="sm" aria-label="I reviewed what this coworker carries" disabled={disabled} checked={approved} onCheckedChange={value => onApprovedChange(value === true)} />
            </Field>
        </div>
    </div>
}
