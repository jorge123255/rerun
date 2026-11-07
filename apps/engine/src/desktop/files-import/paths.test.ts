// Authored for the integration owner. This lane does not run it.
import { describe, expect, it } from 'vitest'
import { FilesImportError } from './errors.js'
import { FILES_IMPORT_MAX_BYTES, filesImportParts, filesImportTooLarge } from './paths.js'

describe('coworker Files import paths', () => {
    it('accepts ordinary files, source, and hidden names', () => {
        expect(filesImportParts('docs/sub/a.txt')).toEqual(['docs', 'sub', 'a.txt'])
        expect(filesImportParts('.gitignore')).toEqual(['.gitignore'])
        expect(filesImportParts('.cache/notes.txt')).toEqual(['.cache', 'notes.txt'])
        expect(filesImportParts('src/script.js')).toEqual(['src', 'script.js'])
    })

    it('refuses escape, reserved aliases, and launchable names', () => {
        for (const path of ['../escape.bin', '/etc/passwd', 'C:/Windows/a.txt', 'docs/../../x', 'a\\b', 'foo/\u0000']) {
            expect(() => filesImportParts(path)).toThrow(FilesImportError)
            try { filesImportParts(path) } catch (error) {
                expect(error).toMatchObject({ code: 'unsafe_path' })
            }
        }
        for (const path of ['.rerun/pages/a.bin', '.RERUN-skill-alias', 'nested/internal.rerun-lock/a.txt', '.rerun-import-abc']) {
            expect(() => filesImportParts(path)).toThrow(FilesImportError)
            try { filesImportParts(path) } catch (error) {
                expect(error).toMatchObject({ code: 'reserved' })
            }
        }
        for (const path of ['payload.exe', 'Foo.app/MacOS/bin', 'script.sh']) {
            expect(() => filesImportParts(path)).toThrow(FilesImportError)
            try { filesImportParts(path) } catch (error) {
                expect(error).toMatchObject({ code: 'executable' })
            }
        }
    })

    it('caps a file at the original upload limit without allocating it', () => {
        expect(FILES_IMPORT_MAX_BYTES).toBe(100 * 1024 * 1024)
        expect(filesImportTooLarge(FILES_IMPORT_MAX_BYTES)).toBe(false)
        expect(filesImportTooLarge(FILES_IMPORT_MAX_BYTES + 1)).toBe(true)
    })
})
