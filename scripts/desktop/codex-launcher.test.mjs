import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const supported = process.platform === 'darwin'
const launcherPath = fileURLToPath(new URL('./codex-launcher.sh', import.meta.url))
const policyPath = fileURLToPath(new URL('./codex-launcher.sb', import.meta.url))
let root, launcher, profile, macHome

// This disposable binary makes actual file syscalls under the packaged Seatbelt
// policy. It never starts Codex, contacts a service, or reads account credentials.
const probeSource = String.raw`
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char *argument(int argc, char **argv, const char *name) {
    for (int i = 1; i + 1 < argc; i++) if (strcmp(argv[i], name) == 0) return argv[i + 1];
    return NULL;
}
static int can_read(const char *path) {
    if (!path) return 0;
    int fd = open(path, O_RDONLY);
    if (fd < 0) return 0;
    char byte;
    int ok = read(fd, &byte, 1) == 1;
    close(fd);
    return ok;
}
static int denied(const char *path, int flags) {
    if (!path) return 0;
    int fd = open(path, flags);
    if (fd >= 0) { close(fd); return 0; }
    return errno == EPERM || errno == EACCES;
}
static int can_write(const char *path) {
    if (!path) return 0;
    int fd = open(path, O_WRONLY | O_CREAT, 0600);
    if (fd < 0) return 0;
    int ok = write(fd, "ok", 2) == 2;
    close(fd);
    return ok;
}
int main(int argc, char **argv) {
    const char *schema = argument(argc, argv, "--output-schema");
    if (!schema) schema = argument(argc, argv, "--probe-file");
    const char *sibling = argument(argc, argv, "--probe-sibling");
    const char *output = argument(argc, argv, "--output-last-message");
    const char *private_file = argument(argc, argv, "--probe-private");
    const char *expected_tmp = argument(argc, argv, "--probe-tmp");
    const char *actual_tmp = getenv("TMPDIR");
    int clean = !getenv("RERUN_TEST_SECRET") && !getenv("OPENAI_API_KEY") && !getenv("RERUN_CODEX_PROFILE");
    printf("{\"schemaRead\":%d,\"schemaWriteDenied\":%d,\"siblingReadDenied\":%d,\"outputWrite\":%d,\"profileWrite\":%d,\"secretsAbsent\":%d,\"privateTmp\":%d}\n",
        can_read(schema), denied(schema, O_WRONLY), denied(sibling, O_RDONLY), can_write(output), can_write(private_file), clean,
        actual_tmp && expected_tmp && strcmp(actual_tmp, expected_tmp) == 0);
    return 0;
}
`

before(async () => {
    if (!supported) return
    root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-codex-schema-')))
    const bin = join(root, 'bin')
    profile = join(root, 'private profile')
    macHome = join(root, 'disposable home')
    for (const directory of [bin, join(profile, 'tmp'), join(profile, 'state'), join(macHome, 'keychain')]) {
        await mkdir(directory, { recursive: true, mode: 0o700 })
    }
    await writeFile(join(macHome, 'keychain', 'login.keychain-db'), 'Disposable metadata fixture')
    const source = join(root, 'probe.c')
    await writeFile(source, probeSource)
    await exec('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', join(bin, 'codex')])
    await copyFile(policyPath, join(bin, 'rerun-codex.sb'))
    const production = await readFile(launcherPath, 'utf8')
    const discovery = production.split('\n').filter(line => line.startsWith('keychain=$('))
    assert.equal(discovery.length, 1)
    // The only substitution is account path discovery. Argument validation, env -i,
    // sandbox invocation and the policy are the actual production sources.
    launcher = join(bin, 'rerun-codex')
    await writeFile(launcher, production.replace(discovery[0], 'keychain="$mac_home/keychain/login.keychain-db"'), { mode: 0o755 })
})
after(async () => { if (root) await rm(root, { recursive: true, force: true }) })

async function fixture() {
    const directory = await mkdtemp(join(root, 'case-'))
    const temp = join(directory, 'caller temp')
    await mkdir(temp, { mode: 0o700 })
    const schemaDir = await mkdtemp(join(temp, 'codex-schema-'))
    const schema = join(schemaDir, 'schema.json')
    const sibling = join(schemaDir, 'unrelated.json')
    await writeFile(schema, '{"type":"object","properties":{}}')
    await writeFile(sibling, 'Unrelated caller file')
    const outputDir = await mkdtemp(join(temp, 'codex-cli-'))
    return { directory, temp, schemaDir, schema, sibling, output: join(outputDir, 'last-message.txt') }
}

function environment(temp) {
    return {
        PATH: '/usr/bin:/bin', RERUN_CODEX_PROFILE: profile, RERUN_MAC_HOME: macHome, TMPDIR: temp,
        OPENAI_API_KEY: 'disposable-must-not-inherit', RERUN_TEST_SECRET: 'disposable-must-not-inherit',
    }
}
async function invoke(f, schemaArgs = ['--output-schema', f.schema], env = environment(f.temp)) {
    const args = [...schemaArgs, '--probe-file', f.schema, '--probe-sibling', f.sibling,
        '--output-last-message', f.output, '--probe-private', join(profile, 'probe.txt'), '--probe-tmp', join(profile, 'tmp')]
    return exec('/bin/sh', [launcher, ...args], { env, cwd: f.directory, timeout: 10000 })
}
async function refused(f, args, env) {
    await assert.rejects(invoke(f, args, env), error => {
        assert.equal(error.code, 2, 'the launcher rejects before the probe runs')
        assert.equal(error.stdout, '')
        return true
    })
}

test('structured output reads only its schema while sibling reads and schema writes remain denied', { skip: !supported }, async () => {
    const f = await fixture()
    assert.deepEqual(JSON.parse((await invoke(f)).stdout), {
        schemaRead: 1, schemaWriteDenied: 1, siblingReadDenied: 1,
        outputWrite: 1, profileWrite: 1, secretsAbsent: 1, privateTmp: 1,
    })
    assert.equal(await readFile(f.schema, 'utf8'), '{"type":"object","properties":{}}')
    assert.equal(await readFile(f.sibling, 'utf8'), 'Unrelated caller file')
    assert.equal(await readFile(f.output, 'utf8'), 'ok')
})

test('without output-schema the same file remains unreadable and existing output behavior is unchanged', { skip: !supported }, async () => {
    const f = await fixture()
    assert.deepEqual(JSON.parse((await invoke(f, [])).stdout), {
        schemaRead: 0, schemaWriteDenied: 1, siblingReadDenied: 1,
        outputWrite: 1, profileWrite: 1, secretsAbsent: 1, privateTmp: 1,
    })
})

test('a canonical alias for the caller temporary root still grants only the exact schema', { skip: !supported }, async () => {
    const f = await fixture()
    const alias = join(f.directory, 'temp-alias')
    await symlink(f.temp, alias)
    const result = JSON.parse((await invoke(f, ['--output-schema', join(alias, relative(f.temp, f.schema))], environment(alias))).stdout)
    assert.equal(result.schemaRead, 1)
    assert.equal(result.schemaWriteDenied, 1)
    assert.equal(result.siblingReadDenied, 1)
})

test('malformed, duplicate, missing and outside-root schema arguments are refused', { skip: !supported }, async t => {
    await t.test('flag at end of arguments', async () => {
        const f = await fixture()
        await assert.rejects(exec('/bin/sh', [launcher, '--output-schema'], { env: environment(f.temp), timeout: 10000 }), error => {
            assert.equal(error.code, 2)
            assert.equal(error.stdout, '')
            return true
        })
    })
    const cases = {
        'missing value': () => ['--output-schema'],
        'empty value': () => ['--output-schema', ''],
        'equals spelling': f => [`--output-schema=${f.schema}`],
        'duplicate flags': f => ['--output-schema', f.schema, '--output-schema', f.schema],
        'relative file': f => ['--output-schema', relative(f.directory, f.schema)],
        'other filename': f => ['--output-schema', f.sibling],
        'outside temporary root': async f => {
            const outside = await mkdtemp(join(f.directory, 'codex-schema-'))
            await writeFile(join(outside, 'schema.json'), '{}')
            return ['--output-schema', join(outside, 'schema.json')]
        },
        'nested directory': async f => {
            const nested = await mkdtemp(join(f.schemaDir, 'codex-schema-'))
            await writeFile(join(nested, 'schema.json'), '{}')
            return ['--output-schema', join(nested, 'schema.json')]
        },
    }
    for (const [name, args] of Object.entries(cases)) await t.test(name, async () => {
        const f = await fixture()
        await refused(f, await args(f))
    })
})

test('linked, nonordinary, empty, oversized and externally writable schema locations are refused', { skip: !supported }, async t => {
    const changes = {
        'schema symlink': async f => { await rm(f.schema); await symlink(f.sibling, f.schema) },
        'schema hardlink': async f => { await rm(f.schema); await link(f.sibling, f.schema) },
        'directory symlink': async f => {
            const target = await mkdtemp(join(f.temp, 'other-'))
            await writeFile(join(target, 'schema.json'), '{}')
            await rm(f.schemaDir, { recursive: true }); await symlink(target, f.schemaDir)
        },
        'directory instead of file': async f => { await rm(f.schema); await mkdir(f.schema) },
        'empty file': f => writeFile(f.schema, ''),
        'oversized file': f => writeFile(f.schema, Buffer.alloc(1048577, 32)),
        'shared parent': f => chmod(f.schemaDir, 0o777),
    }
    for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
        const f = await fixture()
        await change(f)
        await refused(f, ['--output-schema', f.schema])
    })
})

test('schema cannot gain writes through the private-profile permission', { skip: !supported }, async () => {
    const f = await fixture()
    const directory = await mkdtemp(join(profile, 'tmp', 'codex-schema-'))
    const schema = join(directory, 'schema.json')
    await writeFile(schema, '{}')
    await refused(f, ['--output-schema', schema], environment(join(profile, 'tmp')))
})
