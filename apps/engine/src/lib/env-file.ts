import { readFile, writeFile, chmod, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { badRequest } from './errors.js'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { desktopApp } from '../desktop/policy.js'

const ENCRYPTED = 'RERUN-DESKTOP-ENV-1\n'

function desktopKey(): Buffer {
    const key = process.env.RERUN_DESKTOP_SECRET_KEY ?? ''
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Desktop credential storage is unavailable')
    return Buffer.from(key, 'hex')
}

function seal(text: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', desktopKey(), iv)
    const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return ENCRYPTED + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

function unseal(text: string): string {
    if (!text.startsWith(ENCRYPTED)) {
        if (desktopApp() && text.trim()) throw new Error('Unencrypted credentials cannot be opened in the desktop profile')
        return text
    }
    if (!desktopApp()) throw new Error('Encrypted desktop credentials require the desktop app')
    const bytes = Buffer.from(text.slice(ENCRYPTED.length), 'base64')
    if (bytes.length < 28) throw new Error('Invalid encrypted credential file')
    const decipher = createDecipheriv('aes-256-gcm', desktopKey(), bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
}

export function parseEnvFile(text: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
        out[key] = value
    }
    return out
}

// One line per key, so a line break inside a value would write a second key the caller never set.
// Surrounding whitespace is trimmed here because parseEnvFile drops it on the way back anyway.
export function serializeEnv(env: Record<string, string>): string {
    return Object.entries(env)
        .map(([k, v]) => {
            if (!k || /[=\r\n]/.test(k)) throw badRequest(`Invalid environment variable name: ${JSON.stringify(k)}`)
            const value = v.trim()
            if (/[\r\n]/.test(value)) throw badRequest(`The value of ${k} cannot contain a line break.`)
            return `${k}=${value}`
        })
        .join('\n')
}

export async function readEnvFile(path: string): Promise<Record<string, string>> {
    if (!existsSync(path)) return {}
    return parseEnvFile(unseal(await readFile(path, 'utf8')))
}

export async function writeEnvFile(path: string, env: Record<string, string>): Promise<void> {
    const tmp = `${path}.tmp`
    const text = serializeEnv(env)
    await writeFile(tmp, desktopApp() ? seal(text) : text, { encoding: 'utf8', mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
}
