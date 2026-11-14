'use client'

import { Box, LayoutGrid, PanelLeft } from 'lucide-react'
import { TooltipLabeled } from '@/components/ui/tooltip'
import type { DesktopWorkspaceView } from '@/lib/desktop/workspace-view'
import { cn } from '@/lib/utils'
import { useDesktopLocale } from '../DesktopLocale'

const VIEWS = [{ value: 'board', icon: Box }, { value: 'simple', icon: PanelLeft }] as const

// A plain row of the workspace menu, like upstream's: the icons take the click and the menu stays
// open on the view it switched to.
export function DesktopViewMenuRow({ view, onChange, disabled = false }: { view: DesktopWorkspaceView; onChange: (view: DesktopWorkspaceView) => void; disabled?: boolean }) {
    const { t } = useDesktopLocale()
    return <div className="flex items-center gap-2 px-1.5 py-1 text-sm text-muted-foreground">
        <LayoutGrid className="size-4" />
        {t('workspaceView.switch.label')}
        <div role="radiogroup" aria-label={t('workspaceView.switch.label')} className="ml-auto inline-flex shrink-0 origin-right scale-90 items-center gap-0.5 rounded-lg bg-muted p-0.5">
            {VIEWS.map(option => {
                const active = option.value === view
                const label = t(`workspaceView.switch.${option.value}`)
                return <TooltipLabeled key={option.value} label={label}>
                    <button type="button" role="radio" aria-checked={active} aria-label={label} disabled={disabled} onClick={() => onChange(option.value)}
                        className={cn('flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-50', active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                        <option.icon className="size-3.5" />
                    </button>
                </TooltipLabeled>
            })}
        </div>
    </div>
}
