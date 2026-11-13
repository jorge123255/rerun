import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { PUT } from './route'
import { POST as readEngineLanguage } from '../internal/language/route'
import { closeDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopLanguage } from '@/lib/desktop/server/language'
import { desktopTranslator } from '@/lib/desktop/locale'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'

test('language changes require desktop authentication and persist on the installation after reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-language-'))
    const runtimeFile = join(root, 'runtime.json')
    const runtime: DesktopRuntime = { protocolVersion: 1, workspaceId: 1, launchNonce: 'language-test', buildId: 'language-test',
        dataRoot: root, installRoot: root, app: { origin: 'http://127.0.0.1:3100', sessionToken: 'a'.repeat(40) },
        engine: { origin: 'http://127.0.0.1:1', apiKey: 'local-fixture' } }
    const env = { ...process.env }
    function request(preference: unknown, token = runtime.app.sessionToken, language = 'es-MX') {
        return new Request(runtime.app.origin + '/api/desktop/language', { method: 'PUT', headers: {
            origin: runtime.app.origin, host: '127.0.0.1:3100', cookie: 'rerun-desktop-session=' + token,
            'accept-language': language, 'content-type': 'application/json',
        }, body: JSON.stringify({ preference }) })
    }
    try {
        await writeFile(runtimeFile, JSON.stringify(runtime), { mode: 0o600 })
        process.env.RERUN_DESKTOP_APP = '1'
        process.env.RERUN_DESKTOP_DATA_DIR = root
        process.env.RERUN_DESKTOP_INSTALL_DIR = root
        process.env.RERUN_DESKTOP_WORKSPACE_ID = '1'
        process.env.RERUN_DESKTOP_RUNTIME_FILE = runtimeFile
        process.env.RERUN_DESKTOP_SYSTEM_LANGUAGES = 'de-DE,en'
        const engineRequest = (token: string) => new Request(runtime.app.origin + '/api/desktop/internal/language', {
            method: 'POST', headers: { host: '127.0.0.1:3100', authorization: 'Bearer ' + token },
        })
        expect((await readEngineLanguage(engineRequest('wrong'))).status).toBe(401)
        expect(await (await readEngineLanguage(engineRequest(runtime.engine.apiKey))).json()).toEqual({ locale: 'de' })
        expect((await readDesktopLanguage(runtime, 'unsupported,es-MX;q=0.8')).locale).toBe('es')
        expect((await readDesktopLanguage(runtime, 'ja-JP')).locale).toBe('en')
        expect((await PUT(request('de', 'wrong'))).status).toBe(401)
        expect((await PUT(request('xx'))).status).toBe(400)
        const response = await PUT(request('fr'))
        expect(response.status).toBe(200)
        const pack = await response.json()
        expect(pack).toMatchObject({ locale: 'fr', preference: 'fr' })
        expect(desktopTranslator(pack)('schedule', { name: 'Ada' })).toContain('Ada')
        expect(desktopTranslator(pack)('schedule', { name: 'Ada' })).not.toContain('Scheduled run')
        await closeDesktopDatabase(root)
        const secondWorkspace = { ...runtime, dataRoot: join(root, 'workspaces', '2'), workspaceId: 2 }
        expect(await readDesktopLanguage(secondWorkspace, 'de')).toEqual(pack)
        expect(await (await readEngineLanguage(engineRequest(runtime.engine.apiKey))).json()).toEqual({ locale: 'fr' })
        const automatic = await PUT(request(null, runtime.app.sessionToken, 'pt-BR'))
        expect(await automatic.json()).toMatchObject({ preference: null, locale: 'pt' })
        expect(await (await readEngineLanguage(engineRequest(runtime.engine.apiKey))).json()).toEqual({ locale: 'de' })
        await closeDesktopDatabase(root)
        expect((await readDesktopLanguage(runtime, 'de-DE')).locale).toBe('de')
    } finally {
        await closeDesktopDatabase(root)
        process.env = env
        await rm(root, { recursive: true, force: true })
    }
})
