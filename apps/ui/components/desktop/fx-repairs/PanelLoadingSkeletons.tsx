import type { ReactNode } from 'react'
import { SkeletonFileGrid, SkeletonPanelRows, SkeletonForm, SkeletonCardGrid } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

function Loading({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
    return <div role="status" aria-live="polite" aria-busy="true" className={cn('min-h-0 min-w-0 max-w-full overflow-x-hidden overflow-y-auto [&_*]:motion-reduce:animate-none', className)}>
        <span className="sr-only">{label}</span><div aria-hidden="true" inert>{children}</div>
    </div>
}
export function FxFilesLoading() { return <Loading label="Loading files…"><SkeletonFileGrid tiles={10} /></Loading> }
export function FxMemoriesLoading({ searching = false }: { searching?: boolean }) { return <Loading label={searching ? 'Searching memories…' : 'Loading memories…'}><SkeletonPanelRows rows={5} badge /></Loading> }
export function FxSettingsLoading() { return <Loading label="Loading coworker settings…" className="flex flex-col gap-4 p-4"><SkeletonForm /></Loading> }
export function FxSchedulesLoading({ label = 'Loading scheduled tasks…' }: { label?: string }) { return <Loading label={label}><SkeletonPanelRows rows={5} lines={3} badge /></Loading> }
export function FxToolsLoading() { return <Loading label="Loading tools…"><SkeletonCardGrid rows={6} className="p-3" /></Loading> }
