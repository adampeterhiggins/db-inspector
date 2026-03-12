import { ConnectionProfile, DbAdapter, QueryExecutionResult } from '../types';
import { createAdapter } from './adapters';

export class ConnectionManager {
  private readonly adaptersByConnectionId = new Map<string, DbAdapter>();

  constructor(
    private readonly getConnection: (connectionId: string) => ConnectionProfile | undefined,
    private readonly getPassword: (profile: ConnectionProfile) => Promise<string | undefined>,
  ) {}

  isConnected(connectionId: string): boolean {
    return this.adaptersByConnectionId.has(connectionId);
  }

  connectedIds(): Set<string> {
    return new Set(this.adaptersByConnectionId.keys());
  }

  async connect(connectionId: string): Promise<void> {
    if (this.adaptersByConnectionId.has(connectionId)) {
      return;
    }

    const profile = this.getConnection(connectionId);
    if (!profile) {
      throw new Error(`Connection ${connectionId} does not exist.`);
    }

    const password = await this.getPassword(profile);
    const adapter = createAdapter(profile, password);
    await adapter.connect();
    this.adaptersByConnectionId.set(connectionId, adapter);
  }

  async disconnect(connectionId: string): Promise<void> {
    const adapter = this.adaptersByConnectionId.get(connectionId);
    if (!adapter) {
      return;
    }

    await adapter.disconnect();
    this.adaptersByConnectionId.delete(connectionId);
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.adaptersByConnectionId.keys()];
    for (const id of ids) {
      await this.disconnect(id);
    }
  }

  async execute(connectionId: string, sql: string): Promise<QueryExecutionResult> {
    const adapter = this.require(connectionId);
    return adapter.execute(sql);
  }

  async listSchemas(connectionId: string): Promise<string[]> {
    const adapter = this.require(connectionId);
    return adapter.listSchemas();
  }

  async listSchemaObjects(connectionId: string, schema: string) {
    const adapter = this.require(connectionId);
    return adapter.listSchemaObjects(schema);
  }

  async getTableColumns(connectionId: string, schema: string, table: string) {
    const adapter = this.require(connectionId);
    return adapter.getTableColumns(schema, table);
  }

  async getTableIndexes(connectionId: string, schema: string, table: string) {
    const adapter = this.require(connectionId);
    return adapter.getTableIndexes(schema, table);
  }

  async getTableConstraints(connectionId: string, schema: string, table: string) {
    const adapter = this.require(connectionId);
    return adapter.getTableConstraints(schema, table);
  }

  async previewTableData(connectionId: string, schema: string, table: string, limit: number) {
    const adapter = this.require(connectionId);
    return adapter.previewTableData(schema, table, limit);
  }

  async getObjectDdl(connectionId: string, schema: string, objectName: string, objectType: 'table' | 'view' | 'function') {
    const adapter = this.require(connectionId);
    return adapter.getObjectDdl(schema, objectName, objectType);
  }

  private require(connectionId: string): DbAdapter {
    const adapter = this.adaptersByConnectionId.get(connectionId);
    if (!adapter) {
      throw new Error('Connection is not active. Connect first.');
    }

    return adapter;
  }
}
