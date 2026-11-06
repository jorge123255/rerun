import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const guestDir = join(dirname(fileURLToPath(import.meta.url)), '../../../desktop-guest')
const read = (name: string) => readFileSync(join(guestDir, name), 'utf8')

describe('guest image source', () => {
    it('is a separate arm64 desktop, not the engine image', () => {
        const dockerfile = read('Dockerfile')
        expect(dockerfile).toContain('FROM debian:bookworm-slim')
        expect(dockerfile).toContain('--uid 10001 rerun')
        expect(dockerfile).toContain('VOLUME /var/lib/rerun/profile')
        for (const pkg of ['ca-certificates', 'chromium', 'fonts-liberation', 'openbox', 'python3', 'util-linux', 'x11vnc', 'xdotool', 'xvfb', 'maim', 'x11-utils', 'thunar', 'xfce4-terminal']) {
            expect(dockerfile).toContain(pkg)
        }
        const copies = dockerfile.split('\n').filter(line => line.startsWith('COPY'))
        expect(copies.join('\n')).not.toContain('Dockerfile')
        for (const banned of ['EXPOSE', 'tint2', 'hsetroot', 'docker.sock', 'FROM node', 'npm install']) {
            expect(dockerfile).not.toContain(banned)
        }
    })

    it('keeps watch on a view-only server and does not publish it', () => {
        const guest = read('guest.py')
        const entry = read('entrypoint.sh')
        expect(guest).toContain('WATCH_PORT = 5901')
        expect(guest).toContain('DRIVE_PORT = 5900')
        expect(guest).toContain("'-viewonly'")
        expect(guest).toContain("'-localhost'")
        expect(guest).not.toContain('shell=True')
        expect(read('rerun-vnc')).toContain('guest.py vnc')
        expect(entry).toContain('check-mounts')
        expect(read('Dockerfile')).toContain('USER 10001:10001')
        expect(entry).not.toContain('chown')
        expect(entry).not.toContain('docker.sock')
        expect(read('openbox.xml')).toContain('<keyboard></keyboard>')
        expect(read('openbox.xml')).not.toContain('keybind')
        const published = `${guest}\n${entry}\n${read('Dockerfile')}`
        expect(published).not.toContain('--network host')
        expect(guest).toContain("BANNED_MOUNT = ('docker.sock', '/Users/'")
        expect(read('Dockerfile')).not.toContain('/Users/')
    })
})
