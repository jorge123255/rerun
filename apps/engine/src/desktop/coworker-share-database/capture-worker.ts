import { createClient } from '@libsql/client'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { type DataFilePin } from '../data-executor.ts'
import { captureLogicalPrivateDatabase } from './logical-reader.ts'
import { privateDatabaseCaptureIdentity, verifyPrivateCaptureFile } from './scoped.ts'
import { LOGICAL_DATABASE_CAPTURE_LIMITS as BOUNDS } from './verify.ts'

const fileIdentity = z.strictObject({ dev: z.string().regex(/^\d{1,40}$/),ino: z.string().regex(/^\d{1,40}$/) })
const pinSchema = z.strictObject({ file: z.string().min(1).max(4096),parent: fileIdentity,identity: fileIdentity })
let started = false
process.on('disconnect',() => process.exit(1))
process.on('message',(raw: unknown) => {
    if (started) { process.exit(1); return }
    started = true
    void run(raw)
})

async function run(raw: unknown) {
    let client: ReturnType<typeof createClient> | undefined
    try {
        if (Buffer.byteLength(JSON.stringify(raw)) > 8192) throw new Error('Oversized capture request.')
        const message = z.strictObject({ type: z.literal('start'),pin: pinSchema,identity: privateDatabaseCaptureIdentity }).parse(raw)
        const pin = message.pin as DataFilePin
        if (!pin.file.endsWith(`/agents/${message.identity.engineAgentId}/data/agent.db`)) throw new Error('Wrong private database identity.')
        await verifyPrivateCaptureFile(pin)
        const location = pathToFileURL(pin.file)
        location.searchParams.set('mode','ro')
        client = createClient({ url: `file:${encodeURIComponent(location.href)}` })
        await client.execute('PRAGMA busy_timeout = 500')
        const pkg = await captureLogicalPrivateDatabase(client,message.identity)
        client.close(); client = undefined
        await verifyPrivateCaptureFile(pin)
        const reply = { type: 'result',package: pkg }
        if (!process.send || Buffer.byteLength(JSON.stringify(reply)) > BOUNDS.maxEnvelopeBytes + 1024) throw new Error('Oversized capture.')
        await new Promise<void>((resolve,reject) => process.send!(reply,error => error ? reject(error) : resolve()))
        process.exit(0)
    } catch {
        try { client?.close() } catch {}
        process.exit(1)
    }
}
