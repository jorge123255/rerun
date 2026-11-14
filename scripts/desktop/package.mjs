import { isAbsolute, join } from 'node:path'
import { flag, repoRoot, run } from './lib.mjs'
import { matchesSourceStamp, sourceStamp, stageArguments } from './provenance.mjs'
import { previewSigningArguments } from './signing.mjs'
import { requestedSubscriptionRunners } from './subscription-runners.mjs'
import { macTarget } from './mac-target.mjs'
import { prepareMasDevelopment, verifyMasDevelopment } from './mas-development.mjs'
import { bundleName, verifyBundle } from './install.mjs'
import { verifyPreviewDiskImage } from './preview-disk-image.mjs'

const { arch, appDirectory } = macTarget()
const masDevelopment = flag('--mas-dev')
const stageOnly = flag('--stage-only')
const diskImage = flag('--dmg')

if (requestedSubscriptionRunners() && !stageOnly) {
    throw new Error('The optional subscription runner assets are available only for local staging.')
}

const outputFlag = process.argv.indexOf('--output-dir')
const outputDir = outputFlag === -1 ? undefined : process.argv[outputFlag + 1]
if (outputFlag !== -1 && !isAbsolute(outputDir ?? '')) throw new Error('--output-dir requires an absolute build directory.')
if (masDevelopment && (stageOnly || diskImage || !outputDir)) {
    throw new Error('--mas-dev needs an absolute --output-dir and cannot be combined with --stage-only or --dmg.')
}
const initial = stageOnly ? null : await sourceStamp()
const masSigning = masDevelopment ? await prepareMasDevelopment() : null

const scripts = file => join(repoRoot, 'scripts', 'desktop', file)
const stage = async file => { console.log(`\n--- ${file}`); await run(process.execPath, [scripts(file), ...stageArguments()]) }

await stage('stage-main.mjs')
await stage('stage-file-helper.mjs')
await stage('stage-pdf-helper.mjs')
await stage('stage-pdf-text.mjs')
await stage('stage-node.mjs')
await stage('stage-ui.mjs')
await stage('stage-engine.mjs')
await stage('stage-licenses.mjs')
await stage('write-manifest.mjs')
await stage('verify-runtime.mjs')

if (stageOnly) {
    console.log('\nstaging complete (--stage-only)')
} else {
    if (!matchesSourceStamp(await sourceStamp(), initial)) throw new Error('The source changed during staging.')
    const target = masDevelopment ? ['mas-dev'] : diskImage ? ['dmg'] : []
    const builderArgs = ['--mac', ...target, `--${arch}`]
    console.log(`\n--- electron-builder ${builderArgs.join(' ')}`)
    const signingArgs = masSigning?.signingArgs ?? await previewSigningArguments()
    const dmgName = `Rerun Desktop Preview-${initial.buildId}-mac-${arch}.dmg`
    await run('npx', ['--yes', 'electron-builder@26.18.1', ...builderArgs, '--publish', 'never', '--config', 'electron-builder.yml', ...signingArgs,
        ...(outputDir ? [`-c.directories.output=${outputDir}`] : []), ...(diskImage ? [`-c.dmg.artifactName=${dmgName}`, '-c.dmg.writeUpdateInfo=false'] : [])], { cwd: join(repoRoot, 'apps', 'desktop') })
    const destination = outputDir ?? join(repoRoot, 'apps', 'desktop', 'release')
    const directory = masDevelopment ? (arch === 'x64' ? 'mas-dev' : `mas-dev-${arch}`) : appDirectory
    const verifyApp = async app => {
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
        await run(process.execPath, [scripts('verify-electron.mjs'), app])
        if (masSigning) await verifyMasDevelopment(app, masSigning)
        await verifyBundle(app, initial)
    }
    await verifyApp(join(destination, directory, bundleName))
    if (diskImage) await verifyPreviewDiskImage(join(destination, dmgName), verifyApp)
    if (!matchesSourceStamp(await sourceStamp(), initial)) throw new Error('The source changed during packaging.')
    console.log(`Packaged source receipts verified for ${initial.sourceCommit}.`)
    console.log(`\npackage complete: ${outputDir ?? 'apps/desktop/release'}`)
}
