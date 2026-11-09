import type { DesktopCoworkerImportDatabase } from '@/lib/desktop/coworker-share/import-review'
import { formatBytes } from '@/lib/files/format'

export function DesktopCoworkerImportDatabaseReview({ database }: { database: DesktopCoworkerImportDatabase }) {
    return <section aria-label="Coworker database" className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
        <h4 className="font-medium">Coworker database</h4>
        {database.status === 'verified' ? <>
            <p className="mt-1 text-muted-foreground">{database.contents.count} private table{database.contents.count === 1 ? '' : 's'} · {database.viewCount} saved view{database.viewCount === 1 ? '' : 's'} · {formatBytes(database.contents.bytes)}</p>
            <p className="mt-1 text-muted-foreground">Verified from this portable file. Record values are not displayed.</p>
        </> : <p className="mt-1 text-muted-foreground">{database.status === 'absent'
            ? 'This portable file does not include a logical private database section. This does not describe the source coworker’s current database.'
            : database.status === 'legacy'
                ? 'This older portable file contains a raw SQLite database member. Its table and saved-view counts are not verified, and this format cannot be added.'
                : 'Database inspection is unavailable. Reopen this portable file with the current local service before approving an import.'}</p>}
    </section>
}
