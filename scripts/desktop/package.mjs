import { join } from 'node:path'
import { flag, repoRoot, run } from './lib.mjs'
import { stageArguments } from './provenance.mjs'

const scripts = file => join(repoRoot, 'scripts', 'desktop', file)
const stage = async file => { console.log(`\n--- ${file}`); await run(process.execPath, [scripts(file), ...stageArguments()]) }

await stage('stage-main.mjs')
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
    await run('npx', ['--yes', 'electron-builder@26.18.1', ...builderArgs, '--config', 'electron-builder.yml'], { cwd: join(repoRoot, 'apps', 'desktop') })
    console.log('\npackage complete: apps/desktop/release')
}
