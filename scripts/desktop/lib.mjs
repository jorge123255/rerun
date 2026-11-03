import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
export const desktopDir = join(repoRoot, 'apps', 'desktop')
export const resourcesDir = join(desktopDir, 'resources')
export const cacheDir = join(desktopDir, '.cache')

export const NODE_RUNTIME = {
    version: 'v22.23.4',
    arch: 'darwin-arm64',
    sha256: 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
}
export const nodeTarball = `node-${NODE_RUNTIME.version}-${NODE_RUNTIME.arch}`
export const nodeTarballUrl = `https://nodejs.org/dist/${NODE_RUNTIME.version}/${nodeTarball}.tar.gz`

export async function run(command, args, options = {}) {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options })
    const code = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', done) })
    if (code !== 0) throw new Error(`${command} ${args.join(' ')} exited ${code}`)
}

const execFileAsync = promisify(execFile)

export async function output(command, args, options = {}) {
    const { stdout } = await execFileAsync(command, args, options)
    return stdout.trim()
}

export const pnpm = (args, options = {}) => run('npx', ['--yes', 'pnpm@8.15.4', ...args], { cwd: repoRoot, ...options })

export async function sha256File(path) {
    const hash = createHash('sha256')
    hash.update(await readFile(path))
    return hash.digest('hex')
}

export async function cleanDir(path) {
    await rm(path, { recursive: true, force: true })
    await mkdir(path, { recursive: true })
}

export async function buildId() {
    const sha = await output('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })
    const pkg = JSON.parse(await readFile(join(desktopDir, 'package.json'), 'utf8'))
    return `${sha}-desktop-${pkg.version}`
}

export const flag = name => process.argv.includes(name)

export { existsSync, join }
