const targets = {
    arm64: {
        clang: 'arm64',
        codexTriple: 'aarch64-apple-darwin',
        appDirectory: 'mac-arm64',
        nodeSha256: 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
    },
    x64: {
        clang: 'x86_64',
        codexTriple: 'x86_64-apple-darwin',
        appDirectory: 'mac',
        nodeSha256: 'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819',
    },
}

export const nodeVersion = 'v22.23.4'

export function macTarget(arch = process.arch) {
    if (!Object.hasOwn(targets, arch)) throw new Error(`Unsupported Mac build architecture: ${arch}`)
    return { arch, platform: `darwin-${arch}`, ...targets[arch] }
}
