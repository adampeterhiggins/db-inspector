import { Pool } from 'pg';
import mysql, { Connection } from 'mysql2/promise';
import { open, Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import {
  ColumnInfo,
  ConnectionProfile,
  ConstraintInfo,
  DbAdapter,
  IndexInfo,
  QueryExecutionResult,
  SchemaObjectGroups,
  SchemaObjectType,
} from '../types';

function assertConnected<T>(value: T | undefined, message: string): T {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function quotePg(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteMysql(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function quoteSqlite(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function isSelectLike(sql: string): boolean {
  return /^(select|with|pragma|explain)\b/i.test(sql.trim());
}

export class PostgresAdapter implements DbAdapter {
  private pool: Pool | undefined;

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly password?: string,
  ) {}

  get connected(): boolean {
    return Boolean(this.pool);
  }

  async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    this.pool = new Pool({
      host: this.profile.host,
      port: this.profile.port ?? 5432,
      database: this.profile.database,
      user: this.profile.user,
      password: this.password,
      ssl: this.profile.ssl ? { rejectUnauthorized: false } : undefined,
    });

    await this.pool.query('SELECT 1');
  }

  async disconnect(): Promise<void> {
    if (!this.pool) {
      return;
    }

    await this.pool.end();
    this.pool = undefined;
  }

  async listSchemas(): Promise<string[]> {
    const pool = assertConnected(this.pool, 'PostgreSQL connection is not active.');
    const result = await pool.query<{ schema_name: string }>(
      `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schema_name
      `,
    );
    return result.rows.map((row) => row.schema_name);
  }

  async listSchemaObjects(schema: string): Promise<SchemaObjectGroups> {
    const pool = assertConnected(this.pool, 'PostgreSQL connection is not active.');

    const [tablesResult, viewsResult, functionsResult] = await Promise.all([
      pool.query<{ table_name: string }>(
        `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
        ORDER BY table_name
        `,
        [schema],
      ),
      pool.query<{ table_name: string }>(
        `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'VIEW'
        ORDER BY table_name
        `,
        [schema],
      ),
      pool.query<{ signature: string }>(
        `
        SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature
        FROM pg_proc p
        INNER JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1
        ORDER BY signature
        `,
        [schema],
      ),
    ]);

    return {
      tables: tablesResult.rows.map((row) => row.table_name),
      views: viewsResult.rows.map((row) => row.table_name),
      functions: functionsResult.rows.map((row) => row.signature),
    };
  }

  async getTableColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    const pool = assertConnected(this.pool, 'PostgreSQL connection is not active.');
    const result = await pool.query<{
      column_name: string;
      is_nullable: 'YES' | 'NO';
      data_type: string;
      column_default: string | null;
    }>(
      `
      SELECT column_name, is_nullable, data_type, column_default
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
      `,
      [schema, table],
    );

    return result.rows.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
    }));
  }

  async getTableIndexes(schema: string, table: string): Promise<IndexInfo[]> {
    const pool = assertConnected(this.pool, 'PostgreSQL connection is not active.');
    const result = await pool.query<{ indexname: string; indexdef: string }>(
      `
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = $1 AND tablename = $2
      ORDER BY indexname
      `,
      [schema, table],
    );

    return result.rows.map((row) => ({
      name: row.indexname,
      definition: row.indexdef,
    }));
  }

  async getTableConstraints(schema: string, table: string): Promise<ConstraintInfo[]> {
    const pool = assertConnected(this.pool, 'PostgreSQL connection is not active.');
    const result = await pool.query<{
      constraint_name: string;
      constraint_type: string;
    }>(
      `
      SELECT constraint_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY constraint_type, constraint_name
      `,
      [schema, table],
    );

    return result.rows.map((row) => ({
      name: row.constraint_name,
      type: row.constraint_type,
    }));
  }

  async getObjectDdl(schema: string, objectName: string, objectType: SchemaObjectType): Promise<string> {
    const pool = assertConnected(this.pool, 'PostgreSQL connection is not active.');

    if (objectType === 'table') {
      const columns = await this.getTableColumns(schema, objectName);
      const lines = columns.map((column) => {
        const nullable = column.nullable ? '' : ' NOT NULL';
        const defaultClause = column.defaultValue ? ` DEFAULT ${column.defaultValue}` : '';
        return `  ${quotePg(column.name)} ${column.type}${defaultClause}${nullable}`;
      });
      return `CREATE TABLE ${quotePg(schema)}.${quotePg(objectName)} (\n${lines.join(',\n')}\n);`;
    }

    if (objectType === 'view') {
      const result = await pool.query<{ definition: string }>(
        `
        SELECT pg_get_viewdef(c.oid, true) AS definition
        FROM pg_class c
        INNER JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'v' AND n.nspname = $1 AND c.relname = $2
        LIMIT 1
        `,
        [schema, objectName],
      );
      const definition = result.rows[0]?.definition;
      if (!definition) {
        throw new Error(`View ${schema}.${objectName} was not found.`);
      }
      return `CREATE VIEW ${quotePg(schema)}.${quotePg(objectName)} AS\n${definition};`;
    }

    const baseName = objectName.split('(')[0] ?? objectName;
    const result = await pool.query<{ definition: string }>(
      `
      SELECT pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      INNER JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2
      ORDER BY p.oid
      LIMIT 1
      `,
      [schema, baseName],
    );

    const definition = result.rows[0]?.definition;
    if (!definition) {
      throw new Error(`Function ${schema}.${baseName} was not found.`);
    }

    return definition;
  }

  async previewTableData(schema: string, table: string, limit: number): Promise<QueryExecutionResult> {
    const pool = assertConnected(this.pool, 'PostgreSQL connection is not active.');
    const started = Date.now();
    const sql = `SELECT * FROM ${quotePg(schema)}.${quotePg(table)} LIMIT $1`;
    const result = await pool.query(sql, [limit]);

    return {
      columns: result.fields.map((field) => field.name),
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rowCount ?? result.rows.length,
      durationMs: Date.now() - started,
      message: `Previewed ${result.rows.length} row(s).`,
    };
  }

  async execute(sql: string): Promise<QueryExecutionResult> {
    const pool = assertConnected(this.pool, 'PostgreSQL connection is not active.');
    const started = Date.now();
    const result = await pool.query(sql);

    return {
      columns: result.fields.map((field) => field.name),
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rowCount ?? result.rows.length,
      durationMs: Date.now() - started,
      message: result.command ? `${result.command} completed.` : undefined,
    };
  }
}

export class MysqlAdapter implements DbAdapter {
  private connection: Connection | undefined;

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly password?: string,
  ) {}

  get connected(): boolean {
    return Boolean(this.connection);
  }

  async connect(): Promise<void> {
    if (this.connection) {
      return;
    }

    this.connection = await mysql.createConnection({
      host: this.profile.host,
      port: this.profile.port ?? 3306,
      user: this.profile.user,
      password: this.password,
      database: this.profile.database,
      ssl: this.profile.ssl ? {} : undefined,
      multipleStatements: false,
    });

    await this.connection.query('SELECT 1');
  }

  async disconnect(): Promise<void> {
    if (!this.connection) {
      return;
    }

    await this.connection.end();
    this.connection = undefined;
  }

  async listSchemas(): Promise<string[]> {
    const connection = assertConnected(this.connection, 'MySQL connection is not active.');
    const [rows] = await connection.query(
      `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY schema_name
      `,
    );

    return (rows as Array<{ schema_name: string }>).map((row) => row.schema_name);
  }

  async listSchemaObjects(schema: string): Promise<SchemaObjectGroups> {
    const connection = assertConnected(this.connection, 'MySQL connection is not active.');

    const [tableRows] = await connection.query(
      `
      SELECT table_name, table_type
      FROM information_schema.tables
      WHERE table_schema = ?
      ORDER BY table_name
      `,
      [schema],
    );

    const [functionRows] = await connection.query(
      `
      SELECT routine_name
      FROM information_schema.routines
      WHERE routine_schema = ? AND routine_type = 'FUNCTION'
      ORDER BY routine_name
      `,
      [schema],
    );

    const tables: string[] = [];
    const views: string[] = [];
    for (const row of tableRows as Array<{ table_name: string; table_type: string }>) {
      if (row.table_type === 'BASE TABLE') {
        tables.push(row.table_name);
      } else if (row.table_type === 'VIEW') {
        views.push(row.table_name);
      }
    }

    return {
      tables,
      views,
      functions: (functionRows as Array<{ routine_name: string }>).map((row) => row.routine_name),
    };
  }

  async getTableColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    const connection = assertConnected(this.connection, 'MySQL connection is not active.');
    const [rows] = await connection.query(
      `
      SELECT column_name, is_nullable, column_type, column_default, extra
      FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?
      ORDER BY ordinal_position
      `,
      [schema, table],
    );

    return (rows as Array<Record<string, string | null>>).map((row) => ({
      name: String(row.column_name),
      type: String(row.column_type),
      nullable: String(row.is_nullable) === 'YES',
      defaultValue: row.column_default,
      extra: row.extra ?? undefined,
    }));
  }

  async getTableIndexes(schema: string, table: string): Promise<IndexInfo[]> {
    const connection = assertConnected(this.connection, 'MySQL connection is not active.');
    const [rows] = await connection.query(
      `
      SELECT index_name, non_unique, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
      FROM information_schema.statistics
      WHERE table_schema = ? AND table_name = ?
      GROUP BY index_name, non_unique
      ORDER BY index_name
      `,
      [schema, table],
    );

    return (rows as Array<{ index_name: string; non_unique: number; columns: string }>).map((row) => ({
      name: row.index_name,
      definition: `${row.non_unique === 0 ? 'UNIQUE' : 'NON-UNIQUE'} (${row.columns})`,
    }));
  }

  async getTableConstraints(schema: string, table: string): Promise<ConstraintInfo[]> {
    const connection = assertConnected(this.connection, 'MySQL connection is not active.');
    const [rows] = await connection.query(
      `
      SELECT constraint_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_schema = ? AND table_name = ?
      ORDER BY constraint_type, constraint_name
      `,
      [schema, table],
    );

    return (rows as Array<{ constraint_name: string; constraint_type: string }>).map((row) => ({
      name: row.constraint_name,
      type: row.constraint_type,
    }));
  }

  async getObjectDdl(schema: string, objectName: string, objectType: SchemaObjectType): Promise<string> {
    const connection = assertConnected(this.connection, 'MySQL connection is not active.');

    if (objectType === 'table') {
      const [rows] = await connection.query(`SHOW CREATE TABLE ${quoteMysql(schema)}.${quoteMysql(objectName)}`);
      const row = (rows as Array<Record<string, string>>)[0];
      const ddl = row?.['Create Table'];
      if (!ddl) {
        throw new Error(`Table ${schema}.${objectName} was not found.`);
      }
      return `${ddl};`;
    }

    if (objectType === 'view') {
      const [rows] = await connection.query(`SHOW CREATE VIEW ${quoteMysql(schema)}.${quoteMysql(objectName)}`);
      const row = (rows as Array<Record<string, string>>)[0];
      const ddl = row?.['Create View'];
      if (!ddl) {
        throw new Error(`View ${schema}.${objectName} was not found.`);
      }
      return `${ddl};`;
    }

    const [rows] = await connection.query(`SHOW CREATE FUNCTION ${quoteMysql(schema)}.${quoteMysql(objectName)}`);
    const row = (rows as Array<Record<string, string>>)[0];
    const ddl = row?.['Create Function'];
    if (!ddl) {
      throw new Error(`Function ${schema}.${objectName} was not found.`);
    }
    return `${ddl};`;
  }

  async previewTableData(schema: string, table: string, limit: number): Promise<QueryExecutionResult> {
    const connection = assertConnected(this.connection, 'MySQL connection is not active.');
    const started = Date.now();
    const [rows, fields] = await connection.query(
      `SELECT * FROM ${quoteMysql(schema)}.${quoteMysql(table)} LIMIT ?`,
      [limit],
    );

    const rowArray = rows as Record<string, unknown>[];
    return {
      columns: (fields ?? []).map((field: { name: string }) => field.name),
      rows: rowArray,
      rowCount: rowArray.length,
      durationMs: Date.now() - started,
      message: `Previewed ${rowArray.length} row(s).`,
    };
  }

  async execute(sql: string): Promise<QueryExecutionResult> {
    const connection = assertConnected(this.connection, 'MySQL connection is not active.');
    const started = Date.now();
    const [rows, fields] = await connection.query(sql);

    if (Array.isArray(rows)) {
      return {
        columns: (fields ?? []).map((field: { name: string }) => field.name),
        rows: rows as Record<string, unknown>[],
        rowCount: rows.length,
        durationMs: Date.now() - started,
      };
    }

    const info = rows as { affectedRows?: number };
    return {
      columns: [],
      rows: [],
      rowCount: info.affectedRows ?? 0,
      durationMs: Date.now() - started,
      message: `Statement completed (${info.affectedRows ?? 0} row(s) affected).`,
    };
  }
}

export class SqliteAdapter implements DbAdapter {
  private database: Database | undefined;

  constructor(private readonly profile: ConnectionProfile) {}

  get connected(): boolean {
    return Boolean(this.database);
  }

  async connect(): Promise<void> {
    if (this.database) {
      return;
    }

    if (!this.profile.sqlitePath) {
      throw new Error('SQLite connection requires a file path.');
    }

    this.database = await open({
      filename: this.profile.sqlitePath,
      driver: sqlite3.Database,
    });

    await this.database.get('SELECT 1');
  }

  async disconnect(): Promise<void> {
    if (!this.database) {
      return;
    }

    await this.database.close();
    this.database = undefined;
  }

  async listSchemas(): Promise<string[]> {
    const database = assertConnected(this.database, 'SQLite connection is not active.');
    const rows = await database.all<Array<{ name: string }>>('PRAGMA database_list');
    return rows.map((row) => row.name);
  }

  async listSchemaObjects(schema: string): Promise<SchemaObjectGroups> {
    const database = assertConnected(this.database, 'SQLite connection is not active.');

    const tables = await database.all<Array<{ name: string }>>(
      `
      SELECT name
      FROM ${quoteSqlite(schema)}.sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
      `,
    );

    const views = await database.all<Array<{ name: string }>>(
      `
      SELECT name
      FROM ${quoteSqlite(schema)}.sqlite_master
      WHERE type = 'view'
      ORDER BY name
      `,
    );

    return {
      tables: tables.map((row) => row.name),
      views: views.map((row) => row.name),
      functions: [],
    };
  }

  async getTableColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    const database = assertConnected(this.database, 'SQLite connection is not active.');
    const rows = await database.all<Array<Record<string, unknown>>>(
      `PRAGMA ${quoteSqlite(schema)}.table_info(${quoteSqlite(table)})`,
    );

    return rows.map((row) => ({
      name: String(row.name),
      type: String(row.type),
      nullable: Number(row.notnull) === 0,
      defaultValue: row.dflt_value ? String(row.dflt_value) : null,
      extra: Number(row.pk) === 1 ? 'PRIMARY KEY' : undefined,
    }));
  }

  async getTableIndexes(schema: string, table: string): Promise<IndexInfo[]> {
    const database = assertConnected(this.database, 'SQLite connection is not active.');
    const rows = await database.all<Array<Record<string, unknown>>>(
      `PRAGMA ${quoteSqlite(schema)}.index_list(${quoteSqlite(table)})`,
    );

    return rows.map((row) => ({
      name: String(row.name),
      definition: Number(row.unique) === 1 ? 'UNIQUE' : 'NON-UNIQUE',
    }));
  }

  async getTableConstraints(schema: string, table: string): Promise<ConstraintInfo[]> {
    const database = assertConnected(this.database, 'SQLite connection is not active.');
    const columns = await database.all<Array<Record<string, unknown>>>(
      `PRAGMA ${quoteSqlite(schema)}.table_info(${quoteSqlite(table)})`,
    );

    const constraints: ConstraintInfo[] = [];
    if (columns.some((column) => Number(column.pk) === 1)) {
      constraints.push({
        name: `${table}_pk`,
        type: 'PRIMARY KEY',
      });
    }

    return constraints;
  }

  async getObjectDdl(schema: string, objectName: string, objectType: SchemaObjectType): Promise<string> {
    const database = assertConnected(this.database, 'SQLite connection is not active.');
    const sqliteType = objectType === 'function' ? 'trigger' : objectType;
    const row = await database.get<{ sql: string | null }>(
      `
      SELECT sql
      FROM ${quoteSqlite(schema)}.sqlite_master
      WHERE type = ? AND name = ?
      LIMIT 1
      `,
      [sqliteType, objectName],
    );

    if (!row?.sql) {
      throw new Error(`Object ${schema}.${objectName} was not found.`);
    }

    return `${row.sql};`;
  }

  async previewTableData(schema: string, table: string, limit: number): Promise<QueryExecutionResult> {
    const database = assertConnected(this.database, 'SQLite connection is not active.');
    const started = Date.now();
    const rows = await database.all<Record<string, unknown>[]>(
      `SELECT * FROM ${quoteSqlite(schema)}.${quoteSqlite(table)} LIMIT ?`,
      [limit],
    );

    return {
      columns: rows[0] ? Object.keys(rows[0]) : [],
      rows,
      rowCount: rows.length,
      durationMs: Date.now() - started,
      message: `Previewed ${rows.length} row(s).`,
    };
  }

  async execute(sql: string): Promise<QueryExecutionResult> {
    const database = assertConnected(this.database, 'SQLite connection is not active.');
    const started = Date.now();

    if (isSelectLike(sql)) {
      const rows = await database.all<Record<string, unknown>[]>(sql);
      return {
        columns: rows[0] ? Object.keys(rows[0]) : [],
        rows,
        rowCount: rows.length,
        durationMs: Date.now() - started,
      };
    }

    const result = await database.run(sql);
    return {
      columns: [],
      rows: [],
      rowCount: result.changes ?? 0,
      durationMs: Date.now() - started,
      message: `Statement completed (${result.changes ?? 0} row(s) affected).`,
    };
  }
}

export function createAdapter(profile: ConnectionProfile, password?: string): DbAdapter {
  if (profile.dialect === 'postgres') {
    return new PostgresAdapter(profile, password);
  }

  if (profile.dialect === 'mysql') {
    return new MysqlAdapter(profile, password);
  }

  return new SqliteAdapter(profile);
}
