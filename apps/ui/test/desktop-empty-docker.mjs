import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { LIST_SCREEN_ARGS, VERSION_ARGS, inspectContainerArgs, inspectVolumeArgs } from '../../engine/dist/desktop/isolated-screen/docker-args.js'

const spawn = childProcess.spawn
const docker = new Set(['docker', '/Applications/Docker.app/Contents/Resources/bin/docker'])
const emit = 'const [out, err, code] = process.argv.slice(1); process.stdout.write(out); process.stderr.write(err); process.exitCode = Number(code)'

function matches(args, expected) {
    return args.length === expected.length && expected.every((value, index) => args[index] === value)
}

// The delete fixture has no screen guests. Exercise the engine's disposal checks
// without allowing even a read-only request to the host's Docker daemon.
childProcess.spawn = function (command, args, options) {
    if (!docker.has(command)) return spawn(command, args, options)
    const reply = (out, err, code) => spawn(process.execPath, ['-e', emit, out, err, String(code)], { ...options, shell: false })
    if (!Array.isArray(args)) return reply('', 'Unexpected Docker fixture arguments\n', 125)
    if (matches(args, VERSION_ARGS)) return reply('linux arm64\n', '', 0)
    if (matches(args, LIST_SCREEN_ARGS)) return reply('', '', 0)
    const name = args.at(-1) ?? ''
    if (/^rerun-screen-[a-f0-9]{32}$/.test(name) && matches(args, inspectContainerArgs(name))) return reply('', 'No such container\n', 1)
    if (/^rerun-screen-profile-[a-f0-9]{32}$/.test(name) && matches(args, inspectVolumeArgs(name))) return reply('', 'No such volume\n', 1)
    return reply('', 'Unexpected Docker fixture arguments\n', 125)
}
syncBuiltinESMExports()
