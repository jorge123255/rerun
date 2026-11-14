'use client'

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useId } from 'react'

import { Field } from '@/components/ui/field'
import { IconBadge } from '@/components/ui/icon-badge'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useDesktopLocale } from '@/components/desktop/DesktopLocale'
import { CheckIcon } from '@/lib/icons'
import type { DesktopForemanIntakeController } from '@/lib/desktop/foreman-intake'
import type { IntakeDraft } from '@/lib/desktop/foreman-intake'
import { desktopIntakeFieldHandlers } from './DesktopIntakeField'

type Props = {
    draft: IntakeDraft
    siteRead: DesktopForemanIntakeController['siteRead']
    platform: string | null
    disabled?: boolean
    autoFocus?: boolean
    onChange: (patch: Partial<IntakeDraft>) => void
    onEnter: () => void
}

const ADORNMENT_MOTION = {
    initial: { opacity: 0, scale: 0.9 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.9 },
    transition: { duration: 0.16 },
}

export function DesktopIntakeCompanyStep({ draft, siteRead, platform, disabled, autoFocus = true, onChange, onEnter }: Props) {
    const siteId = useId()
    const { t } = useDesktopLocale()
    const still = useReducedMotion()
    const motionProps = still ? { initial: false, animate: {}, exit: {}, transition: { duration: 0 } } : ADORNMENT_MOTION

    return (
        <Field label={t('foreman.intake.website.label')} htmlFor={siteId}>
            <div className="relative">
                <Input
                    id={siteId}
                    aria-invalid={platform ? true : undefined}
                    aria-describedby={platform ? siteId + '-platform' : undefined}
                    autoFocus={autoFocus}
                    value={draft.companyUrl}
                    disabled={disabled}
                    placeholder="acme.com"
                    onChange={event => onChange({ companyUrl: event.target.value })}
                    {...desktopIntakeFieldHandlers(onEnter)}
                    className="pr-11"
                />
                <div className="pointer-events-none absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">
                    <AnimatePresence mode="wait" initial={false}>
                        {siteRead === 'reading' && (
                            <motion.div key="reading" {...motionProps} className="flex size-7 items-center justify-center">
                                <Spinner className="text-muted-foreground" />
                            </motion.div>
                        )}
                        {siteRead === 'ready' && (
                            <motion.div key="ready" {...motionProps} className="flex size-7 items-center justify-center">
                                <IconBadge tone="green" icon={CheckIcon} />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>
            {platform && <p id={siteId + '-platform'} className="text-xs text-destructive">{t('foreman.intake.website.platform', { domain: platform })}</p>}
        </Field>
    )
}
