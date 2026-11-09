'use client'

import { FriendlyCell } from '@/components/data/FriendlyCell'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { isEmpty, rowCurrency, type FriendlyColumn } from '@/lib/data/friendly-columns'
import { cn } from '@/lib/utils'
import type { BadgeTone } from '@rerun/ui/primitives'
import type { ReactNode } from 'react'

export type LeadField = { key: string; label: string; value: ReactNode }

const FIELD_ROW = 'flex min-h-11 w-full items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0'

function FieldRowContent({ field }: { field: LeadField }) {
    return (
        <>
            <span className="w-20 shrink-0 truncate text-xs text-muted-foreground sm:w-24">{field.label}</span>
            <span className="min-w-0 flex-1 text-sm break-words text-foreground">{field.value}</span>
        </>
    )
}

/** Every field of a row. Source logos stay off until a later provenance pass supplies them. */
export function LeadFieldList({ fields, className }: { fields: readonly LeadField[]; className?: string }) {
    return (
        <div className={cn('flex flex-col rounded-xl border border-border bg-background', className)}>
            {fields.map(field => (
                <div key={field.key} className={FIELD_ROW}>
                    <FieldRowContent field={field} />
                </div>
            ))}
        </div>
    )
}

type Row = Record<string, unknown>

export function leadFields(row: Row, columns: readonly FriendlyColumn[], tones?: Record<string, BadgeTone>): LeadField[] {
    const currency = rowCurrency(row)
    return columns
        .filter(column => column.kind === 'boolean' || !isEmpty(row[column.key]))
        .map(column => ({
            key: column.key,
            label: column.label,
            value: <FriendlyCell value={row[column.key]} column={column} currency={currency} tones={tones} maxTags={6} wrap />,
        }))
}

function rowTitle(row: Row, columns: readonly FriendlyColumn[]): string {
    const title = columns.find(column => column.kind === 'title' && !isEmpty(row[column.key])) ?? columns.find(column => !isEmpty(row[column.key]) && typeof row[column.key] === 'string')
    return title ? String(row[title.key]) : 'Row'
}

type LeadSourcesSheetProps = {
    row: Row | null
    onOpenChange: (open: boolean) => void
    /** The columns to list, in order. */
    columns: readonly FriendlyColumn[]
    /** Provenance is not read here. The field list still renders when this is null. */
    sources: null
    tones?: Record<string, BadgeTone>
}

export function LeadSourcesSheet({ row, onOpenChange, columns, sources, tones }: LeadSourcesSheetProps) {
    return (
        <Sheet open={row !== null} onOpenChange={onOpenChange}>
            <SheetContent className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
                {row && (
                    <>
                        <SheetHeader className="shrink-0 pr-12">
                            <SheetTitle className="truncate">{rowTitle(row, columns)}</SheetTitle>
                            <SheetDescription asChild>
                                <div className="flex min-h-5 items-center">{sources}</div>
                            </SheetDescription>
                        </SheetHeader>
                        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                            <LeadFieldList fields={leadFields(row, columns, tones)} />
                        </div>
                    </>
                )}
            </SheetContent>
        </Sheet>
    )
}
