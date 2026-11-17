import { expect, test } from 'vitest'
import { DESKTOP_REPOSITORY_TOOL_NAMES, desktopRepositoryBranch, desktopRepositoryBranchSchema, desktopRepositoryPath, desktopRepositoryToolInputs } from '@rerun/contracts'
import { hasDesktopToolGrant } from './tool-grants.js'

const config = (patch: Record<string, unknown> = {}) => ({ tools: { desktopToolGrants: { repositoryWorkspace: true } }, desktopRepository: { owner: 'acme', name: 'tuner' }, ephemeral: false, kind: 'agent', selfImprovement: {}, ...patch }) as never

test('the working copy is only for a coworker with the permission and a repository of its own', () => {
    expect(hasDesktopToolGrant(config(), 'repositoryWorkspace')).toBe(true)
    expect(hasDesktopToolGrant(config({ desktopRepository: null }), 'repositoryWorkspace')).toBe(false)
    expect(hasDesktopToolGrant(config({ ephemeral: true }), 'repositoryWorkspace')).toBe(false)
    expect(hasDesktopToolGrant(config({ kind: 'foreman' }), 'repositoryWorkspace')).toBe(false)
    expect(hasDesktopToolGrant(config({ tools: { desktopToolGrants: {} } }), 'repositoryWorkspace')).toBe(false)
})

test('a branch name is always the app\'s own, and a path never leaves the copy', () => {
    expect(desktopRepositoryBranch('Tuner Developer', 'Fix the Port!')).toBe('rerun/tuner-developer/fix-the-port')
    expect(desktopRepositoryBranch('../../main', '  ')).toBe('rerun/main/work')
    for (const made of [desktopRepositoryBranch('A B', 'x'), desktopRepositoryBranch('é', '--'), desktopRepositoryBranch('x'.repeat(200), 'y'.repeat(200))]) expect(desktopRepositoryBranchSchema.safeParse(made).success).toBe(true)
    for (const bad of ['main', 'rerun/main', 'rerun/a/b/c', 'rerun/A/b', 'refs/heads/rerun/a/b', 'rerun/a/b;rm']) expect(desktopRepositoryBranchSchema.safeParse(bad).success).toBe(false)
    expect(desktopRepositoryPath('./src/main.go/')).toBe('src/main.go')
    expect(desktopRepositoryPath('')).toBe('')
    for (const bad of ['../x', 'a/../b', '/etc/passwd', '.git/config', 'src/.GIT/hooks', 'a\\b', 'a//b', 'a\u0000b']) expect(desktopRepositoryPath(bad)).toBeNull()
})

test('GitHub pages can only be named under the repository: no other host, no braces, no traversal', () => {
    const page = desktopRepositoryToolInputs.repo_github
    for (const good of ['', '/issues?state=open&per_page=5', '/pulls/12/files', '/actions/runs?per_page=5', '/commits?sha=main']) expect(page.safeParse({ path: good }).success).toBe(true)
    for (const bad of ['https://evil.example/x', '/../../user', '/issues/{owner}', '/issues 1', '/issues#x', '//evil.example']) expect(page.safeParse({ path: bad }).success, bad).toBe(false)
    expect(DESKTOP_REPOSITORY_TOOL_NAMES).toEqual(['repo_prepare', 'repo_list', 'repo_read', 'repo_search', 'repo_write', 'repo_edit', 'repo_delete', 'repo_status', 'repo_diff', 'repo_github', 'repo_comment', 'repo_publish'])
})
