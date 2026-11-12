import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { electronAsar } from './install.mjs'
import { verifyPackagedElectron } from './verify-electron.mjs'

test('packaged verifier requires the fuse wire and the matching Info.plist ASAR receipt', { skip: process.platform !== 'darwin' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-electron-integrity-'))
    try {
        const app = join(root, 'Integrity Fixture.app')
        const framework = join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework')
        const archive = join(app, 'Contents/Resources/app.asar')
        const source = join(root, 'source')
        await mkdir(dirname(framework), { recursive: true })
        await mkdir(dirname(archive), { recursive: true })
        await mkdir(source)
        await writeFile(join(source, 'index.js'), 'export {}')
        const asar = electronAsar()
        await asar.createPackage(source, archive)
        const hash = createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex')
        const writePlist = value => writeFile(join(app, 'Contents/Info.plist'),
            '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>ElectronAsarIntegrity</key>' +
            '<dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key>' +
            `<string>${value}</string></dict></dict></dict></plist>`)
        // V1 marker, binary version and length, then ASCII option states. This file is never executed.
        const writeWire = states => writeFile(framework, Buffer.concat([
            Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 8]), Buffer.from(states),
        ]))
        await writePlist(hash)
        await writeWire('01001100')
        await verifyPackagedElectron(app)
        await writeWire('11001100')
        await assert.rejects(() => verifyPackagedElectron(app), /RunAsNode must be off/)
        await writeWire('01001100')
        await writePlist('0'.repeat(64))
        await assert.rejects(() => verifyPackagedElectron(app), /does not match the Electron archive header/)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
