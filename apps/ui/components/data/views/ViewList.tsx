'use client'

import type { DbRow } from '@/components/data/DataBrowserTable'
import type { TableView } from '@rerun/contracts'
import { ListItem, type CellContext } from '@rerun/ui/chat'

type ViewListProps = { view: TableView; rows: DbRow[]; context: CellContext; onOpenRow?: (row: DbRow, trigger: HTMLElement) => void }

export function ViewList({ view, rows, context, onOpenRow }: ViewListProps) {
    return (
        <ul className="divide-y divide-border">
            {rows.map((row, i) => (
                <li key={String(row.__rowid ?? i)}>
                    {onOpenRow ? (
                        <button type="button" onClick={event => onOpenRow(row, event.currentTarget)} className="block w-full text-left transition-colors hover:bg-accent/40">
                            <ListItem row={row} fields={view.fields ?? {}} formats={view.formats ?? {}} context={context} />
                        </button>
                    ) : (
                        <ListItem row={row} fields={view.fields ?? {}} formats={view.formats ?? {}} context={context} />
                    )}
                </li>
            ))}
        </ul>
    )
}
