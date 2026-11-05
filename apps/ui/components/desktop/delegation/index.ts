'use client'

export { DesktopDelegationBlock, type DesktopDelegationBlockProps } from './DesktopDelegationBlock'
export { DesktopDelegationMount, DESKTOP_DELEGATION_POLL_MS, type DesktopDelegationMountProps, type DesktopDelegationView } from './DesktopDelegationMount'
export { DesktopDelegationTree, type DesktopDelegationTreeProps } from './DesktopDelegationTree'
export { DELEGATION_EMPTY_RESULT, DELEGATION_OUTCOME_UNREAD, delegationDetail, delegationOutcome, delegationTaskToSubRun, type DesktopDelegationOutcome } from './task-view'
export {
    createDesktopDelegationClient,
    delegationUrl,
    projectDelegations,
    readDelegationList,
    readDelegationSnapshot,
    visibleDelegations,
    DELEGATION_LIST_UNAVAILABLE,
    DELEGATION_LIST_UNREADABLE,
    DELEGATION_STOP_UNAVAILABLE,
    DELEGATION_STOP_UNFINISHED,
    DELEGATION_UNREADABLE,
    DesktopDelegationReadError,
    type DesktopDelegationClient,
    type DesktopDelegationFilter,
    type DesktopDelegationReadKind,
    type DesktopDelegationStopInput,
} from '@/lib/desktop/delegation-client'
