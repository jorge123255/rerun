import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import {
    DESKTOP_OPENCODE_CONNECTION_ID, DESKTOP_OPENCODE_DEFAULT_MODEL, desktopOpencodeConnectionChange,
    desktopOpencodeConnectionView, desktopOpencodeDefaultModelIds, desktopOpencodeEnableProblem,
    desktopOpencodeKeyProblem, type BoxDefaultModel, type DesktopOpencodeConnectionChange,
} from '@rerun/contracts'
import { z } from 'zod'
import { forgetCredentialRejected } from '../../connections/credential-rejections.js'
import { readEnvFile, writeEnvFile } from '../../lib/env-file.js'
import { HttpError } from '../../lib/errors.js'
import { withKeyedLock } from '../../lib/lock.js'

const savedConnection = desktopOpencodeConnectionView.extend({ apiKey: z.string().min(1) })
const recordKey = 'RERUN_DESKTOP_OPENCODE_CONNECTION'
const changed = () => new HttpError(409, 'OpenCode connection changed. Reload Settings and try again.')

type Options = {
    path: string
    workspaceId: number
    admit: (epoch?: number) => number
    knownModels: () => string[]
    readDefault: () => Promise<BoxDefaultModel | null>
}

export function createDesktopOpencodeConnectionStore({ path, workspaceId, admit, knownModels, readDefault }: Options) {
    const read = async () => {
        const raw = (await readEnvFile(path))[recordKey]
        if (!raw) return null
        const saved = savedConnection.parse(JSON.parse(raw))
        if (saved.workspaceId !== workspaceId || desktopOpencodeKeyProblem(saved.apiKey)) throw changed()
        return saved
    }

    return {
        async projection() {
            const saved = await read()
            return saved && desktopOpencodeConnectionView.parse(saved)
        },
        withSelection<T>(work: () => Promise<T>) {
            return withKeyedLock(path, async () => { admit(); return work() })
        },
        async view(signal: AbortSignal) {
            const epoch = admit()
            const saved = await read()
            signal.throwIfAborted()
            admit(epoch)
            return saved && desktopOpencodeConnectionView.parse(saved)
        },

        async credential(revision: string, signal: AbortSignal) {
            const epoch = admit()
            const saved = await read()
            signal.throwIfAborted()
            admit(epoch)
            if (!saved || saved.revision !== revision) throw changed()
            return saved.apiKey
        },

        async change(raw: DesktopOpencodeConnectionChange, signal: AbortSignal) {
            const change = desktopOpencodeConnectionChange.parse(raw)
            if (change.workspaceId !== workspaceId) throw changed()
            const epoch = admit()
            return withKeyedLock(path, async () => {
                signal.throwIfAborted()
                admit(epoch)
                const previous = await read()
                if ((previous?.revision ?? null) !== change.expectedRevision) throw changed()
                const selected = await readDefault()
                const workspaceModel = selected?.connectionId === DESKTOP_OPENCODE_CONNECTION_ID ? selected.model : null
                signal.throwIfAborted()
                admit(epoch)
                if (change.action === 'disconnect') {
                    if (!previous) throw changed()
                    if (workspaceModel) throw new HttpError(409, 'Choose a different workspace default before disconnecting OpenCode.')
                    await rm(path)
                    forgetCredentialRejected(DESKTOP_OPENCODE_CONNECTION_ID)
                    return null
                }

                const revision = randomUUID()
                let next
                if (change.action === 'key') {
                    const problem = desktopOpencodeKeyProblem(change.apiKey)
                    if (problem) throw new HttpError(400, problem)
                    next = {
                        workspaceId, connectionId: DESKTOP_OPENCODE_CONNECTION_ID, name: 'OpenCode',
                        consoleEnabled: false, enabledModelIds: desktopOpencodeDefaultModelIds(),
                        defaultModelId: DESKTOP_OPENCODE_DEFAULT_MODEL, ...previous, revision, apiKey: change.apiKey,
                    }
                } else {
                    if (!previous) throw changed()
                    if (change.action === 'rename') next = { ...previous, revision, name: change.name }
                    else {
                        const enabledModelIds = [...new Set(change.enabledModelIds)]
                        const problem = desktopOpencodeEnableProblem({ ...change, enabledModelIds, knownIds: knownModels() })
                        if (problem) throw new HttpError(400, problem)
                        if (workspaceModel && !enabledModelIds.includes(workspaceModel))
                            throw new HttpError(409, 'Choose a different workspace default before removing this model.')
                        next = { ...previous, revision, enabledModelIds, defaultModelId: change.defaultModelId, consoleEnabled: change.consoleEnabled }
                    }
                }
                await writeEnvFile(path, { [recordKey]: JSON.stringify(savedConnection.parse(next)) }, () => {
                    signal.throwIfAborted()
                    admit(epoch)
                })
                if (change.action === 'key') forgetCredentialRejected(DESKTOP_OPENCODE_CONNECTION_ID)
                return desktopOpencodeConnectionView.parse(next)
            })
        },
    }
}
