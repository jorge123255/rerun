import { expect, test } from 'vitest'
import { mcpRegisterCardOf } from '@rerun/contracts'

test('a proposed server is not displayed as added before human approval', () => {
    expect(mcpRegisterCardOf('mcp_register', { name: 'linear' },
        'Proposed MCP server "linear" (http). A review card is waiting in the Mac app — nothing is saved, connected or executed until a human approves it there.')).toBeNull()
})

test('desktop refusal and unknown results never imply a saved server', () => {
    expect(mcpRegisterCardOf('mcp_register', { name: 'linear' }, 'Nothing was proposed or saved.')).toMatchObject({ outcome: 'failed' })
    expect(mcpRegisterCardOf('mcp_register', { name: 'linear' }, 'Nothing was saved.')).toMatchObject({ outcome: 'failed' })
    expect(mcpRegisterCardOf('mcp_register', { name: 'linear' }, 'Unrecognized response')).toBeNull()
    expect(mcpRegisterCardOf('mcp_register', { name: 'linear' }, {})).toBeNull()
    expect(mcpRegisterCardOf('mcp_register', { name: 'linear' }, 'Registered MCP server "linear" (http), but it requires sign-in.')).toMatchObject({ outcome: 'saved' })
})

test('only explicit matching save evidence renders an added card', () => {
    expect(mcpRegisterCardOf('mcp_register', { name: 'linear' }, 'Saved linear.')).toMatchObject({ outcome: 'saved' })
    expect(mcpRegisterCardOf('mcp_register', { name: 'linear' }, 'Saved another.')).toBeNull()
    expect(mcpRegisterCardOf('mcp_register', { name: 'linear' }, 'Connected and registered MCP server "linear" (http). 1 tools now available: search.')).toMatchObject({ outcome: 'saved' })
    expect(mcpRegisterCardOf('mcp_login', { name: 'linear' }, 'Ask the user to open this URL and sign in to "linear": https://example.test/verify')).toMatchObject({ outcome: 'saved' })
    expect(mcpRegisterCardOf('mcp_login', { name: 'linear' }, 'No MCP server named "linear" is registered.')).toBeNull()
    expect(mcpRegisterCardOf('mcp_login', { name: 'linear' }, 'Saved linear.')).toMatchObject({ outcome: 'saved' })
})
