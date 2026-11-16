import {
    DESKTOP_GITHUB_PROJECT_LIMITS,
    type DesktopGithubLinkKind,
    type DesktopGithubProjectKind,
    type DesktopGithubProjectLink,
    type DesktopGithubProjectRole,
    type DesktopGithubRepositoryData,
} from '@rerun/contracts'

// What the files themselves say, before any model is asked. Pure: text in, facts out.
// Nothing here executes, parses code or trusts a claim made in prose.

const manifest = (data: DesktopGithubRepositoryData, path: string): string | null => data.manifests.find(item => item.path === path)?.text ?? null
const has = (data: DesktopGithubRepositoryData, name: string): boolean => data.files.includes(name)
const hasMatch = (data: DesktopGithubRepositoryData, pattern: RegExp): boolean => data.files.some(name => pattern.test(name))

function packageJson(data: DesktopGithubRepositoryData): { name: string | null; dependencies: string[]; scripts: string[]; bin: boolean; entry: boolean; private: boolean } | null {
    const text = manifest(data, 'package.json')
    if (text === null) return null
    try {
        const value = JSON.parse(text) as Record<string, unknown>
        const keys = (field: unknown) => field && typeof field === 'object' && !Array.isArray(field) ? Object.keys(field) : []
        return {
            name: typeof value.name === 'string' ? value.name : null,
            dependencies: [...keys(value.dependencies), ...keys(value.devDependencies), ...keys(value.peerDependencies)],
            scripts: keys(value.scripts),
            bin: !!value.bin,
            entry: !!(value.main || value.module || value.exports),
            private: value.private === true,
        }
    } catch {
        // A file cut at the size limit no longer parses: read the dependency names that are still there.
        const names = [...text.matchAll(/"((?:@[\w.-]+\/)?[\w.-]+)"\s*:\s*"[~^<>=*\d]/g)].map(match => match[1]!)
        return { name: /"name"\s*:\s*"([^"]{1,214})"/.exec(text)?.[1] ?? null, dependencies: names, scripts: [], bin: /"bin"\s*:/.test(text), entry: /"(?:main|module|exports)"\s*:/.test(text), private: /"private"\s*:\s*true/.test(text) }
    }
}

const WEB = ['next', 'react', 'react-dom', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', '@angular/core', 'vite', 'astro', '@remix-run/react', 'solid-js', 'gatsby']
const NODE_SERVER = ['express', 'fastify', 'koa', 'hono', '@nestjs/core', '@hapi/hapi', 'restify']
const gradleText = (data: DesktopGithubRepositoryData) => ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].map(path => manifest(data, path) ?? '').join('\n')
const hasGradle = (data: DesktopGithubRepositoryData) => hasMatch(data, /^(?:build|settings)\.gradle(?:\.kts)?$/)

/** The kind the files decide. `null` when they do not decide it: the model, then the owner, may. */
export function detectProjectKind(data: DesktopGithubRepositoryData): DesktopGithubProjectKind | null {
    const swift = manifest(data, 'Package.swift')
    if (hasMatch(data, /\.(?:xcodeproj|xcworkspace)\/?$/) || has(data, 'Podfile') || (swift && /\.iOSApplication\b/.test(swift))) return 'ios-app'
    if (hasGradle(data)) {
        const gradle = gradleText(data)
        if (/com\.android\.library/.test(gradle) && !/com\.android\.application/.test(gradle)) return 'library'
        if (/com\.android\.(?:application|tools\.build)|\bandroid\s*\{|androidx?\./.test(gradle) || has(data, 'AndroidManifest.xml')) return 'android-app'
    }
    if (hasMatch(data, /\.tf$/) || ['Chart.yaml', 'helmfile.yaml', 'ansible.cfg', 'terraform/', 'helm/', 'k8s/', 'kubernetes/', 'ansible/'].some(name => has(data, name))) return 'infrastructure'
    const pkg = packageJson(data)
    if (pkg) {
        if (pkg.dependencies.some(name => WEB.includes(name))) return 'web-app'
        if (pkg.dependencies.some(name => NODE_SERVER.includes(name))) return 'backend-service'
        if (pkg.bin) return 'cli'
        if (pkg.entry && !pkg.private) return 'library'
    }
    if (swift) return /\.executableTarget\b/.test(swift) ? 'cli' : 'library'
    const cargo = manifest(data, 'Cargo.toml')
    if (cargo) {
        if (/^\s*(?:axum|actix-web|rocket|warp|tonic|poem)\s*=/m.test(cargo)) return 'backend-service'
        if (/^\s*\[\[bin\]\]/m.test(cargo) || /^\s*clap\s*=/m.test(cargo)) return 'cli'
        if (/^\s*\[lib\]/m.test(cargo)) return 'library'
    }
    const go = manifest(data, 'go.mod')
    if (go) {
        if (/github\.com\/(?:gin-gonic\/gin|labstack\/echo|go-chi\/chi|gofiber\/fiber|gorilla\/mux)|google\.golang\.org\/grpc/.test(go)) return 'backend-service'
        return has(data, 'main.go') || has(data, 'cmd/') ? 'cli' : 'library'
    }
    const python = `${manifest(data, 'pyproject.toml') ?? ''}\n${manifest(data, 'requirements.txt') ?? ''}`
    if (python.trim()) {
        if (/\b(?:django|flask|fastapi|starlette|aiohttp|tornado)\b/i.test(python)) return 'backend-service'
        if (/^\s*\[(?:project\.scripts|tool\.poetry\.scripts)\]/m.test(python)) return 'cli'
    }
    if (has(data, 'docker-compose.yml') && !data.manifests.some(item => !['docker-compose.yml', 'Dockerfile', '.gitmodules'].includes(item.path))) return 'infrastructure'
    return null
}

/** Named parts of the stack that the files show, most telling first. */
export function detectProjectStack(data: DesktopGithubRepositoryData): string[] {
    const found: string[] = []
    const add = (name: string, when: unknown) => { if (when && !found.includes(name)) found.push(name) }
    const pkg = packageJson(data)
    const gradle = gradleText(data)
    add('Swift', manifest(data, 'Package.swift') !== null || hasMatch(data, /\.(?:xcodeproj|xcworkspace)\/?$/) || data.language === 'Swift')
    add('Xcode', hasMatch(data, /\.(?:xcodeproj|xcworkspace)\/?$/))
    add('CocoaPods', has(data, 'Podfile'))
    add('Swift Package Manager', manifest(data, 'Package.swift') !== null)
    add('Kotlin', data.language === 'Kotlin' || /kotlin/i.test(gradle))
    add('Android', /com\.android\./.test(gradle))
    add('Gradle', hasGradle(data))
    add('Flutter', /^\s*flutter\s*:/m.test(manifest(data, 'pubspec.yaml') ?? ''))
    add('Dart', has(data, 'pubspec.yaml'))
    add('Next.js', pkg?.dependencies.includes('next'))
    add('React', pkg?.dependencies.includes('react'))
    add('Vue', pkg?.dependencies.includes('vue'))
    add('Svelte', pkg?.dependencies.includes('svelte'))
    add('TypeScript', has(data, 'tsconfig.json') || pkg?.dependencies.includes('typescript') || data.language === 'TypeScript')
    add('Node.js', pkg)
    add('Rust', manifest(data, 'Cargo.toml') !== null || has(data, 'Cargo.toml'))
    add('Go', has(data, 'go.mod'))
    add('Python', has(data, 'pyproject.toml') || has(data, 'requirements.txt') || data.language === 'Python')
    add('Docker', has(data, 'Dockerfile') || has(data, 'docker-compose.yml'))
    add('Terraform', hasMatch(data, /\.tf$/) || has(data, 'terraform/'))
    // The language GitHub reports is one of its own fixed names, kept only when nothing else was found.
    if (!found.length && data.language && /^[A-Za-z0-9+#. -]{1,30}$/.test(data.language)) found.push(data.language)
    return found.slice(0, DESKTOP_GITHUB_PROJECT_LIMITS.stackItems)
}

/** How it is built and tested, when the files make that plain. Commands are named, never run. */
export function detectProjectBuild(data: DesktopGithubRepositoryData): string | null {
    const parts: string[] = []
    const pkg = packageJson(data)
    const project = data.files.find(name => /\.xcodeproj\/?$/.test(name))?.replace(/\/$/, '')
    if (project && /^[\w .-]{1,80}$/.test(project)) parts.push(`Xcode project ${project}`)
    else if (manifest(data, 'Package.swift') !== null || has(data, 'Package.swift')) parts.push('swift build', 'swift test')
    if (hasGradle(data)) parts.push(has(data, 'gradlew') ? './gradlew build' : 'gradle build', has(data, 'gradlew') ? './gradlew test' : 'gradle test')
    if (pkg) {
        const runner = has(data, 'pnpm-lock.yaml') ? 'pnpm' : has(data, 'yarn.lock') ? 'yarn' : has(data, 'bun.lockb') ? 'bun' : 'npm'
        if (pkg.scripts.includes('build')) parts.push(`${runner} run build`)
        if (pkg.scripts.includes('test')) parts.push(`${runner} test`)
    }
    if (has(data, 'Cargo.toml')) parts.push('cargo build', 'cargo test')
    if (has(data, 'go.mod')) parts.push('go build ./...', 'go test ./...')
    if (has(data, 'pubspec.yaml')) parts.push('flutter build', 'flutter test')
    if (!parts.length && has(data, 'Makefile')) parts.push('make')
    if (!parts.length && has(data, 'docker-compose.yml')) parts.push('docker compose up')
    if (!parts.length) return null
    return parts.slice(0, 4).join('; ').slice(0, DESKTOP_GITHUB_PROJECT_LIMITS.build)
}

const DEFAULT_ROLES: Record<DesktopGithubProjectKind, DesktopGithubProjectRole[]> = {
    'ios-app': ['developer', 'qa-tester', 'release-manager'],
    'android-app': ['developer', 'qa-tester', 'release-manager'],
    'web-app': ['developer', 'qa-tester', 'code-reviewer'],
    'backend-service': ['developer', 'code-reviewer', 'qa-tester'],
    library: ['developer', 'code-reviewer', 'docs-writer'],
    cli: ['developer', 'code-reviewer', 'docs-writer'],
    infrastructure: ['developer', 'code-reviewer'],
    other: ['developer', 'code-reviewer'],
}
export function defaultProjectRoles(kind: DesktopGithubProjectKind): DesktopGithubProjectRole[] {
    return [...DEFAULT_ROLES[kind]]
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Names too ordinary to count as a mention of another project. */
const COMMON_NAMES = new Set(['app', 'apps', 'api', 'web', 'docs', 'server', 'client', 'core', 'backend', 'frontend', 'android', 'ios', 'mobile', 'website', 'tools', 'common', 'shared', 'utils', 'test', 'tests', 'demo', 'example', 'examples', 'main', 'service', 'services', 'desktop', 'config', 'infra'])
const DEPENDS = /\b(?:depends? on|dependen(?:t|cy)|requires?|needs?|uses?|using|powered by|built on|backed by|backend|server|streams? from|talks? to|connects? to|client for|front[- ]?end for)\b/i

function oneLine(text: string): string {
    return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, DESKTOP_GITHUB_PROJECT_LIMITS.quote)
}

/** The line of `text` around `index`, as a short quotation. */
function lineAround(text: string, index: number): string {
    const start = text.lastIndexOf('\n', index) + 1
    const end = text.indexOf('\n', index)
    const line = text.slice(start, end === -1 ? text.length : end)
    if (line.length <= DESKTOP_GITHUB_PROJECT_LIMITS.quote) return oneLine(line)
    const offset = Math.max(0, index - start - 60)
    return oneLine(line.slice(offset))
}

function refPattern(id: string): RegExp {
    // `owner/name` as GitHub writes it, in a URL or a short reference, not inside a longer name.
    return new RegExp(`(?<![\\w.-])${escape(id)}(?![\\w-]|\\.(?!git\\b)\\w)`, 'i')
}

function namePattern(name: string): RegExp | null {
    const words = name.split(/[-_. ]+/).filter(Boolean)
    const bare = words.join('')
    if (bare.length < 4 || COMMON_NAMES.has(bare.toLowerCase())) return null
    return new RegExp(`(?<![\\w-])${words.map(escape).join('[-_. ]?')}(?![\\w-])`, 'i')
}

/**
 * Links the repositories state themselves: a submodule pointing at another listed repository, a
 * package file naming it, or its name or address in the README. One link per pair and direction,
 * the strongest evidence first, each with the line it was found on.
 */
export function detectExplicitProjectLinks(repositories: readonly DesktopGithubRepositoryData[]): DesktopGithubProjectLink[] {
    const links: DesktopGithubProjectLink[] = []
    const linked = (from: string, to: string) => links.some(link => link.from === from && link.to === to)
    const paired = (a: string, b: string) => links.some(link => (link.from === a && link.to === b) || (link.from === b && link.to === a))
    const add = (from: string, to: string, kind: DesktopGithubLinkKind, source: DesktopGithubProjectLink['source'], quote: string) => {
        if (links.length >= DESKTOP_GITHUB_PROJECT_LIMITS.maxLinks || linked(from, to)) return
        links.push({ from, to, kind, source, quote: quote || null })
    }
    const names = new Map(repositories.map(data => [data.id, packageJson(data)?.name ?? null]))

    for (const from of repositories) for (const to of repositories) {
        if (from.id === to.id) continue
        const submodules = manifest(from, '.gitmodules')
        const hit = submodules ? refPattern(to.id).exec(submodules) : null
        if (submodules && hit) add(from.id, to.id, 'depends-on', 'submodule', lineAround(submodules, hit.index))
    }
    for (const from of repositories) for (const to of repositories) {
        if (from.id === to.id || linked(from.id, to.id)) continue
        const packageName = names.get(to.id)
        for (const file of from.manifests) {
            if (file.path === '.gitmodules') continue
            const byRef = refPattern(to.id).exec(file.text)
            const byName = !byRef && packageName && file.path === 'package.json' && packageJson(from)?.dependencies.includes(packageName)
                ? new RegExp(`"${escape(packageName)}"\\s*:`).exec(file.text) : null
            const found = byRef ?? byName
            if (found) { add(from.id, to.id, 'depends-on', 'manifest', lineAround(file.text, found.index)); break }
        }
    }
    for (const from of repositories) for (const to of repositories) {
        if (from.id === to.id || !from.readme || linked(from.id, to.id)) continue
        const name = to.id.slice(to.id.indexOf('/') + 1)
        const found = refPattern(to.id).exec(from.readme) ?? namePattern(name)?.exec(from.readme) ?? null
        if (!found) continue
        const quote = lineAround(from.readme, found.index)
        const kind: DesktopGithubLinkKind = DEPENDS.test(quote) ? 'depends-on' : 'companion'
        // Two projects that merely name each other are one pairing, not two.
        if (kind === 'companion' && paired(from.id, to.id)) continue
        add(from.id, to.id, kind, 'readme', quote)
    }
    return links
}
