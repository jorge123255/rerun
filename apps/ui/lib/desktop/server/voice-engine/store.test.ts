import { createClient } from '@libsql/client'
import { describe, expect, it } from 'vitest'
import { desktopVoiceEngineStore } from './store'

const key = () => Buffer.alloc(32, 7)

describe('the voice settings on this Mac', () => {
    it('start empty and off', async () => {
        const store = desktopVoiceEngineStore(createClient({ url: ':memory:' }), key)
        expect(await store.read()).toEqual({ relayOrigin: null, installId: null, hasSecret: false, engineId: null, engineKeyRevision: null, engineRelay: null, enabled: false })
        expect(await store.secret()).toBeNull()
    })

    it('make the relay id and secret once, keep the secret encrypted, and hand it out only when asked', async () => {
        const db = createClient({ url: ':memory:' })
        const store = desktopVoiceEngineStore(db, key)
        const deploy = (await store.saveRelay('https://voice.example.com'))!
        expect(deploy.installId).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(deploy.relaySecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(JSON.parse(deploy.workerSecret)).toEqual({ [deploy.installId]: deploy.relaySecret })
        expect(await store.saveRelay('https://voice.example.com')).toBeNull()
        const row = (await db.execute('SELECT * FROM desktop_voice_engine')).rows[0]
        expect(JSON.stringify(row)).not.toContain(deploy.relaySecret)
        expect(await store.secret()).toBe(deploy.relaySecret)
        expect(await desktopVoiceEngineStore(db, () => Buffer.alloc(32, 8)).secret().catch(() => 'refused')).toBe('refused')
        expect(JSON.stringify(await store.read())).not.toContain(deploy.relaySecret)
    })

    it('a new relay address turns the feature off; new values make the engine and the switch start over', async () => {
        const store = desktopVoiceEngineStore(createClient({ url: ':memory:' }), key)
        const first = (await store.saveRelay('https://voice.example.com'))!
        await store.setEngine('seng_1', 'rev', 'https://voice.example.com')
        await store.setEnabled(true)
        await store.saveRelay('https://other.example.com')
        expect(await store.read()).toMatchObject({ relayOrigin: 'https://other.example.com', enabled: false, engineId: 'seng_1', engineRelay: 'https://voice.example.com' })
        await store.setEnabled(true)
        const second = await store.rotate()
        expect(second.installId).not.toBe(first.installId)
        expect(await store.read()).toMatchObject({ installId: second.installId, engineId: null, enabled: false })
        expect(await store.secret()).toBe(second.relaySecret)
        await store.forget()
        expect(await store.read()).toEqual({ relayOrigin: null, installId: null, hasSecret: false, engineId: null, engineKeyRevision: null, engineRelay: null, enabled: false })
    })
})
