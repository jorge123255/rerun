import type { DesktopCliTool } from '@rerun/contracts'

/** One published version of a tool, as its vendor describes it. */
export type CliRelease = {
    version: string
    url: string
    /** Hex SHA-256 of the download, when the vendor publishes one. */
    sha256?: string
    /** Base64 SHA-512 of the download (npm's integrity). */
    sha512?: string
    /** For a .tar.gz: archive path → installed path. Absent: the download is the tool itself. */
    members?: Record<string, string>
    /** False when the vendor lists the app integrations it tested and this app's is not among them. */
    tested?: boolean
}
export type CliFetch = (url: string) => Promise<Response>
export type CliSource = {
    /** The engine variable that names the tool a reply starts. */
    variable: string
    /** Apple Developer Team ID of the vendor; every executable must carry its signature. */
    teamId: string
    /** Installed path of the file the engine starts, inside the version's folder. */
    runner: string
    /** Installed executables whose signature is checked. */
    signed: string[]
    /** Files copied from beside the built-in copy: the app's own launcher and sandbox rules. */
    companions?: { directory: string; files: string[] }
    /** How the tool is asked for its version: directly, or through the app's Codex launcher. */
    probe: 'plain' | 'codex-launcher'
    latest(fetch: CliFetch, context: { claudeSdk: string }): Promise<CliRelease>
}

const VERSION = /^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/
const SHA256 = /^[a-f0-9]{64}$/
const unreachable = () => new Error('The vendor did not answer with a version.')

async function body(fetch: CliFetch, url: string, limit: number) {
    const response = await fetch(url)
    if (!response.ok) throw unreachable()
    const text = await response.text()
    if (text.length > limit) throw unreachable()
    return text
}
async function versionAt(fetch: CliFetch, url: string) {
    const version = (await body(fetch, url, 256)).trim()
    if (!VERSION.test(version)) throw unreachable()
    return version
}
async function jsonAt(fetch: CliFetch, url: string): Promise<Record<string, any>> {
    const value: unknown = JSON.parse(await body(fetch, url, 4 * 1024 * 1024))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw unreachable()
    return value as Record<string, any>
}

// Each address below is the one the vendor's own installer reads (claude.ai/install.sh,
// code.kimi.com/kimi-code/install.sh, x.ai/cli/install.sh, cli.devin.ai/install.sh) or, for Codex,
// the npm package the app is built from. Read on November 14, 2026.
export const cliSources: Record<DesktopCliTool, CliSource> = {
    claude: {
        variable: 'RERUN_DESKTOP_CLAUDE_RUNNER', teamId: 'Q6L2SF6YDW', runner: 'claude', signed: ['claude'], probe: 'plain',
        async latest(fetch, { claudeSdk }) {
            const base = 'https://downloads.claude.ai/claude-code-releases'
            const version = await versionAt(fetch, `${base}/latest`)
            const manifest = await jsonAt(fetch, `${base}/${version}/manifest.json`)
            const sha256 = manifest.platforms?.['darwin-arm64']?.checksum
            if (typeof sha256 !== 'string' || !SHA256.test(sha256)) throw unreachable()
            const testedWith: unknown = manifest.sdkCompat?.testedWrapperVersions
            return { version, url: `${base}/${version}/darwin-arm64/claude`, sha256, ...(Array.isArray(testedWith) && { tested: testedWith.includes(claudeSdk) }) }
        },
    },
    codex: {
        variable: 'RERUN_DESKTOP_CODEX_RUNNER', teamId: '2DC432GLL2', runner: 'bin/rerun-codex', signed: ['bin/codex', 'bin/codex-code-mode-host'], probe: 'codex-launcher',
        companions: { directory: 'bin', files: ['rerun-codex', 'rerun-codex.sb', 'rerun-native-worker.sb'] },
        async latest(fetch) {
            const registry = 'https://registry.npmjs.org/@openai/codex'
            const version = (await jsonAt(fetch, `${registry}/latest`)).version
            if (typeof version !== 'string' || !VERSION.test(version)) throw unreachable()
            const dist = (await jsonAt(fetch, `${registry}/${version}-darwin-arm64`)).dist
            const integrity = typeof dist?.integrity === 'string' ? /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(dist.integrity)?.[1] : undefined
            if (!integrity || dist.tarball !== `${registry}/-/codex-${version}-darwin-arm64.tgz`) throw unreachable()
            const bin = 'package/vendor/aarch64-apple-darwin/bin'
            return { version, url: dist.tarball, sha512: integrity, members: { [`${bin}/codex`]: 'bin/codex', [`${bin}/codex-code-mode-host`]: 'bin/codex-code-mode-host' } }
        },
    },
    'kimi-code': {
        variable: 'RERUN_DESKTOP_KIMI_CODE_RUNNER', teamId: '2J9472RW75', runner: 'runner', signed: ['runner'], probe: 'plain',
        async latest(fetch) {
            const base = 'https://code.kimi.com/kimi-code'
            const version = await versionAt(fetch, `${base}/latest`)
            const entry = (await jsonAt(fetch, `${base}/binaries/${version}/manifest.json`)).platforms?.['darwin-arm64']
            if (typeof entry?.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.filename) || typeof entry.checksum !== 'string' || !SHA256.test(entry.checksum)) throw unreachable()
            return { version, url: `${base}/binaries/${version}/${entry.filename}`, sha256: entry.checksum }
        },
    },
    'grok-build': {
        // xAI publishes no checksum; its Developer ID signature is the check.
        variable: 'RERUN_DESKTOP_GROK_BUILD_RUNNER', teamId: '5Y6N3AJ54S', runner: 'runner', signed: ['runner'], probe: 'plain',
        async latest(fetch) {
            const version = await versionAt(fetch, 'https://x.ai/cli/stable')
            return { version, url: `https://x.ai/cli/grok-${version}-macos-aarch64` }
        },
    },
    devin: {
        variable: 'RERUN_DESKTOP_DEVIN_RUNNER', teamId: '83Z2LHX6XW', runner: 'runner', signed: ['runner'], probe: 'plain',
        async latest(fetch) {
            const manifest = await jsonAt(fetch, 'https://static.devin.ai/cli/current/manifest.json')
            const entry = manifest.platforms?.['aarch64-apple-darwin']
            if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version) || typeof entry?.sha256 !== 'string' || !SHA256.test(entry.sha256)) throw unreachable()
            if (entry.url !== `https://static.devin.ai/cli/${manifest.version}/devin-${manifest.version}-aarch64-apple-darwin.tar.gz`) throw unreachable()
            return { version: manifest.version, url: entry.url, sha256: entry.sha256, members: { 'bin/devin': 'runner' } }
        },
    },
}

/** Whether `a` is a later release than `b`, comparing their dotted numbers. */
export function newerCliVersion(a: string, b: string) {
    const parts = (value: string) => value.split(/[.+-]/).map(part => (/^\d+$/.test(part) ? Number(part) : -1))
    const left = parts(a), right = parts(b)
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const l = left[i] ?? 0, r = right[i] ?? 0
        if (l !== r) return l > r
    }
    return false
}
