import { mkdir, writeFile } from 'node:fs/promises'
import { relative, join } from 'node:path'
import { desktopDir, resourcesDir } from './lib.mjs'
import { sourceStamp, requireStamp } from './provenance.mjs'
import { stagedSubscriptionManifest } from './subscription-runners.mjs'
import { macProviderBinaries } from './mac-provider-binaries.mjs'

await mkdir(resourcesDir, { recursive: true })
const stamp = await sourceStamp()
for (const directory of [join(desktopDir, 'dist', 'main'), join(resourcesDir, 'runtime', 'ui'), join(resourcesDir, 'runtime', 'engine'), join(resourcesDir, 'runtime', 'helpers'), join(resourcesDir, 'runtime', 'pdf-helper')]) await requireStamp(directory, stamp)
const engineRoot = join(resourcesDir, 'runtime', 'engine')
const { codexBin, claudeRoot } = macProviderBinaries(engineRoot)
const manifest = {
    protocolVersion: 1,
    buildId: stamp.buildId,
    sourceCommit: stamp.sourceCommit,
    arch: stamp.arch,
    codexPath: relative(resourcesDir, join(codexBin, 'rerun-codex')),
    claudePath: relative(resourcesDir, join(claudeRoot, 'claude')),
    claudeSandboxPath: relative(resourcesDir, join(claudeRoot, 'rerun-claude.sb')),
    nodePath: 'runtime/node/bin/node',
    uiRoot: 'runtime/ui',
    engineEntry: 'runtime/engine/dist/cli/bin.js',
    uiHost: 'main/ui-host.mjs',
    renameHelperPath: 'runtime/helpers/rerun-rename-entry',
    pdfHelperPath: 'runtime/pdf-helper/rerun-render-pdf',
    pdfTextHelperPath: 'runtime/pdf-helper/rerun-pdf-text',
    ...await stagedSubscriptionManifest(engineRoot, resourcesDir),
}
const file = join(resourcesDir, 'runtime-manifest.json')
await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote ${file}`)
console.log(JSON.stringify(manifest))
