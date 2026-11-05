import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildId, output, repoRoot } from './lib.mjs'

export const STAMP_FILE = 'desktop-build.json'

export async function sourceStamp() {
    const dirty = await output('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoRoot })
    if (dirty) throw new Error('Commit or move source changes and untracked files before staging a desktop build')
    return { protocolVersion: 1, sourceCommit: await output('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }), buildId: await buildId() }
}

export async function stampMatches(directory, expected) {
    try {
        const value = JSON.parse(await readFile(join(directory, STAMP_FILE), 'utf8'))
        return value.protocolVersion === expected.protocolVersion && value.sourceCommit === expected.sourceCommit && value.buildId === expected.buildId
    } catch { return false }
}

export async function writeStamp(directory, stamp) {
    await writeFile(join(directory, STAMP_FILE), JSON.stringify(stamp, null, 2) + '\n')
}

export async function requireStamp(directory, expected) {
    if (!await stampMatches(directory, expected)) throw new Error(`Stale or unverified staged output: ${directory}. Rebuild before writing a runtime manifest.`)
}

export const stageArguments = () => ['--build']
