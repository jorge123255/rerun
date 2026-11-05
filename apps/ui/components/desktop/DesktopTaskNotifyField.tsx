'use client'

import { Field } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { coworkerRuleOf, taskKey, taskNotifies } from '@/lib/notifications/prefs'
import type { TaskSource } from '@/lib/schedules/outcomes'
import { useDesktopNotificationPrefs } from '@/lib/desktop/use-notification-prefs'
import { Button } from '@/components/ui/button'

// The routine editor's « Notify me » switch: same Field+Switch+tooltip composition as the
// original task field, bound to the exact coworker/source/slug task rule on this Mac. Mount it
// only for a saved task — an unsaved draft has no slug to key the rule by.
export function DesktopTaskNotifyField({ agentId, source, slug, disabled = false }: { agentId: string; source: TaskSource; slug: string; disabled?: boolean }) {
    const { prefs, update, ready, readError, refresh } = useDesktopNotificationPrefs()
    if (!slug) return null
    const muted = coworkerRuleOf(prefs, agentId).mode === 'muted'
    return (
        <><Field orientation="row" label="Notify me">
            <TooltipDisabledReason reason={muted ? 'This coworker is muted' : undefined}>
                <Switch
                    checked={taskNotifies(prefs, agentId, source, slug)}
                    disabled={muted || !ready || disabled}
                    onCheckedChange={on => update({ tasks: { [taskKey(agentId, source, slug)]: on } })}
                />
            </TooltipDisabledReason>
        </Field>{readError && <p role="status" className="text-xs text-muted-foreground">Could not load notification settings. <Button type="button" size="sm" variant="link" onClick={() => void refresh()}>Retry</Button></p>}</>
    )
}
