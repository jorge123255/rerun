// Extracts the bundled Rerun service rows from supabase/seed.sql.
// Drops embeddings. Does not connect, install, or call the network.
// Run from the repo root: node apps/ui/lib/desktop/server/services/catalog/extract-seed.mjs

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const catalogDir = dirname(fileURLToPath(import.meta.url))
const root = join(catalogDir, '..', '..', '..', '..', '..', '..', '..')
const seedPath = join(root, 'supabase', 'seed.sql')
const outPath = join(catalogDir, 'bundled-services.json')

const ORIGINAL_PIN = 'a6d63a4b542674ddd002e51b39ba0df6e0807bcc'
const CATALOG_BASE = '447fb9f03cd1113d50d199a1ec4c433198dc0ef9'
const EXPECTED_BLOB = 'cc7201f8b16994132ee7698eb79c088891ada2b4'
const EXPECTED_SHA256 = 'ebe7357ea24aa2788b93ce31d34f77a5dd067b349f4b9335d147579133257e33'
const EXPECTED_COUNT = 216
const INSERT = 'insert into public.services (slug, name, category, summary, icon, manifest, enabled, verified, embedding) values'

function git(args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function skipWs(sql, index) {
    while (index < sql.length && (sql[index] === ' ' || sql[index] === '\n' || sql[index] === '\r' || sql[index] === '\t')) index += 1
    return index
}

function parseString(sql, index) {
    if (sql[index] !== "'") throw new Error(`expected a SQL string at ${index}`)
    let value = ''
    index += 1
    while (index < sql.length) {
        if (sql[index] === "'") {
            if (sql[index + 1] === "'") {
                value += "'"
                index += 2
                continue
            }
            return { value, index: index + 1 }
        }
        value += sql[index]
        index += 1
    }
    throw new Error('unterminated SQL string')
}

function isIdent(char) {
    return char !== undefined && /[A-Za-z0-9_]/.test(char)
}

function parseField(sql, index) {
    index = skipWs(sql, index)
    if (sql.startsWith('null', index) && !isIdent(sql[index + 4])) return { value: null, index: index + 4 }
    if (sql.startsWith('true', index) && !isIdent(sql[index + 4])) return { value: true, index: index + 4 }
    if (sql.startsWith('false', index) && !isIdent(sql[index + 5])) return { value: false, index: index + 5 }
    if (sql[index] === "'") {
        const parsed = parseString(sql, index)
        let next = parsed.index
        if (sql.startsWith('::', next)) {
            next += 2
            while (isIdent(sql[next])) next += 1
        }
        return { value: parsed.value, index: next }
    }
    throw new Error(`unsupported SQL value at ${index}: ${JSON.stringify(sql.slice(index, index + 48))}`)
}

function parseRows(sql) {
    const start = sql.indexOf(INSERT)
    if (start < 0) throw new Error('services insert not found')
    let index = start + INSERT.length
    const rows = []
    while (index < sql.length) {
        index = skipWs(sql, index)
        if (sql[index] !== '(') break
        index += 1
        const fields = []
        for (let field = 0; field < 9; field += 1) {
            if (field > 0) {
                index = skipWs(sql, index)
                if (sql[index] !== ',') throw new Error(`expected a comma before field ${field} of row ${rows.length}`)
                index += 1
            }
            const parsed = parseField(sql, index)
            fields.push(parsed.value)
            index = parsed.index
        }
        index = skipWs(sql, index)
        if (sql[index] !== ')') throw new Error(`expected end of row ${rows.length}`)
        index += 1
        rows.push(fields)
        index = skipWs(sql, index)
        if (sql[index] === ',') index += 1
    }
    return rows
}

const seedBytes = readFileSync(seedPath)
const seedGitBlob = git(['hash-object', seedPath])
const pinnedBlob = git(['rev-parse', `${ORIGINAL_PIN}:supabase/seed.sql`])
const seedSha256 = createHash('sha256').update(seedBytes).digest('hex')
if (seedGitBlob !== EXPECTED_BLOB || pinnedBlob !== EXPECTED_BLOB) {
    throw new Error(`seed blob ${seedGitBlob} (pin ${pinnedBlob}) is not ${EXPECTED_BLOB}`)
}
if (seedSha256 !== EXPECTED_SHA256) throw new Error(`seed sha256 ${seedSha256} is not ${EXPECTED_SHA256}`)

const services = parseRows(seedBytes.toString('utf8')).map(fields => {
    const [slug, name, category, summary, icon, manifestText, enabled, verified] = fields
    if (typeof slug !== 'string' || typeof name !== 'string' || typeof category !== 'string' || typeof summary !== 'string') {
        throw new Error(`service row ${String(slug)} has a non-text column`)
    }
    if (icon !== null && typeof icon !== 'string') throw new Error(`${slug} icon is not text or null`)
    if (typeof manifestText !== 'string') throw new Error(`${slug} manifest is not JSON text`)
    if (typeof enabled !== 'boolean' || typeof verified !== 'boolean') throw new Error(`${slug} flags are not booleans`)
    return { slug, name, category, summary, icon, manifest: JSON.parse(manifestText), enabled, verified }
})

if (services.length !== EXPECTED_COUNT) throw new Error(`expected ${EXPECTED_COUNT} services, parsed ${services.length}`)
const slugs = new Set(services.map(service => service.slug))
if (slugs.size !== services.length) throw new Error('duplicate service slugs in seed')

const missingIcons = []
for (const service of services) {
    if (!service.icon) {
        missingIcons.push(`${service.slug} (null icon)`)
        continue
    }
    const pathOnly = service.icon.split('?')[0]
    if (!pathOnly.startsWith('/services/') || !existsSync(join(root, 'apps', 'ui', 'public', pathOnly))) {
        missingIcons.push(`${service.slug} ${service.icon}`)
    }
}

const document = {
    provenance: {
        source: 'supabase/seed.sql',
        originalPin: ORIGINAL_PIN,
        seedGitBlob,
        seedSha256: createHash('sha256').update(seedBytes).digest('hex'),
        catalogBase: CATALOG_BASE,
        count: services.length,
        extractor: 'apps/ui/lib/desktop/server/services/catalog/extract-seed.mjs',
    },
    services,
}

writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`)
console.log(`wrote ${services.length} services`)
console.log(`sha256 ${document.provenance.seedSha256}`)
console.log(`disabled ${services.filter(service => !service.enabled).length}`)
console.log(`unverified ${services.filter(service => !service.verified).length}`)
console.log(`null icons ${services.filter(service => service.icon === null).length}`)
console.log(`missing icons ${missingIcons.length}`)
if (missingIcons.length > 0) console.log(missingIcons.join('\n'))
const mismatches = []
for (const service of services) {
    const manifest = service.manifest
    for (const key of ['slug', 'name', 'category', 'summary']) {
        if (manifest[key] !== service[key]) mismatches.push(`${service.slug} ${key}`)
    }
    if ((manifest.icon ?? null) !== service.icon) mismatches.push(`${service.slug} icon`)
}
console.log(`column/manifest mismatches ${mismatches.length}`)
if (mismatches.length > 0) console.log(mismatches.join('\n'))
