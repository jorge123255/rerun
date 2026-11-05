'use client'

import { IconBadge } from '@/components/ui/icon-badge'
import { Icon } from '@/components/ui/icon'
import { CheckIcon, Package, PencilIcon, ShieldCheckIcon, UsersIcon, type LucideIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopCaptureStep } from './useDesktopCaptureFlow'

export type DesktopCaptureProgressStep = 'title' | DesktopCaptureStep

const STAGES: { step: DesktopCaptureProgressStep; icon: LucideIcon; title: string; description: string; points: string[] }[] = [
    { step: 'title', icon: PencilIcon, title: 'Name your template', description: 'The private draft is saved before capture.', points: ['Local workspace only', 'Exact saved revision'] },
    { step: 'select', icon: UsersIcon, title: 'Pick your coworkers', description: 'Only existing local coworkers and safe source metadata are offered.', points: ['No browser file paths', 'Source revisions recorded'] },
    { step: 'review', icon: ShieldCheckIcon, title: 'Security review', description: 'Choose the confined text files and user-owned skills that travel.', points: ['Credentials and histories excluded', 'Review selected prose yourself'] },
    { step: 'done', icon: Package, title: 'Capture', description: 'The server saves one exact private template revision.', points: ['Exclusions remain visible', 'Warnings, not surprises'] },
]

export function DesktopCaptureProgressPanel({ step }: { step: DesktopCaptureProgressStep }) {
    const activeIndex = STAGES.findIndex(stage => stage.step === step)
    return <div className="hidden min-h-0 flex-col border-l bg-muted/30 sm:flex">
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
            <ol className="relative flex flex-col gap-4">
                {STAGES.map((stage, index) => {
                    const state = index < activeIndex ? 'done' : index === activeIndex ? 'current' : 'upcoming'
                    const Glyph = state === 'done' ? CheckIcon : stage.icon
                    return <li key={stage.step} className={cn('overflow-hidden rounded-lg border bg-card p-4 transition-colors', state === 'current' ? 'border-foreground/20' : 'border-border/60', state === 'upcoming' && 'opacity-60')}>
                        <div className="flex items-center gap-2.5"><Icon icon={Glyph} size="sm" /><p className="text-sm font-medium">{stage.title}</p></div>
                        <p className="mt-2 text-xs text-muted-foreground">{stage.description}</p>
                        <ul className="mt-3 flex flex-col gap-2">{stage.points.map(point => <li key={point} className="flex items-center gap-2">
                            <IconBadge tone={state === 'done' ? 'green' : 'neutral'} icon={CheckIcon} glow={false} />
                            <span className="min-w-0 text-xs font-medium">{point}</span>
                        </li>)}</ul>
                    </li>
                })}
            </ol>
        </div>
    </div>
}
