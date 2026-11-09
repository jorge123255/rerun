import { ListChecksIcon } from '@/lib/icons'
import { requestDesktopGettingStartedReopen } from './reopen'

/**
 * Not mounted. Root adds this id to `DESKTOP_CONTROL_COMMAND_IDS`, the icon map, and
 * `buildDesktopControlCommands`, then calls `requestDesktopGettingStartedReopen` on select.
 * This file does not edit DesktopControlCenter.
 */
export const DESKTOP_GETTING_STARTED_COMMAND = {
    id: 'getting_started',
    group: 'actions',
    label: 'Getting started',
    keywords: ['onboarding', 'checklist', 'setup', 'progress', 'milestones'],
    icon: ListChecksIcon,
    run: requestDesktopGettingStartedReopen,
} as const
