#!/usr/bin/env node
// Checks `.env` before the first `docker compose up`: fills the secrets left empty, and stops on
// what only you can provide, saying where to find it.
//
//   node scripts/self-host-check.mjs

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const FILE = '.env'
const GENERATED = ['RERUN_ENGINE_API_KEY', 'FOREMAN_HUB_TOKEN_SECRET', 'BOARD_IMAGE_SECRET']
const REQUIRED = {
    NEXT_PUBLIC_APP_URL: 'the address people open, e.g. http://localhost:3000',
    NEXT_PUBLIC_SUPABASE_URL: 'Supabase > Project settings > API > Project URL, or `npx supabase status` (API URL)',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'Supabase > Project settings > API keys > publishable (or anon) key',
    SUPABASE_SECRET_KEY: 'Supabase > Project settings > API keys > secret (or service_role) key',
}

if (!existsSync(FILE)) {
    console.error('No .env here. Run `cp .env.example .env` first, from the root of the repository.')
    process.exit(1)
}

let text = readFileSync(FILE, 'utf8')
const valueOf = (key) => parseEnv(text)[key]?.trim() ?? ''

const generated = []
for (const key of GENERATED) {
    if (valueOf(key)) continue
    const value = randomBytes(32).toString('hex')
    text = new RegExp(`^${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`
    generated.push(key)
}
if (generated.length) writeFileSync(FILE, text, { mode: 0o600 })

const problems = []
for (const [key, where] of Object.entries(REQUIRED)) {
    if (!valueOf(key)) problems.push(`${key} is empty: ${where}`)
}
const appUrl = valueOf('NEXT_PUBLIC_APP_URL')
if (appUrl && (!/^https?:\/\//.test(appUrl) || appUrl.endsWith('/'))) problems.push('NEXT_PUBLIC_APP_URL must start with http:// or https:// and end without a slash')
const supabaseUrl = valueOf('NEXT_PUBLIC_SUPABASE_URL')
let localSupabase = false
try {
    const parsed = new URL(supabaseUrl)
    localSupabase = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    if (localSupabase && parsed.port !== '54421') problems.push('A local Supabase answers on port 54421 here: use http://localhost:54421')
} catch {
    if (supabaseUrl) problems.push('NEXT_PUBLIC_SUPABASE_URL must be a valid URL')
}
if (!valueOf('OPENROUTER_API_KEY')) console.warn('! OPENROUTER_API_KEY is empty: the onboarding guide will not answer. Your coworkers still run on the AI you connect in the app.')

if (generated.length) console.log(`Generated ${generated.join(', ')} in .env`)
if (problems.length) {
    console.error(`\n${problems.map((problem) => `x ${problem}`).join('\n')}\n`)
    process.exit(1)
}

console.log(`
.env is ready. Next:
  docker compose${localSupabase ? ' --profile local-supabase' : ''} up -d --build
  open ${appUrl}`)
