import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { desktopDir, output } from './lib.mjs'

const requiredFuses = {
    RunAsNode: false,
    EnableCookieEncryption: true,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    GrantFileProtocolExtraPrivileges: false,
}

function packagerDependency(name) {
    const desktop = createRequire(join(desktopDir, 'package.json'))
    const builder = createRequire(desktop.resolve('electron-builder/package.json'))
    return createRequire(builder.resolve('app-builder-lib/package.json'))(name)
}

export async function verifyPackagedElectron(app) {
    if (!isAbsolute(app ?? '') || !app.endsWith('.app')) throw new Error('Provide an absolute Mac app bundle path.')
    const { getCurrentFuseWire, FuseVersion, FuseV1Options } = packagerDependency('@electron/fuses')
    const wire = await getCurrentFuseWire(app)
    if (wire.version !== FuseVersion.V1) throw new Error('Unexpected Electron fuse wire version.')
    for (const [name, enabled] of Object.entries(requiredFuses)) {
        const expected = (enabled ? '1' : '0').charCodeAt(0)
        if (wire[FuseV1Options[name]] !== expected) throw new Error(`Packaged Electron fuse ${name} must be ${enabled ? 'on' : 'off'}.`)
    }
    const contents = join(app, 'Contents')
    const integrity = JSON.parse(await output('/usr/bin/plutil', ['-extract', 'ElectronAsarIntegrity', 'json', '-o', '-', join(contents, 'Info.plist')]))
    const stamp = integrity['Resources/app.asar']
    const asar = packagerDependency('@electron/asar')
    const { headerString } = asar.getRawHeader(join(contents, 'Resources/app.asar'))
    const hash = createHash('sha256').update(headerString).digest('hex')
    if (stamp?.algorithm !== 'SHA256' || stamp.hash !== hash) throw new Error('The signed Info.plist does not match the Electron archive header.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await verifyPackagedElectron(process.argv[2])
    console.log('Electron fuses and ASAR integrity verified')
}
