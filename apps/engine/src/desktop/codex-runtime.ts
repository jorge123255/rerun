import { userInfo } from 'node:os'
import { mkdirSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { dataDir } from '../config/paths.js'

export const DESKTOP_CODEX_ID = 'mac-chatgpt'
export const signedInFlag = 'RERUN_CHATGPT_CONNECTED'
export function desktopCodexAvailable() {
    return process.env.RERUN_DESKTOP_APP === '1' && isAbsolute(process.env.RERUN_DESKTOP_CODEX_RUNNER ?? '')
}

export function desktopCodexRuntime() {
    const codexPath = process.env.RERUN_DESKTOP_CODEX_RUNNER
    if (!codexPath || !desktopCodexAvailable()) throw new Error('The bundled ChatGPT runner is missing.')
    const profile = join(dataDir(), 'chatgpt')
    const cwd = join(profile, 'work')
    for (const dir of [profile, cwd, join(profile, 'state'), join(profile, 'tmp')]) mkdirSync(dir, { recursive: true, mode: 0o700 })
    return { codexPath, cwd, env: { RERUN_CODEX_PROFILE: profile, RERUN_MAC_HOME: userInfo().homedir } }
}
