import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, join } from 'node:path'
import { desktopDir, resourcesDir } from './lib.mjs'
import { sourceStamp, requireStamp } from './provenance.mjs'

await mkdir(resourcesDir, { recursive: true })
const stamp = await sourceStamp()
for (const directory of [join(desktopDir, 'dist', 'main'), join(resourcesDir, 'runtime', 'ui'), join(resourcesDir, 'runtime', 'engine'), join(resourcesDir, 'runtime', 'helpers'), join(resourcesDir, 'runtime', 'pdf-helper')]) await requireStamp(directory, stamp)
const engineRequire = createRequire(join(resourcesDir, 'runtime/engine/package.json'))
const adapter = createRequire(engineRequire.resolve('ai-sdk-provider-codex-cli'))
const cli = createRequire(adapter.resolve('@openai/codex/package.json'))
const platform = dirname(cli.resolve('@openai/codex-darwin-arm64/package.json'))
const manifest = {
    protocolVersion: 1,
    buildId: stamp.buildId,
    sourceCommit: stamp.sourceCommit,
    codexPath: relative(resourcesDir, join(platform, 'vendor/aarch64-apple-darwin/bin/rerun-codex')),
    nodePath: 'runtime/node/bin/node',
    uiRoot: 'runtime/ui',
    engineEntry: 'runtime/engine/dist/cli/bin.js',
    uiHost: 'main/ui-host.mjs',
    renameHelperPath: 'runtime/helpers/rerun-rename-entry',
    pdfHelperPath: 'runtime/pdf-helper/rerun-render-pdf',
}
const file = join(resourcesDir, 'runtime-manifest.json')
await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote ${file}`)
console.log(JSON.stringify(manifest))
