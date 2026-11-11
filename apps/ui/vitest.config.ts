import path from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

// Vitest does not read the `@/*` paths from tsconfig, so a unit test importing any module that
// resolves one fails at import time rather than on an assertion.
export default defineConfig({
    resolve: {
        // `server-only` is a Next marker package with no Node entry point, so any module carrying it
        // fails at import time here rather than on an assertion. Stubbed to nothing, which is
        // exactly what it does at runtime once the bundler has checked where it is imported from.
        alias: { '@rerun/contracts': path.resolve(import.meta.dirname, '../../packages/contracts/dist/index.js'), '@': path.resolve(import.meta.dirname, '.'), 'server-only': path.resolve(import.meta.dirname, 'test/server-only-stub.ts') },
    },
    test: {
        // Standalone output can contain traced copies of tests; source is the test input.
        exclude: [...configDefaults.exclude, '**/.next/**'],
        setupFiles: ['test/setup-env.ts'],
        coverage: {
            provider: 'v8',
            // React components are left out: the suite runs in a bare Node environment, so a `.tsx`
            // file only ever shows up here as noise.
            include: ['app/**/*.ts', 'lib/**/*.ts', 'trigger/**/*.ts', 'supabase/**/*.ts', 'stores/**/*.ts', 'hooks/**/*.ts', 'proxy.ts'],
            exclude: ['**/*.test.ts', 'app/api/database.types.ts'],
            reporter: ['text-summary', 'html'],
        },
    },
})
