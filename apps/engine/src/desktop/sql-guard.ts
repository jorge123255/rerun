// This is a deliberately narrow SQL surface, not a general-purpose SQLite console.
// Keep literals tokenized: SQLite also accepts single-quoted identifiers in table positions.
type Token = { value: string; literal: boolean; quoted: boolean; start: number }
export function sqlTokens(sql: string): Token[] {
    if (!sql.trim() || sql.length > 20_000 || sql.includes('\0')) throw new Error('SQL must contain 1–20000 characters.')
    const tokens: Token[] = []
    for (let i = 0; i < sql.length;) {
        if (/\s/.test(sql[i])) { i++; continue }
        if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue }
        if (sql.startsWith('/*', i)) { const end = sql.indexOf('*/', i + 2); if (end < 0) throw new Error('Unterminated SQL comment.'); i = end + 2; continue }
        const offset = i
        const start = sql[i]
        if (`'"\`[`.includes(start)) {
            const close = start === '[' ? ']' : start
            let value = '', closed = false
            i++
            while (i < sql.length) {
                if (sql[i] === close) {
                    i++
                    if (close !== ']' && sql[i] === close) { value += close; i++; continue }
                    closed = true; break
                }
                value += sql[i++]
            }
            if (!closed) throw new Error('Unterminated SQL quote.')
            tokens.push({ value, literal: start === "'", quoted: true, start: offset })
            continue
        }
        const word = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(sql.slice(i))?.[0]
        if (word) { tokens.push({ value: word, literal: false, quoted: false, start: i }); i += word.length; continue }
        tokens.push({ value: sql[i++], literal: false, quoted: false, start: offset })
    }
    return tokens
}
export function singleStatement(sql: string): string {
    const tokens = sqlTokens(sql)
    const semicolons = tokens.filter(t => !t.quoted && t.value === ';')
    if (semicolons.length > 1 || (semicolons.length && tokens.at(-1) !== semicolons[0])) throw new Error('Provide one SQL statement per item.')
    return semicolons.length ? sql.slice(0, semicolons[0].start) : sql
}

export function assertNoHiddenTables(sql: string, hidden: readonly string[]): void {
    const names = new Set(hidden.map(name => name.toLowerCase()))
    for (const token of sqlTokens(sql)) {
        const name = token.value.toLowerCase()
        if (names.has(name) || name.startsWith('sqlite_') || name.startsWith('_rerun_')) throw new Error('Internal tables are not available here. Read the tables you can use with the schema tool instead.')
    }
}
export function assertNoPragma(sql: string): void {
    for (const token of sqlTokens(sql)) {
        if (token.literal) continue
        if (/^pragma(?:_|$)/i.test(token.value)) throw new Error('PRAGMA is not available here.')
        if (/^vacuum$/i.test(token.value)) throw new Error('VACUUM is not available here.')
    }
}
// No size-controlled allocation or growing string aggregation functions: printf/format,
// randomblob/zeroblob, replace and group_concat/string_agg/json_group_* can allocate huge native
// buffers before a row cap or the parent deadline can help. Use ordinary bounded rows instead.
const FUNCTIONS = new Set(('abs avg cast char coalesce count date datetime glob ifnull iif instr json_array_length json_extract json_type json_valid julianday length like likelihood likely lower ltrim max min nullif random round rtrim sign strftime substr substring sum time total trim typeof unicode unixepoch unlikely upper ' +
    // SQL grammar preceding parentheses, not extension/function calls.
    'as in exists values select over partition filter check default unique primary key foreign references integer real text blob numeric decimal varchar from join inner left right outer cross using group and or not on where having by order when then else union all distinct case between collate escape set limit offset generated always conflict do nothing update').split(' '))
export function assertSafeFunctions(sql: string): void {
    const tokens = sqlTokens(sql)
    for (let i = 0; i < tokens.length - 1; i++) {
        const token = tokens[i]
        // Recursive concatenation can double a native buffer repeatedly before the deadline.
        // Build display strings in the caller; quoted text containing || is still ordinary data.
        if (!token.quoted && token.value === '|' && !tokens[i + 1].quoted && tokens[i + 1].value === '|') throw new Error('SQL string concatenation is unavailable. Read or write bounded values instead.')
        if ((tokens[i + 1].quoted || tokens[i + 1].value !== '(') || !/^[\p{L}_]/u.test(token.value)) continue
        if (FUNCTIONS.has(token.value.toLowerCase())) continue
        const previous = tokens[i - 1]?.value.toLowerCase()
        // Column lists for CREATE TABLE, INSERT INTO and REFERENCES table.
        if (['table', 'into', 'exists', 'references'].includes(previous)) continue
        // CTE column list: name(columns) AS (...). Names here are parsed by SQLite, never called.
        let depth = 0, end = i + 1
        for (; end < tokens.length; end++) { if (!tokens[end].quoted && tokens[end].value === '(') depth++; if (!tokens[end].quoted && tokens[end].value === ')' && --depth === 0) break }
        if (tokens[end + 1]?.value.toLowerCase() === 'as' && tokens[end + 2]?.value === '(' && ['with', 'recursive', ','].includes(previous)) continue
        throw new Error(`SQL function is unavailable: ${token.value}`)
    }
}
export function assertExplicitWrite(sql: string): void {
    const tokens = sqlTokens(singleStatement(sql)).filter(t => !t.literal).map(t => t.value.toLowerCase())
    if (!(['insert', 'update', 'delete', 'replace'].includes(tokens[0]) || (['create', 'alter', 'drop'].includes(tokens[0]) && tokens[1] === 'table'))) throw new Error('Use explicit CREATE/ALTER/DROP TABLE or INSERT/UPDATE/DELETE statements.')
    if (tokens.some(t => ['attach', 'detach', 'pragma', 'vacuum', 'trigger', 'virtual', 'temp', 'temporary', 'begin', 'commit', 'rollback', 'savepoint', 'release', 'returning'].includes(t))) throw new Error('That SQL operation is unavailable here.')
    assertSafeFunctions(sql)
}
