import { getWorkspace } from '../workspaces/catalog.mjs'
import { validWorkspaceId } from '../workspaces/paths.mjs'
import { ERRORS } from './protocol.mjs'

export function hiddenWorkspaceError() {
    const error = new Error('not_found')
    error.code = ERRORS.not_found
    return error
}

// A phone learns nothing about workspaces it was not approved for: a missing
// workspace, a different workspace, and a workspace that is not the one the
// Mac is running all look the same.
export async function assertDeviceWorkspace({ dataRoot, installId, device, requestedWorkspaceId, selectedWorkspaceId }) {
    const requested = Number(requestedWorkspaceId)
    if (!validWorkspaceId(requested) || !device || Number(device.workspaceId) !== requested) throw hiddenWorkspaceError()
    if (selectedWorkspaceId == null || Number(selectedWorkspaceId) !== requested) throw hiddenWorkspaceError()
    const { workspace } = await getWorkspace(dataRoot, installId, requested)
    if (!workspace) throw hiddenWorkspaceError()
    return workspace
}
