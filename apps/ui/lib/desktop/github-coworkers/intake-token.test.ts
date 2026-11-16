import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

// The owner's read-only GitHub token belongs to the intake reader alone. A coworker gets GitHub
// only through an account the owner attaches from the Vault. These checks read the source: a
// change that hands the token to anything a coworker can use fails here.
const app = join(import.meta.dirname, '..', '..', '..')
const engine = join(app, '..', 'engine', 'src')
function sources(root: string, found: string[] = []): string[] {
    for (const name of readdirSync(root)) {
        if (name === 'node_modules' || name.startsWith('.')) continue
        const path = join(root, name)
        if (statSync(path).isDirectory()) sources(path, found)
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.includes('test-support')) found.push(path)
    }
    return found
}
const server = join(app, 'lib', 'desktop', 'server')

it('only the intake reader reads the read-only GitHub token', () => {
    const readers = [...sources(join(app, 'lib')), ...sources(join(app, 'app')), ...sources(engine)]
        .filter(path => /\.read\(\s*['"`]github-read['"`]/.test(readFileSync(path, 'utf8')))
        .map(path => relative(app, path))
    expect(readers).toEqual(['lib/desktop/server/github-projects/binding.ts'])
})

it('nothing a coworker runs through can reach the tool-service keys', () => {
    // The Vault, connectors, coworker calls, the Chief of Staff's build and the app-suggestion card.
    const coworkerSide = ['vault', 'services', 'mcp', 'mcp-stdio', 'managed-apps', 'connector-approvals', 'coworker-calls', 'foreman', 'service-requests']
        .flatMap(folder => sources(join(server, folder)))
    expect(coworkerSide.length).toBeGreaterThan(40)
    const offenders = coworkerSide.filter(path => /auxiliary\/store|desktopAuxiliaryStore|github-read/.test(readFileSync(path, 'utf8'))).map(path => relative(app, path))
    expect(offenders).toEqual([])
})

it('the engine never sees the token: the reader runs in the app', () => {
    expect(sources(engine).filter(path => /github-read/.test(readFileSync(path, 'utf8'))).map(path => relative(engine, path))).toEqual([])
})
