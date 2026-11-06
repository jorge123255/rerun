/** User-facing product language. Never expose stack traces or file paths in the flow. */

export const WORKSPACE_COPY = {
    nameRequired: 'Name is required',
    nameTooLong: (max) => `Keep the name under ${max} characters`,
    unknownIcon: 'Unknown icon',
    notFound: 'That workspace is not available on this Mac.',
    pathMissing: 'This workspace folder is missing. Choose another workspace or recreate it.',
    pathCorrupt: 'This workspace folder cannot be opened. Choose another workspace.',
    pathForeign: 'This folder is not one of your workspaces.',
    busy: 'A workspace switch is already in progress. Wait for it to finish, then try again.',
    admissionsFrozen: 'Rerun is finishing other work before it can switch workspaces. Try again in a moment.',
    draftFlushFailed: 'Unsent drafts could not be saved. Stay in this workspace to keep them, then try switching again.',
    drainFailed: 'Local work could not be closed cleanly. Stay in this workspace and try again.',
    runtimeCloseFailed: 'Local services could not confirm they stopped. Try again before switching.',
    runtimeStartFailed: 'The other workspace could not start. Rerun will keep trying to recover it.',
    identityMismatch: 'The workspace that started does not match the one you selected.',
    cancelled: 'Workspace switch was cancelled.',
    quitInProgress: 'Rerun is quitting, so the workspace cannot change right now.',
    authorityMissing: (name) => `Switching workspaces needs a missing app capability (${name}).`,
    createFailed: 'The workspace could not be created.',
    renameFailed: 'The workspace could not be renamed.',
    retry: 'Try again',
    switching: 'Switching workspace…',
    preparing: 'Preparing your workspace…',
}

export function refusal(code, message, authority) {
    const body = { ok: false, code, message }
    if (authority) body.authority = authority
    return body
}
