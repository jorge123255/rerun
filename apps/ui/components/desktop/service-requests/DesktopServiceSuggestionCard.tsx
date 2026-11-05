'use client'

import { BorderBeam } from '@rerun/ui'
import { AnimatePresence, motion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { IconBadge } from '@/components/ui/icon-badge'
import { Separator } from '@/components/ui/separator'
import { StepDots } from '@/components/ui/step-dots'
import { ArrowRight, CheckIcon, Loader2Icon } from '@/lib/icons'
import { serviceIconProps } from '@/lib/services/icons'
import { cn } from '@/lib/utils'

export type DesktopServiceSuggestionCardProps = {
    name: string
    slug: string
    reason?: string
    icon: string | null
    category: string
    current: number
    count: number
    selected: boolean[]
    skipped: boolean
    unavailableReason?: string
    connectionMessage?: string
    canConnect: boolean
    canUseConnection: boolean
    canAdvance: boolean
    configuring: boolean
    busy: boolean
    disabled?: boolean
    inline?: boolean
    onConnect: () => void
    onCancel: () => void
    onSkip: () => void
    onAdvance: () => void
    onSelect: (index: number) => void
}

export function DesktopServiceSuggestionCard(props: DesktopServiceSuggestionCardProps) {
    const { name, slug, reason, icon, category, current, count, selected, skipped, unavailableReason,
        connectionMessage, canConnect, canUseConnection, canAdvance, configuring, busy, disabled, inline,
        onConnect, onCancel, onSkip, onAdvance, onSelect } = props
    const locked = !!disabled || busy || configuring
    const multiple = count > 1
    const last = current === count - 1
    return <div className={cn('relative min-w-0 space-y-3 overflow-hidden rounded-lg border border-border bg-muted/30 p-3', !inline && 'mb-2')} aria-busy={busy}>
        <BorderBeam animated pattern="arcs" tone="brand" glow width={1} duration={7} />
        <AnimatePresence mode="wait" initial={false}>
            <motion.div key={`${current}:${slug}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="relative min-w-0 space-y-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                    <Icon {...serviceIconProps(icon, category)} size="sm" />
                    <div className="min-w-0 flex-1 basis-32">
                        <span className="block wrap-anywhere font-medium leading-snug">{name}</span>
                        {reason && <p className="whitespace-pre-wrap wrap-anywhere text-xs text-muted-foreground">{reason}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                        {configuring ? <Button size="sm" variant="ghost" disabled={!!disabled} onClick={onCancel}>Cancel</Button> : <>
                            {!multiple && <Button size="sm" variant="ghost" disabled={locked} onClick={onSkip}>Not now</Button>}
                            {canConnect && <Button size="sm" disabled={locked} onClick={onConnect}>Connect</Button>}
                        </>}
                    </div>
                </div>
                {(unavailableReason || connectionMessage || skipped || configuring || selected[current]) && <>
                    <Separator className="-mx-3 border-t border-dashed bg-transparent data-horizontal:h-0 data-horizontal:w-auto" />
                    {configuring ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon className="size-4 shrink-0 animate-spin" />Complete setup in Apps, then return here.</p>
                        : selected[current] ? <div className="flex min-w-0 items-center gap-2 text-sm"><IconBadge tone="green" icon={CheckIcon} glow={false} /><span className="wrap-anywhere font-medium">{name} connection selected</span></div>
                            : skipped ? <p className="text-sm text-muted-foreground">Skipped.</p> : null}
                    {!configuring && unavailableReason && <p className="whitespace-pre-wrap wrap-anywhere text-sm text-muted-foreground">{unavailableReason}</p>}
                    {!configuring && connectionMessage && <p className="whitespace-pre-wrap wrap-anywhere text-xs text-muted-foreground">{connectionMessage}</p>}
                </>}
            </motion.div>
        </AnimatePresence>
        <Separator className="-mx-3 data-horizontal:w-auto" />
        <div className="relative flex flex-wrap items-center gap-2">
            {multiple && <div className="max-w-full overflow-x-auto py-1"><StepDots count={count} current={current} answered={selected} onSelect={onSelect} disabled={locked} /></div>}
            <div className="ml-auto flex flex-wrap items-center gap-2">
                {multiple && <Button size="sm" variant="outline" disabled={locked} onClick={onSkip}>Skip</Button>}
                <Button size="sm" disabled={locked || !canAdvance} onClick={onAdvance} aria-label={last ? 'Finish' : 'Next app'}>
                    {busy && <Loader2Icon className="size-4 animate-spin" />}
                    {last ? 'Finish' : 'Next'}<ArrowRight className="size-4" />
                </Button>
            </div>
        </div>
        {!configuring && canUseConnection && !selected[current] && <p className="relative text-xs text-muted-foreground">{last ? 'Finish' : 'Next'} selects this current connection. Apps permission and health are checked by the server.</p>}
    </div>
}
