import * as vscode from 'vscode';
import { ConnectionManager } from '../db/connectionManager';
import { ConnectionStore } from '../store/connectionStore';
import {
  ActionNode,
  ColumnNode,
  ConstraintNode,
  ExplorerNode,
  GroupKind,
  GroupNode,
  IndexNode,
  ObjectNode,
  SchemaObjectGroups,
} from '../types';

function schemaCacheKey(connectionId: string, schema: string): string {
  return `${connectionId}::${schema}`;
}

export class DatabaseExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ExplorerNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly schemaObjectsCache = new Map<string, SchemaObjectGroups>();

  constructor(
    private readonly connectionStore: ConnectionStore,
    private readonly connectionManager: ConnectionManager,
  ) {}

  refresh(connectionId?: string): void {
    if (!connectionId) {
      this.schemaObjectsCache.clear();
      this.onDidChangeTreeDataEmitter.fire(undefined);
      return;
    }

    for (const key of [...this.schemaObjectsCache.keys()]) {
      if (key.startsWith(`${connectionId}::`)) {
        this.schemaObjectsCache.delete(key);
      }
    }
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(node: ExplorerNode): vscode.TreeItem {
    switch (node.kind) {
      case 'connection': {
        const connection = this.connectionStore.get(node.connectionId);
        const isConnected = this.connectionManager.isConnected(node.connectionId);

        const item = new vscode.TreeItem(
          connection?.name ?? node.connectionId,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.contextValue = isConnected ? 'dbInspector.connectionConnected' : 'dbInspector.connectionDisconnected';
        item.description = connection ? `${connection.dialect}${isConnected ? ' (connected)' : ' (disconnected)'}` : '';
        item.iconPath = new vscode.ThemeIcon(isConnected ? 'plug' : 'debug-disconnect');
        item.tooltip = connection?.sqlitePath
          ? `${connection.name}\n${connection.sqlitePath}`
          : `${connection?.name ?? node.connectionId}\n${connection?.user ?? ''}@${connection?.host ?? ''}/${connection?.database ?? ''}`;
        return item;
      }

      case 'action': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.command = node.command;
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon('add');
        item.contextValue = 'dbInspector.action';
        return item;
      }

      case 'schema': {
        const item = new vscode.TreeItem(node.schema, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = 'dbInspector.schema';
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        return item;
      }

      case 'group': {
        const label = this.groupLabel(node.group);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = `dbInspector.group.${node.group}`;
        item.iconPath = new vscode.ThemeIcon('list-tree');
        return item;
      }

      case 'object': {
        const item = new vscode.TreeItem(
          node.objectName,
          node.objectType === 'table' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );

        item.contextValue = `dbInspector.${node.objectType}`;
        item.iconPath =
          node.objectType === 'table'
            ? new vscode.ThemeIcon('table')
            : node.objectType === 'view'
              ? new vscode.ThemeIcon('preview')
              : new vscode.ThemeIcon('symbol-function');

        return item;
      }

      case 'column': {
        const item = new vscode.TreeItem(node.column.name, vscode.TreeItemCollapsibleState.None);
        const nullability = node.column.nullable ? 'NULL' : 'NOT NULL';
        const parts = [node.column.type, nullability];
        if (node.column.defaultValue) {
          parts.push(`DEFAULT ${node.column.defaultValue}`);
        }
        if (node.column.extra) {
          parts.push(node.column.extra);
        }
        item.description = parts.join(' ');
        item.contextValue = 'dbInspector.column';
        item.iconPath = new vscode.ThemeIcon('symbol-field');
        return item;
      }

      case 'index': {
        const item = new vscode.TreeItem(node.index.name, vscode.TreeItemCollapsibleState.None);
        item.description = node.index.definition;
        item.contextValue = 'dbInspector.index';
        item.iconPath = new vscode.ThemeIcon('symbol-key');
        return item;
      }

      case 'constraint': {
        const item = new vscode.TreeItem(node.constraint.name, vscode.TreeItemCollapsibleState.None);
        item.description = [node.constraint.type, node.constraint.definition].filter(Boolean).join(' ');
        item.contextValue = 'dbInspector.constraint';
        item.iconPath = new vscode.ThemeIcon('shield');
        return item;
      }

      default:
        return new vscode.TreeItem('Unsupported node');
    }
  }

  async getChildren(node?: ExplorerNode): Promise<ExplorerNode[]> {
    try {
      if (!node) {
        return this.rootNodes();
      }

      if (node.kind === 'connection') {
        return this.connectionChildren(node.connectionId);
      }

      if (node.kind === 'schema') {
        return this.schemaChildren(node.connectionId, node.schema);
      }

      if (node.kind === 'group') {
        return this.groupChildren(node);
      }

      if (node.kind === 'object') {
        return this.resolveChildrenForObject(node);
      }

      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`DB Inspector: ${message}`);
      return [];
    }
  }

  private rootNodes(): ExplorerNode[] {
    const connections = this.connectionStore.list();

    if (connections.length === 0) {
      const addNode: ActionNode = {
        kind: 'action',
        connectionId: 'none',
        label: 'Add your first connection',
        description: 'Create a PostgreSQL, MySQL, or SQLite profile',
        command: {
          command: 'dbInspector.addConnection',
          title: 'Add Connection',
        },
      };
      return [addNode];
    }

    return connections.map((connection) => ({
      kind: 'connection',
      connectionId: connection.id,
    }));
  }

  private async connectionChildren(connectionId: string): Promise<ExplorerNode[]> {
    if (!this.connectionManager.isConnected(connectionId)) {
      const connectOnExpand = vscode.workspace.getConfiguration('dbInspector').get<boolean>('connectOnExpand', true);
      if (connectOnExpand) {
        try {
          await this.connectionManager.connect(connectionId);
        } catch {
          // Ignore and show action fallback below.
        }
      }
    }

    if (!this.connectionManager.isConnected(connectionId)) {
      return [
        {
          kind: 'action',
          connectionId,
          label: 'Connect to browse objects',
          command: {
            command: 'dbInspector.connect',
            title: 'Connect',
            arguments: [{ kind: 'connection', connectionId }],
          },
        },
      ];
    }

    const schemas = await this.connectionManager.listSchemas(connectionId);
    return schemas.map((schema) => ({
      kind: 'schema',
      connectionId,
      schema,
    }));
  }

  private async schemaChildren(connectionId: string, schema: string): Promise<ExplorerNode[]> {
    const groups = await this.getCachedSchemaObjects(connectionId, schema);
    if (!groups) {
      return [];
    }

    const nodes: GroupNode[] = [];
    if (groups.tables.length > 0) {
      nodes.push({ kind: 'group', connectionId, schema, group: 'tables' });
    }
    if (groups.views.length > 0) {
      nodes.push({ kind: 'group', connectionId, schema, group: 'views' });
    }
    if (groups.functions.length > 0) {
      nodes.push({ kind: 'group', connectionId, schema, group: 'functions' });
    }

    return nodes;
  }

  private async groupChildren(node: GroupNode): Promise<ExplorerNode[]> {
    if (node.group === 'columns' && node.objectName) {
      const columns = await this.connectionManager.getTableColumns(node.connectionId, node.schema, node.objectName);
      return columns.map<ColumnNode>((column) => ({
        kind: 'column',
        connectionId: node.connectionId,
        schema: node.schema,
        table: node.objectName!,
        column,
      }));
    }

    if (node.group === 'indexes' && node.objectName) {
      const indexes = await this.connectionManager.getTableIndexes(node.connectionId, node.schema, node.objectName);
      return indexes.map<IndexNode>((index) => ({
        kind: 'index',
        connectionId: node.connectionId,
        schema: node.schema,
        table: node.objectName!,
        index,
      }));
    }

    if (node.group === 'constraints' && node.objectName) {
      const constraints = await this.connectionManager.getTableConstraints(node.connectionId, node.schema, node.objectName);
      return constraints.map<ConstraintNode>((constraint) => ({
        kind: 'constraint',
        connectionId: node.connectionId,
        schema: node.schema,
        table: node.objectName!,
        constraint,
      }));
    }

    if (!node.objectName) {
      const objects = await this.getCachedSchemaObjects(node.connectionId, node.schema);
      const list =
        node.group === 'tables' ? objects.tables : node.group === 'views' ? objects.views : objects.functions;

      return list.map<ObjectNode>((objectName) => ({
        kind: 'object',
        connectionId: node.connectionId,
        schema: node.schema,
        objectType: node.group === 'tables' ? 'table' : node.group === 'views' ? 'view' : 'function',
        objectName,
      }));
    }

    return [];
  }

  private groupLabel(group: GroupKind): string {
    if (group === 'tables') {
      return 'Tables';
    }
    if (group === 'views') {
      return 'Views';
    }
    if (group === 'functions') {
      return 'Functions';
    }
    if (group === 'columns') {
      return 'Columns';
    }
    if (group === 'indexes') {
      return 'Indexes';
    }
    return 'Constraints';
  }

  async resolveChildrenForObject(node: ObjectNode): Promise<ExplorerNode[]> {
    if (node.objectType !== 'table') {
      return [];
    }

    return [
      {
        kind: 'group',
        connectionId: node.connectionId,
        schema: node.schema,
        group: 'columns',
        objectName: node.objectName,
      },
      {
        kind: 'group',
        connectionId: node.connectionId,
        schema: node.schema,
        group: 'indexes',
        objectName: node.objectName,
      },
      {
        kind: 'group',
        connectionId: node.connectionId,
        schema: node.schema,
        group: 'constraints',
        objectName: node.objectName,
      },
    ];
  }

  private async getCachedSchemaObjects(connectionId: string, schema: string): Promise<SchemaObjectGroups> {
    const key = schemaCacheKey(connectionId, schema);
    if (!this.schemaObjectsCache.has(key)) {
      const objects = await this.connectionManager.listSchemaObjects(connectionId, schema);
      this.schemaObjectsCache.set(key, objects);
    }

    const objects = this.schemaObjectsCache.get(key);
    if (!objects) {
      throw new Error(`Schema objects for ${schema} could not be loaded.`);
    }

    return objects;
  }
}
