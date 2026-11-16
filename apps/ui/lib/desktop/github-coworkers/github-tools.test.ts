import { describe, expect, it } from 'vitest'
import { desktopRerunGrantsOf, desktopRerunToolCatalog, desktopGithubAlwaysAsks, desktopGithubCall, desktopGithubToolAccess, DESKTOP_GITHUB_WRITE_GRANT, DESKTOP_GITHUB_WRITE_LABEL, DESKTOP_GITHUB_WRITE_OFF_MESSAGE } from '@rerun/contracts'

// Names as the Mac sees them: GitHub's own MCP server from the Vault catalog is named "github",
// so its tools arrive as github_<tool>; Composio's arrive as GITHUB_<ACTION>.
const READ = [
    'github_get_me', 'github_get_file_contents', 'github_get_commit', 'github_list_commits', 'github_list_branches', 'github_list_tags', 'github_get_tag',
    'github_list_issues', 'github_search_issues', 'github_search_code', 'github_search_repositories', 'github_search_pull_requests', 'github_search_users',
    'github_issue_read', 'github_pull_request_read', 'github_list_pull_requests', 'github_get_pull_request_reviews', 'github_get_pull_request_comments', 'github_list_issue_comments',
    'github_list_releases', 'github_get_latest_release', 'github_get_release_by_tag', 'github_list_workflow_runs', 'github_get_job_logs', 'github_download_workflow_run_artifact',
    'github_list_notifications', 'github_get_notification_details', 'github_projects_list', 'github_projects_get', 'github_actions_list', 'github_actions_get', 'github_label_read', 'github_get_label',
    'github_list_discussions', 'github_get_discussion_comments', 'github_list_gists', 'github_get_gist', 'github_list_code_scanning_alerts', 'github_get_secret_scanning_alert',
    'GITHUB_GET_A_REPOSITORY', 'GITHUB_GET_REPOSITORY_CONTENT', 'GITHUB_GET_A_PULL_REQUEST', 'GITHUB_LIST_PULL_REQUESTS', 'GITHUB_LIST_REPOSITORY_ISSUES', 'GITHUB_GET_AN_ISSUE',
    'GITHUB_LIST_COMMITS', 'GITHUB_GET_A_COMMIT', 'GITHUB_COMPARE_TWO_COMMITS', 'GITHUB_LIST_BRANCHES', 'GITHUB_GET_A_BRANCH', 'GITHUB_GET_A_REFERENCE', 'GITHUB_SEARCH_REPOSITORIES',
    'GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS', 'GITHUB_SEARCH_CODE', 'GITHUB_FIND_PULL_REQUESTS', 'GITHUB_LIST_REVIEW_COMMENTS_ON_A_PULL_REQUEST', 'GITHUB_LIST_ISSUE_COMMENTS',
    'GITHUB_CHECK_IF_A_PULL_REQUEST_HAS_BEEN_MERGED', 'GITHUB_GET_THE_LATEST_RELEASE', 'GITHUB_LIST_RELEASES', 'GITHUB_GET_THE_AUTHENTICATED_USER', 'GITHUB_GET_A_REPOSITORY_README',
    'GITHUB_DOWNLOAD_A_REPOSITORY_ARCHIVE_ZIP', 'GITHUB_LIST_WORKFLOW_RUNS_FOR_A_REPOSITORY', 'composio_GITHUB_LIST_COMMITS',
]
const WRITE = [
    'github_create_or_update_file', 'github_push_files', 'github_delete_file', 'github_create_branch', 'github_create_repository', 'github_fork_repository',
    'github_create_pull_request', 'github_update_pull_request', 'github_update_pull_request_branch', 'github_merge_pull_request', 'github_pull_request_review_write',
    'github_add_comment_to_pending_review', 'github_request_copilot_review', 'github_issue_write', 'github_sub_issue_write', 'github_add_issue_comment', 'github_assign_copilot_to_issue',
    'github_create_issue', 'github_update_issue', 'github_label_write', 'github_projects_write', 'github_actions_run_trigger', 'github_run_workflow', 'github_rerun_workflow_run',
    'github_cancel_workflow_run', 'github_delete_workflow_run_logs', 'github_create_gist', 'github_update_gist', 'github_star_repository', 'github_unstar_repository',
    'github_dismiss_notification', 'github_mark_all_notifications_read', 'github_manage_notification_subscription', 'github_create_release', 'github_get_or_create_label',
    'GITHUB_CREATE_A_PULL_REQUEST', 'GITHUB_UPDATE_A_PULL_REQUEST', 'GITHUB_MERGE_A_PULL_REQUEST', 'GITHUB_CREATE_AN_ISSUE', 'GITHUB_UPDATE_AN_ISSUE', 'GITHUB_CREATE_AN_ISSUE_COMMENT',
    'GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST', 'GITHUB_SUBMIT_A_REVIEW_FOR_A_PULL_REQUEST', 'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS', 'GITHUB_DELETE_A_FILE', 'GITHUB_CREATE_A_REFERENCE',
    'GITHUB_DELETE_A_REFERENCE', 'GITHUB_CREATE_A_COMMIT', 'GITHUB_CREATE_A_RELEASE', 'GITHUB_DELETE_A_RELEASE', 'GITHUB_DELETE_A_REPOSITORY', 'GITHUB_MERGE_A_BRANCH', 'GITHUB_LOCK_AN_ISSUE',
    'GITHUB_ADD_LABELS_TO_AN_ISSUE', 'GITHUB_REMOVE_A_LABEL_FROM_AN_ISSUE', 'GITHUB_CREATE_A_FORK', 'GITHUB_CREATE_A_WORKFLOW_DISPATCH_EVENT', 'GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER',
    'GITHUB_CLOSE_AN_ISSUE', 'composio_GITHUB_CREATE_AN_ISSUE',
]

describe('the GitHub read and write table', () => {
    it.each(READ)('%s reads', name => { expect(desktopGithubToolAccess(name)).toBe('read'); expect(desktopGithubCall(name, {})).toBeNull() })
    it.each(WRITE)('%s changes a repository', name => { expect(desktopGithubToolAccess(name)).toBe('write'); expect(desktopGithubCall(name, {})).toMatchObject({ tool: name }) })

    it('treats a GitHub tool it does not recognise as a change', () => {
        for (const name of ['github_frobnicate', 'github_sync', 'GITHUB_RENDER_A_MARKDOWN_DOCUMENT', 'GITHUB_DO_SOMETHING_NEW', 'github_', 'github_repository_dispatch']) {
            expect(desktopGithubToolAccess(name), name).toBe('write')
        }
    })

    it('leaves other connectors alone, whatever their tools are called', () => {
        for (const name of ['gmail_send_email', 'GMAIL_SEND_EMAIL', 'drive_delete_file', 'linear_create_issue', 'notes_github_link', 'vercel_connect_github_repository', 'get_github_status']) {
            expect(desktopGithubToolAccess(name), name).toBeNull()
            expect(desktopGithubCall(name, {}), name).toBeNull()
        }
    })

    it('recognises a GitHub connector by its host or its name when the tool name does not say so', () => {
        expect(desktopGithubToolAccess('gh_create_branch', { host: 'api.githubcopilot.com', name: 'gh', tool: 'create_branch' })).toBe('write')
        expect(desktopGithubToolAccess('gh_get_file_contents', { host: 'api.githubcopilot.com', name: 'gh', tool: 'get_file_contents' })).toBe('read')
        expect(desktopGithubToolAccess('create_issue', { name: 'github', tool: 'create_issue' })).toBe('write')
        expect(desktopGithubToolAccess('gh_create_branch', { host: 'api.githubcopilot.com.evil.test', name: 'gh', tool: 'create_branch' })).toBeNull()
        // Held under a name the later checks read back as GitHub's.
        const held = desktopGithubCall('gh_merge_pull_request', {}, { host: 'api.githubcopilot.com', name: 'gh', tool: 'merge_pull_request' })!
        expect(held).toMatchObject({ tool: 'github_merge_pull_request', alwaysAsk: true })
        expect(desktopGithubAlwaysAsks(held.tool)).toBe(true)
    })
})

describe('what always asks', () => {
    it('merging a pull request and deleting a branch, a file or a repository ask every time', () => {
        for (const name of ['github_merge_pull_request', 'GITHUB_MERGE_A_PULL_REQUEST', 'GITHUB_MERGE_A_BRANCH', 'github_delete_file', 'GITHUB_DELETE_A_FILE', 'GITHUB_DELETE_A_REFERENCE', 'github_delete_branch', 'GITHUB_DELETE_A_REPOSITORY']) {
            expect(desktopGithubAlwaysAsks(name), name).toBe(true)
            expect(desktopGithubCall(name, {})!.alwaysAsk, name).toBe(true)
        }
    })
    it('other changes may get a standing answer, and reads and other connectors never count', () => {
        for (const name of ['github_create_pull_request', 'GITHUB_CREATE_AN_ISSUE_COMMENT', 'github_push_files', 'GITHUB_DELETE_A_RELEASE', 'github_get_file_contents', 'drive_delete_file', 'git_merge_branch']) {
            expect(desktopGithubAlwaysAsks(name), name).toBe(false)
        }
    })
})

describe('GitHub tools reached through another tool', () => {
    const multi = (...slugs: string[]) => ({ tools: slugs.map(tool_slug => ({ tool_slug, arguments: { owner: 'acme', repo: 'openflix' } })), thought: 'changes every attempt' })

    it('classifies each inner tool of Composio multi-execute', () => {
        expect(desktopGithubCall('COMPOSIO_MULTI_EXECUTE_TOOL', multi('GITHUB_LIST_COMMITS', 'GITHUB_GET_A_PULL_REQUEST'))).toBeNull()
        const held = desktopGithubCall('COMPOSIO_MULTI_EXECUTE_TOOL', multi('GITHUB_LIST_COMMITS', 'GITHUB_CREATE_A_PULL_REQUEST'))!
        expect(held.tool).toBe('GITHUB_CREATE_A_PULL_REQUEST')
        expect(held.alwaysAsk).toBe(false)
        // The answer covers the inner calls alone, not the wrapper's own notes.
        expect(held.subject).toEqual({ tools: multi('GITHUB_LIST_COMMITS', 'GITHUB_CREATE_A_PULL_REQUEST').tools })
        expect(desktopGithubCall('composio_COMPOSIO_MULTI_EXECUTE_TOOL', multi('GITHUB_MERGE_A_PULL_REQUEST'))).toMatchObject({ tool: 'GITHUB_MERGE_A_PULL_REQUEST', alwaysAsk: true })
    })

    it('one card names every inner tool that asks, the always-asking ones first', () => {
        const held = desktopGithubCall('COMPOSIO_MULTI_EXECUTE_TOOL', multi('GMAIL_SEND_EMAIL', 'GITHUB_CREATE_AN_ISSUE', 'GITHUB_DELETE_A_FILE', 'GMAIL_FETCH_EMAILS'))!
        expect(held.tool).toBe('GITHUB_DELETE_A_FILE+GITHUB_CREATE_AN_ISSUE+GMAIL_SEND_EMAIL')
        expect(held.alwaysAsk).toBe(true)
        expect(desktopGithubAlwaysAsks(held.tool)).toBe(true)
    })

    it('a multi-execute with no GitHub change is not handled here', () => {
        expect(desktopGithubCall('COMPOSIO_MULTI_EXECUTE_TOOL', multi('GMAIL_SEND_EMAIL'))).toBeNull()
        expect(desktopGithubCall('COMPOSIO_MULTI_EXECUTE_TOOL', {})).toBeNull()
    })

    it('reads GitHub tools named in the code of a remote sandbox call', () => {
        const code = "r = run_composio_tool('GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS', {'path': 'README.md'})"
        expect(desktopGithubCall('COMPOSIO_REMOTE_WORKBENCH', { code_to_execute: code, thought: 'x' })).toMatchObject({ tool: 'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS', subject: { code: [code] } })
        expect(desktopGithubCall('COMPOSIO_REMOTE_WORKBENCH', { code_to_execute: "run_composio_tool('GITHUB_LIST_COMMITS', {})" })).toBeNull()
        expect(desktopGithubCall('COMPOSIO_REMOTE_WORKBENCH', { code_to_execute: 'print(1)' })).toBeNull()
    })
})

describe('the permission', () => {
    it('is in the catalog under its own name, offers no tool of its own, and is off unless saved as true', () => {
        const row = desktopRerunToolCatalog.find(entry => entry.id === DESKTOP_GITHUB_WRITE_GRANT)!
        expect(row).toMatchObject({ label: DESKTOP_GITHUB_WRITE_LABEL, available: true, tools: [] })
        expect(desktopRerunGrantsOf({}).githubWrite).toBe(false)
        expect(desktopRerunGrantsOf({ desktopToolGrants: { services: true } }).githubWrite).toBe(false)
        expect(desktopRerunGrantsOf({ desktopToolGrants: { githubWrite: true } }).githubWrite).toBe(true)
        expect(DESKTOP_GITHUB_WRITE_OFF_MESSAGE).toContain(DESKTOP_GITHUB_WRITE_LABEL)
        expect(DESKTOP_GITHUB_WRITE_OFF_MESSAGE).toContain('did not run')
    })
})
