import { describe, expect, it } from 'vitest'
import { assertExplicitWrite, assertNoHiddenTables, assertNoPragma, assertSafeFunctions, singleStatement } from './sql-guard.js'
describe('desktop SQL boundary', () => {
    it.each(["SELECT * FROM '_rerun_views'", 'SELECT * FROM "sqlite_schema"', 'SELECT * FROM [SQLITE_MASTER]', 'ALTER TABLE notes RENAME TO `_rerun_views`', "INSERT INTO notes VALUES ('_rerun_shared_tables')"])('refuses internal references %s', sql => expect(() => assertNoHiddenTables(sql, [])).toThrow())
    it.each(['SELECT load_extension(?)', 'SELECT 1, readfile(?) AS secret', "SELECT 'readfile'('/tmp/private')", 'SELECT * FROM pragma_database_list', 'SELECT * FROM pragma_table_info(?)'])('refuses extension/file/catalog entry %s', sql => expect(() => { assertNoPragma(sql); assertSafeFunctions(sql) }).toThrow())
    it.each(['CREATE TRIGGER evil AFTER INSERT ON notes BEGIN DELETE FROM other; END', 'CREATE VIEW hidden AS SELECT 1', 'CREATE VIRTUAL TABLE x USING fts5(x)', 'BEGIN', 'SELECT 1', 'INSERT INTO notes VALUES (1) RETURNING *'])('refuses implicit/general write %s', sql => expect(() => assertExplicitWrite(sql)).toThrow())
    it.each(["SELECT ';' AS value; -- safe trailing comment", 'SELECT 1 /* ; */;', 'SELECT "semicolon;column" FROM notes;'])('accepts one statement with quoted/comment semicolons %s', sql => expect(() => singleStatement(sql)).not.toThrow())
    it('refuses stacked statements and unterminated input', () => {
        for (const sql of ['SELECT 1; DELETE FROM notes', "SELECT 'unterminated", 'SELECT 1 /*']) expect(() => singleStatement(sql)).toThrow()
    })
    it('allows ordinary create, populate and aggregate reads', () => {
        assertExplicitWrite('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)')
        assertExplicitWrite('INSERT INTO notes (body) VALUES (?)')
        assertSafeFunctions('SELECT lower(body), count(*) FROM notes GROUP BY lower(body)')
        assertSafeFunctions('WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r WHERE x<250) SELECT x FROM r')
    })
})
