import 'server-only'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { BigIntStats } from 'node:fs'
import { openWithoutLinks } from '../../../../../engine/src/desktop/open-without-links.ts'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { findDesktopAgent } from '../store'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { withRosterWrite } from '../roster-writes'
import type { DesktopResultFileAuthority } from './handler'

const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid
const changed = () => new DesktopHttpError(409, 'This file changed and was left unopened.')

export const localResultFileAuthority: DesktopResultFileAuthority = {
    read(input) {
        return withRosterWrite(async () => {
            const signal = AbortSignal.any([input.signal, AbortSignal.timeout(20_000)])
            const db = await openDesktopDatabase(input.runtime.dataRoot)
            const assertOwner = async () => {
                signal.throwIfAborted()
                await assertCoworkerNotDeleting(db, input.agentId)
                const owner = await findDesktopAgent(db, input.agentId)
                if (!owner || owner.engineAgentId !== input.engineAgentId) throw new DesktopHttpError(404, 'Coworker not found')
                signal.throwIfAborted()
            }
            await assertOwner()
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.engineAgentId)) throw new DesktopHttpError(400, 'This coworker has no readable workspace.')
            const dataRoot = await realpath(/* turbopackIgnore: true */ input.runtime.dataRoot)
            const relativeRoot = input.scope === 'shared' ? ['workspaces', '1', 'engine', 'shared']
                : ['workspaces', '1', 'engine', 'agents', input.engineAgentId, 'workspace']
            const pathParts = input.path.split('/')
            if (pathParts.length > 64 || pathParts.some(part => !part || part.startsWith('.') || /[\\\p{Cc}]/u.test(part))) throw new DesktopHttpError(400, 'Choose a visible workspace file.')
            const parents: { path: string; stat: BigIntStats }[] = []
            let directory = dataRoot
            const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : -BigInt(1)
            for (const part of ['', ...relativeRoot, ...pathParts.slice(0, -1)]) {
                if (part) directory = join(/* turbopackIgnore: true */ directory, part)
                const handle = await openWithoutLinks(directory, true)
                try {
                    const stat = await handle.stat({ bigint: true })
                    if (!stat.isDirectory() || stat.uid !== uid) throw changed()
                    parents.push({ path: directory, stat })
                } finally { await handle.close() }
            }
            const path = join(/* turbopackIgnore: true */ directory, pathParts.at(-1)!)
            const handle = await openWithoutLinks(path)
            try {
                const before = await handle.stat({ bigint: true })
                if (!before.isFile() || before.nlink !== BigInt(1) || before.uid !== uid || `${before.dev}:${before.ino}` !== input.identity || before.size !== BigInt(input.size)) throw changed()
                const bytes = new Uint8Array(input.size)
                let got = 0
                while (got < bytes.length) {
                    signal.throwIfAborted()
                    const part = await handle.read(bytes, got, bytes.length - got, got)
                    if (!part.bytesRead) throw changed()
                    got += part.bytesRead
                }
                const still = await openWithoutLinks(path)
                try {
                    for (const current of [await handle.stat({ bigint: true }), await still.stat({ bigint: true })]) {
                        if (!same(before, current) || !current.isFile() || current.nlink !== BigInt(1) || current.size !== before.size || current.ctimeNs !== before.ctimeNs || current.mtimeNs !== before.mtimeNs) throw changed()
                    }
                } finally { await still.close() }
                for (const parent of parents) {
                    const current = await openWithoutLinks(parent.path, true)
                    try { if (!same(parent.stat, await current.stat({ bigint: true }))) throw changed() }
                    finally { await current.close() }
                }
                await assertOwner()
                return { bytes, identity: input.identity, size: input.size }
            } finally { await handle.close() }
        })
    },
}
