'use client'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { TooltipLabeled } from '@/components/ui/tooltip'
import type { DesktopForemanPlacement } from '@/lib/desktop/foreman-client'
import { PanelLeftIcon, PanelRightIcon, PictureInPicture2Icon } from '@/lib/icons'
import type { ForemanAnchor } from '@rerun/ui/foreman'
import { useDesktopLocale } from '../DesktopLocale'

const POSITION_CHOICES = [
    { value: 'dock-left', labelKey: 'dockLeft', icon: PanelLeftIcon },
    { value: 'dock-right', labelKey: 'dockRight', icon: PanelRightIcon },
    { value: 'float', labelKey: 'float', icon: PictureInPicture2Icon },
] as const

export function desktopForemanAnchorOf(placement: DesktopForemanPlacement): ForemanAnchor {
    return placement.mode === 'float' ? 'float' : `dock-${placement.side}`
}

/** Floating from the menu puts the window at the bottom, on the side it was docked. */
export function desktopForemanPlacementFor(choice: ForemanAnchor, current: DesktopForemanPlacement): DesktopForemanPlacement {
    const size = { width: current.width, height: current.height, dockWidth: current.dockWidth }
    if (choice === 'dock-left') return { mode: 'dock', side: 'left', ...size }
    if (choice === 'dock-right') return { mode: 'dock', side: 'right', ...size }
    if (current.mode === 'float') return current
    return { mode: 'float', corner: current.side === 'left' ? 'bottom-left' : 'bottom-right', ...size }
}

/**
 * The header's Move button: dock left, dock right or float, the same three places dragging the
 * header reaches. Markup and placement rule from upstream apps/ui/components/foreman/ForemanHeader.tsx,
 * wired to the Mac's own saved placement.
 */
export function DesktopForemanMove({ placement, onPlacement, disabled }: {
    placement: DesktopForemanPlacement; onPlacement: (placement: DesktopForemanPlacement) => void; disabled?: boolean
}) {
    const { t } = useDesktopLocale()
    const choice = desktopForemanAnchorOf(placement)
    const ChoiceIcon = POSITION_CHOICES.find(option => option.value === choice)?.icon ?? PanelRightIcon
    return <DropdownMenu>
        <TooltipLabeled label={t('foreman.move')} side="bottom">
            <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t('foreman.moveChat')} disabled={disabled} className="max-md:hidden">
                    <ChoiceIcon className="size-3.5" />
                </Button>
            </DropdownMenuTrigger>
        </TooltipLabeled>
        <DropdownMenuContent align="end" className="w-auto" onPointerDown={event => event.stopPropagation()}>
            <DropdownMenuRadioGroup value={choice} onValueChange={value => onPlacement(desktopForemanPlacementFor(value as ForemanAnchor, placement))}>
                {POSITION_CHOICES.map(({ value, labelKey, icon: Icon }) => <DropdownMenuRadioItem key={value} value={value}>
                    <Icon />{t(`foreman.position.${labelKey}`)}
                </DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
        </DropdownMenuContent>
    </DropdownMenu>
}
