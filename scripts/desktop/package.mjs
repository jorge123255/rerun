import { isAbsolute, join } from 'node:path'
import { flag, repoRoot, run } from './lib.mjs'
import { stageArguments } from './provenance.mjs'

const outputFlag = process.argv.indexOf('--output-dir')
const outputDir = outputFlag === -1 ? undefined : process.argv[outputFlag + 1]
if (outputFlag !== -1 && !isAbsolute(outputDir ?? '')) throw new Error('--output-dir requires an absolute build directory.')

const scripts = file => join(repoRoot, 'scripts', 'desktop', file)
const stage = async file => { console.log(`\n--- ${file}`); await run(process.execPath, [scripts(file), ...stageArguments()]) }

await stage('stage-main.mjs')
await stage('stage-file-helper.mjs')
await stage('stage-pdf-helper.mjs')
await stage('stage-node.mjs')
await stage('stage-ui.mjs')
await stage('stage-engine.mjs')
await stage('stage-licenses.mjs')
await stage('write-manifest.mjs')
await stage('verify-runtime.mjs')

if (flag('--stage-only')) {
    console.log('\nstaging complete (--stage-only)')
} else {
    const builderArgs = flag('--dmg') ? ['--mac', 'dmg'] : ['--mac', '--arm64']
    console.log(`\n--- electron-builder ${builderArgs.join(' ')}`)
    await run('npx', ['--yes', 'electron-builder@26.18.1', ...builderArgs, '--config', 'electron-builder.yml', ...(outputDir ? [`-c.directories.output=${outputDir}`] : [])], { cwd: join(repoRoot, 'apps', 'desktop') })
    const packagedApp = join(outputDir ?? join(repoRoot, 'apps', 'desktop', 'release'), 'mac-arm64', 'Rerun Desktop Preview.app')
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', packagedApp])
    console.log(`\npackage complete: ${outputDir ?? 'apps/desktop/release'}`)
}
