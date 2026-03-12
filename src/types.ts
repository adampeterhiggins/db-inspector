import * as vscode from 'vscode';

export type DbDialect = 'postgres' | 'mysql' | 'sqlite';

export interface ConnectionProfile {
  id: string;
  name: string;
  dialect: DbDialect;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl?: boolean;
  sqlitePath?: string;
  hasPassword?: boolean;
}

export type SchemaObjectType = 'table' | 'view' | 'function';

export interface SchemaObjectGroups {
  tables: string[];
  views: string[];
  functions: string[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string | null;
  extra?: string;
}

export interface IndexInfo {
  name: string;
  definition: string;
}

export interface ConstraintInfo {
  name: string;
  type: string;
  definition?: string;
}

export interface QueryExecutionResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  message?: string;
}

export interface DbAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readonly connected: boolean;
  listSchemas(): Promise<string[]>;
  listSchemaObjects(schema: string): Promise<SchemaObjectGroups>;
  getTableColumns(schema: string, table: string): Promise<ColumnInfo[]>;
  getTableIndexes(schema: string, table: string): Promise<IndexInfo[]>;
  getTableConstraints(schema: string, table: string): Promise<ConstraintInfo[]>;
  getObjectDdl(schema: string, objectName: string, objectType: SchemaObjectType): Promise<string>;
  previewTableData(schema: string, table: string, limit: number): Promise<QueryExecutionResult>;
  execute(sql: string): Promise<QueryExecutionResult>;
}

export type GroupKind = 'tables' | 'views' | 'functions' | 'columns' | 'indexes' | 'constraints';

export interface ConnectionNode {
  kind: 'connection';
  connectionId: string;
}

export interface ActionNode {
  kind: 'action';
  connectionId: string;
  label: string;
  description?: string;
  command: vscode.Command;
}

export interface SchemaNode {
  kind: 'schema';
  connectionId: string;
  schema: string;
}

export interface GroupNode {
  kind: 'group';
  connectionId: string;
  schema: string;
  group: GroupKind;
  objectName?: string;
}

export interface ObjectNode {
  kind: 'object';
  connectionId: string;
  schema: string;
  objectType: SchemaObjectType;
  objectName: string;
}

export interface ColumnNode {
  kind: 'column';
  connectionId: string;
  schema: string;
  table: string;
  column: ColumnInfo;
}

export interface IndexNode {
  kind: 'index';
  connectionId: string;
  schema: string;
  table: string;
  index: IndexInfo;
}

export interface ConstraintNode {
  kind: 'constraint';
  connectionId: string;
  schema: string;
  table: string;
  constraint: ConstraintInfo;
}

export type ExplorerNode =
  | ConnectionNode
  | ActionNode
  | SchemaNode
  | GroupNode
  | ObjectNode
  | ColumnNode
  | IndexNode
  | ConstraintNode;
