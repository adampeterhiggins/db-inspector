import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionManager } from './db/connectionManager';
import { ConnectionStore, PasswordMode } from './store/connectionStore';
import {
  ColumnInfo,
  ConnectionProfile,
  ConnectionNode,
  DbDialect,
  ExplorerNode,
  ObjectNode,
  QueryExecutionResult,
} from './types';
import { DatabaseExplorerProvider } from './ui/databaseExplorerProvider';
import { QueryContextManager } from './ui/queryContext';
import { ResultsPanel, SandboxCompletionItem } from './ui/resultsPanel';
import {
  findStatementAtOffset,
  QueryRangeCommandArgs,
  SqlQueryCodeLensProvider,
} from './ui/sqlQueryCodeLensProvider';
import { renderSqlTemplateIfNeeded } from './ui/sqlTemplate';

interface PromptResult {
  profile: Omit<ConnectionProfile, 'id' | 'hasPassword'>;
  passwordMode: PasswordMode;
}

interface CatalogObject {
  schema: string;
  name: string;
  kind: 'table' | 'view' | 'function';
}

interface CompletionCatalog {
  schemas: string[];
  objects: CatalogObject[];
}

interface CompletionContext {
  prefix: string;
  qualifier?: string;
  tableContext: boolean;
  statementSql: string;
  inStringLiteral: boolean;
  inComment: boolean;
  valueContext: boolean;
}

interface ParsedTableReference {
  schema?: string;
  table: string;
  alias?: string;
}

interface ResolvedTableReference {
  schema: string;
  table: string;
  alias?: string;
}

const SQL_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP BY',
  'ORDER BY',
  'LIMIT',
  'OFFSET',
  'JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'INNER JOIN',
  'FULL JOIN',
  'ON',
  'WITH',
  'AS',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'CREATE TABLE',
  'ALTER TABLE',
  'DROP TABLE',
  'CREATE VIEW',
  'UNION',
  'UNION ALL',
  'DISTINCT',
  'AND',
  'OR',
  'NOT',
  'IN',
  'EXISTS',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
];

let activeConnectionManager: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const connectionStore = new ConnectionStore(context);

  const getPasswordForProfile = async (profile: ConnectionProfile): Promise<string | undefined> => {
    if (profile.dialect === 'sqlite') {
      return undefined;
    }

    const storedPassword = await connectionStore.getPassword(profile.id);
    if (storedPassword) {
      return storedPassword;
    }

    const password = await vscode.window.showInputBox({
      title: `Password for ${profile.name}`,
      prompt: `Enter password for ${profile.user ?? 'user'}@${profile.host ?? 'host'}`,
      password: true,
      ignoreFocusOut: true,
    });

    if (password === undefined) {
      throw new Error('Connection canceled (no password provided).');
    }

    if (password.length > 0) {
      await connectionStore.setPassword(profile.id, password);
      return password;
    }

    return undefined;
  };

  const connectionManager = new ConnectionManager(
    (connectionId) => connectionStore.get(connectionId),
    getPasswordForProfile,
  );
  activeConnectionManager = connectionManager;

  const explorerProvider = new DatabaseExplorerProvider(connectionStore, connectionManager);
  const queryContext = new QueryContextManager(() => connectionStore.list(), context);
  const completionCatalogCache = new Map<string, { loadedAt: number; catalog: CompletionCatalog }>();
  const completionColumnsCache = new Map<string, { loadedAt: number; columns: ColumnInfo[] }>();
  const resultsPanel = new ResultsPanel({
    onRunSandboxQuery: async (sql, options) => {
      await executeSql(sql, undefined, options);
    },
    onRequestCompletions: async (sql, cursor) => getSandboxCompletions(sql, cursor),
    getCurrentConnectionName: () => {
      const currentConnectionId = queryContext.getCurrentConnectionId();
      if (!currentConnectionId) {
        return undefined;
      }

      return connectionStore.get(currentConnectionId)?.name;
    },
  });

  const treeView = vscode.window.createTreeView('dbInspector.connectionsView', {
    treeDataProvider: explorerProvider,
    showCollapseAll: true,
  });
  const panelConnectionsView = vscode.window.createTreeView('dbInspector.panelConnectionsView', {
    treeDataProvider: explorerProvider,
    showCollapseAll: true,
  });

  const codeLensProvider = new SqlQueryCodeLensProvider(() =>
    vscode.workspace.getConfiguration('dbInspector').get<boolean>('enableQueryCodeLens', true),
  );
  const codeLensRegistration = vscode.languages.registerCodeLensProvider({ language: 'sql' }, codeLensProvider);
  const resultsViewRegistration = vscode.window.registerWebviewViewProvider(
    ResultsPanel.viewId,
    resultsPanel,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    },
  );

  context.subscriptions.push(
    treeView,
    panelConnectionsView,
    queryContext,
    codeLensRegistration,
    resultsViewRegistration,
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      queryContext.onActiveEditorChanged(editor);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      queryContext.removeConnectionForDocument(document);
    }),
  );

  const refresh = (connectionId?: string): void => {
    if (connectionId) {
      completionCatalogCache.delete(connectionId);
      for (const key of [...completionColumnsCache.keys()]) {
        if (key.startsWith(`${connectionId}::`)) {
          completionColumnsCache.delete(key);
        }
      }
    } else {
      completionCatalogCache.clear();
      completionColumnsCache.clear();
    }
    explorerProvider.refresh(connectionId);
    queryContext.onActiveEditorChanged(vscode.window.activeTextEditor);
  };

  async function chooseConnection(options?: {
    connectedOnly?: boolean;
    placeholder?: string;
  }): Promise<ConnectionProfile | undefined> {
    const connectedIds = connectionManager.connectedIds();
    const connections = connectionStore
      .list()
      .filter((profile) => !options?.connectedOnly || connectedIds.has(profile.id));

    if (connections.length === 0) {
      if (options?.connectedOnly) {
        void vscode.window.showWarningMessage('No active database connections. Connect to a database first.');
      } else {
        void vscode.window.showWarningMessage('No database connections configured yet.');
      }
      return undefined;
    }

    if (connections.length === 1) {
      return connections[0];
    }

    const picked = await vscode.window.showQuickPick(
      connections.map((connection) => ({
        label: connection.name,
        description: `${connection.dialect}${connection.database ? ` - ${connection.database}` : ''}`,
        connection,
      })),
      {
        placeHolder: options?.placeholder ?? 'Select a database connection',
      },
    );

    return picked?.connection;
  }

  async function resolveConnectionFromNode(node?: ExplorerNode): Promise<ConnectionProfile | undefined> {
    if (node?.kind === 'connection' || node?.kind === 'action' || node?.kind === 'schema' || node?.kind === 'group' || node?.kind === 'object' || node?.kind === 'column' || node?.kind === 'index' || node?.kind === 'constraint') {
      const profile = connectionStore.get(node.connectionId);
      if (profile) {
        return profile;
      }
    }

    return chooseConnection();
  }

  async function ensureConnected(connection: ConnectionProfile): Promise<void> {
    await connectionManager.connect(connection.id);
    queryContext.setCurrentConnection(connection.id);
    refresh(connection.id);
  }

  async function openQueryConsole(
    connection: ConnectionProfile | undefined,
    content: string,
  ): Promise<vscode.TextDocument> {
    const document = await vscode.workspace.openTextDocument({
      language: 'sql',
      content,
    });

    await vscode.window.showTextDocument(document, {
      preview: false,
    });

    if (connection) {
      queryContext.setCurrentConnection(connection.id);
      queryContext.setConnectionForDocument(document, connection.id);
    }

    return document;
  }

  async function executeSql(
    sql: string,
    document?: vscode.TextDocument,
    options?: { replaceTabId?: string },
  ): Promise<void> {
    const templatedSql = await renderSqlTemplateIfNeeded(sql);
    if (templatedSql === undefined) {
      return;
    }

    const trimmedSql = templatedSql.trim();
    if (!trimmedSql) {
      void vscode.window.showWarningMessage('No SQL to run.');
      return;
    }

    let connectionId = document
      ? queryContext.getConnectionForDocument(document)
      : queryContext.getCurrentConnectionId();
    let connection = connectionId ? connectionStore.get(connectionId) : undefined;
    if (!connection) {
      connection = await chooseConnection({
        placeholder: document
          ? 'Select connection to run SQL against'
          : 'Select connection to run sandbox SQL against',
      });
      if (!connection) {
        return;
      }

      connectionId = connection.id;
    }

    const resolvedConnectionId = connection.id;
    queryContext.setCurrentConnection(resolvedConnectionId);
    if (document) {
      queryContext.setConnectionForDocument(document, resolvedConnectionId);
    }

    try {
      await ensureConnected(connection);
      const result = await connectionManager.execute(connection.id, trimmedSql);
      await resultsPanel.show(connection.name, trimmedSql, result, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`DB Inspector query failed: ${message}`);
    }
  }

  async function getSandboxCompletions(sql: string, cursor: number): Promise<SandboxCompletionItem[]> {
    const contextInfo = deriveCompletionContext(sql, cursor);
    if (contextInfo.inStringLiteral || contextInfo.inComment || contextInfo.valueContext) {
      return [];
    }

    const prefix = contextInfo.prefix.toLowerCase();
    const candidates: Array<SandboxCompletionItem & { sortWeight: number; matchWeight: number }> = [];
    const seen = new Set<string>();

    const addCandidate = (
      item: SandboxCompletionItem,
      sortWeight: number,
      matchBase = item.label,
    ): void => {
      const key = `${item.label}::${item.insertText}::${item.detail ?? ''}`;
      if (seen.has(key)) {
        return;
      }

      const lower = matchBase.toLowerCase();
      if (prefix) {
        if (!lower.includes(prefix)) {
          return;
        }
      }

      const matchWeight = !prefix ? 2 : lower.startsWith(prefix) ? 0 : 1;
      seen.add(key);
      candidates.push({
        ...item,
        sortWeight,
        matchWeight,
      });
    };

    const connectionId = queryContext.getCurrentConnectionId();
    const connection = connectionId ? connectionStore.get(connectionId) : undefined;
    let connected = Boolean(connection && connectionManager.isConnected(connection.id));

    if (connection && !connected) {
      try {
        await connectionManager.connect(connection.id);
        connected = true;
      } catch {
        connected = false;
      }
    }

    const cachedCatalog = connection ? completionCatalogCache.get(connection.id)?.catalog : undefined;
    const catalog = connection
      ? connected
        ? await getOrLoadCompletionCatalog(connection)
        : cachedCatalog
      : undefined;

    const parsedTables = parseTableReferences(contextInfo.statementSql);
    const resolvedTables = catalog ? resolveTableReferences(parsedTables, catalog) : [];

    let columnSuggestions: Array<{ table: ResolvedTableReference; column: ColumnInfo }> = [];
    if (connection && resolvedTables.length > 0) {
      columnSuggestions = await getColumnsForResolvedTables(connection, resolvedTables, connected);
    }

    const qualifier = contextInfo.qualifier?.toLowerCase();
    if (qualifier) {
      for (const suggestion of columnSuggestions) {
        const alias = suggestion.table.alias?.toLowerCase();
        const tableName = suggestion.table.table.toLowerCase();
        if (alias !== qualifier && tableName !== qualifier) {
          continue;
        }

        addCandidate(
          {
            label: suggestion.column.name,
            detail: `${suggestion.table.alias ?? suggestion.table.table} column`,
            insertText: suggestion.column.name,
          },
          -1,
        );
      }
    } else {
      for (const suggestion of columnSuggestions) {
        addCandidate(
          {
            label: suggestion.column.name,
            detail: `${suggestion.table.alias ?? suggestion.table.table} column`,
            insertText: suggestion.column.name,
          },
          contextInfo.tableContext ? 2 : -1,
        );
      }
    }

    if (!catalog) {
      if (!contextInfo.qualifier) {
        for (const keyword of SQL_KEYWORDS) {
          addCandidate(
            {
              label: keyword,
              detail: 'keyword',
              insertText: `${keyword} `,
            },
            5,
          );
        }
      }

      return rankAndLimitCompletions(candidates);
    }

    for (const schema of catalog.schemas) {
      addCandidate(
        {
          label: schema,
          detail: 'schema',
          insertText: schema,
        },
        0,
      );

      addCandidate(
        {
          label: `${schema}.`,
          detail: 'schema',
          insertText: `${schema}.`,
        },
        0,
        schema,
      );
    }

    for (const object of catalog.objects) {
      if (contextInfo.qualifier && object.schema.toLowerCase() !== contextInfo.qualifier) {
        continue;
      }

      const objectPriority = contextInfo.tableContext
        ? object.kind === 'table'
          ? -2
          : object.kind === 'view'
            ? -1
            : 1
        : object.kind === 'table'
          ? 0
          : object.kind === 'view'
            ? 1
            : 2;
      addCandidate(
        {
          label: object.name,
          detail: `${object.schema} ${object.kind}`,
          insertText: object.name,
        },
        objectPriority,
      );

      if (!contextInfo.qualifier || contextInfo.tableContext) {
        addCandidate(
          {
            label: `${object.schema}.${object.name}`,
            detail: object.kind,
            insertText: `${object.schema}.${object.name}`,
          },
          objectPriority + 1,
          object.name,
        );
      }
    }

    if (!contextInfo.qualifier && !contextInfo.tableContext) {
      for (const keyword of SQL_KEYWORDS) {
        addCandidate(
          {
            label: keyword,
            detail: 'keyword',
            insertText: `${keyword} `,
          },
          4,
        );
      }
    }

    return rankAndLimitCompletions(candidates);
  }

  async function getColumnsForResolvedTables(
    connection: ConnectionProfile,
    resolvedTables: ResolvedTableReference[],
    connected: boolean,
  ): Promise<Array<{ table: ResolvedTableReference; column: ColumnInfo }>> {
    const uniqueTables = new Map<string, ResolvedTableReference>();
    for (const table of resolvedTables) {
      uniqueTables.set(`${table.schema}.${table.table}`, table);
    }

    const results: Array<{ table: ResolvedTableReference; column: ColumnInfo }> = [];
    for (const table of uniqueTables.values()) {
      const columns = await getOrLoadTableColumns(connection, table.schema, table.table, connected);
      if (!columns) {
        continue;
      }

      for (const column of columns) {
        results.push({
          table,
          column,
        });
      }
    }

    return results;
  }

  async function getOrLoadCompletionCatalog(connection: ConnectionProfile): Promise<CompletionCatalog | undefined> {
    const cacheEntry = completionCatalogCache.get(connection.id);
    const now = Date.now();
    if (cacheEntry && now - cacheEntry.loadedAt < 30_000) {
      return cacheEntry.catalog;
    }

    try {
      const schemas = await connectionManager.listSchemas(connection.id);
      const limitedSchemas = schemas.slice(0, 80);
      const schemaObjects = await Promise.all(
        limitedSchemas.map(async (schema) => ({
          schema,
          objects: await connectionManager.listSchemaObjects(connection.id, schema),
        })),
      );

      const catalog: CompletionCatalog = {
        schemas,
        objects: [],
      };

      for (const schemaEntry of schemaObjects) {
        for (const table of schemaEntry.objects.tables) {
          catalog.objects.push({
            schema: schemaEntry.schema,
            name: table,
            kind: 'table',
          });
        }

        for (const view of schemaEntry.objects.views) {
          catalog.objects.push({
            schema: schemaEntry.schema,
            name: view,
            kind: 'view',
          });
        }

        for (const fn of schemaEntry.objects.functions) {
          catalog.objects.push({
            schema: schemaEntry.schema,
            name: fn,
            kind: 'function',
          });
        }
      }

      completionCatalogCache.set(connection.id, {
        loadedAt: now,
        catalog,
      });
      return catalog;
    } catch {
      return undefined;
    }
  }

  async function getOrLoadTableColumns(
    connection: ConnectionProfile,
    schema: string,
    table: string,
    connected: boolean,
  ): Promise<ColumnInfo[] | undefined> {
    const cacheKey = `${connection.id}::${schema}::${table}`;
    const cacheEntry = completionColumnsCache.get(cacheKey);
    const now = Date.now();

    if (cacheEntry && now - cacheEntry.loadedAt < 30_000) {
      return cacheEntry.columns;
    }

    if (!connected) {
      return cacheEntry?.columns;
    }

    try {
      const columns = await connectionManager.getTableColumns(connection.id, schema, table);
      completionColumnsCache.set(cacheKey, {
        loadedAt: now,
        columns,
      });
      return columns;
    } catch {
      return cacheEntry?.columns;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('dbInspector.addConnection', async () => {
      const result = await promptForConnection();
      if (!result) {
        return;
      }

      const password = result.passwordMode.mode === 'set' ? result.passwordMode.value : undefined;
      const connection = await connectionStore.create(result.profile, password);
      queryContext.setCurrentConnection(connection.id);
      refresh();
      void vscode.window.showInformationMessage(`DB Inspector: Added connection "${connection.name}".`);
    }),

    vscode.commands.registerCommand('dbInspector.editConnection', async (node?: ConnectionNode) => {
      const connection = node?.kind === 'connection' ? connectionStore.get(node.connectionId) : await chooseConnection();
      if (!connection) {
        return;
      }

      const result = await promptForConnection(connection);
      if (!result) {
        return;
      }

      const updated = await connectionStore.update(connection.id, result.profile, result.passwordMode);
      if (!updated) {
        return;
      }

      if (connectionManager.isConnected(connection.id)) {
        await connectionManager.disconnect(connection.id);
      }

      refresh(connection.id);
      void vscode.window.showInformationMessage(`DB Inspector: Updated connection "${updated.name}".`);
    }),

    vscode.commands.registerCommand('dbInspector.deleteConnection', async (node?: ConnectionNode) => {
      const connection = node?.kind === 'connection' ? connectionStore.get(node.connectionId) : await chooseConnection();
      if (!connection) {
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Delete connection "${connection.name}"?`,
        { modal: true },
        'Delete',
      );
      if (confirmed !== 'Delete') {
        return;
      }

      await connectionManager.disconnect(connection.id);
      await connectionStore.delete(connection.id);

      if (queryContext.getCurrentConnectionId() === connection.id) {
        queryContext.setCurrentConnection(undefined);
      }

      refresh();
      void vscode.window.showInformationMessage(`DB Inspector: Deleted connection "${connection.name}".`);
    }),

    vscode.commands.registerCommand('dbInspector.connect', async (node?: ExplorerNode) => {
      const connection = await resolveConnectionFromNode(node);
      if (!connection) {
        return;
      }

      await ensureConnected(connection);
      void vscode.window.showInformationMessage(`DB Inspector: Connected to "${connection.name}".`);
    }),

    vscode.commands.registerCommand('dbInspector.disconnect', async (node?: ExplorerNode) => {
      const connection = await resolveConnectionFromNode(node);
      if (!connection) {
        return;
      }

      await connectionManager.disconnect(connection.id);
      refresh(connection.id);
      void vscode.window.showInformationMessage(`DB Inspector: Disconnected from "${connection.name}".`);
    }),

    vscode.commands.registerCommand('dbInspector.refresh', async () => {
      refresh();
    }),

    vscode.commands.registerCommand('dbInspector.toggleResultsStatus', async () => {
      resultsPanel.toggleStatus();
    }),

    vscode.commands.registerCommand('dbInspector.toggleResultsQuery', async () => {
      resultsPanel.toggleQuery();
    }),

    vscode.commands.registerCommand('dbInspector.clearResults', async () => {
      resultsPanel.clear();
    }),

    vscode.commands.registerCommand('dbInspector.copyResultsToClipboard', async () => {
      const latest = resultsPanel.getLatest();
      if (!latest) {
        void vscode.window.showWarningMessage('No query results to copy.');
        return;
      }

      try {
        const content = serializeResultAsCsv(latest.result);
        await vscode.env.clipboard.writeText(content);
        void vscode.window.showInformationMessage('DB Inspector: Copied query results to clipboard.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`DB Inspector copy failed: ${message}`);
      }
    }),

    vscode.commands.registerCommand('dbInspector.downloadResults', async () => {
      const latest = resultsPanel.getLatest();
      if (!latest) {
        void vscode.window.showWarningMessage('No query results to download.');
        return;
      }

      const hasTabularResults = latest.result.columns.length > 0;
      const extension = hasTabularResults ? 'csv' : 'txt';
      const serialized = hasTabularResults
        ? serializeResultAsCsv(latest.result)
        : latest.result.message ?? 'Statement completed.';

      const timestamp = createFileTimestamp(new Date());
      const defaultName = `db-results-${timestamp}.${extension}`;
      const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const destination = await vscode.window.showSaveDialog({
        title: 'Save DB Results',
        defaultUri: vscode.Uri.file(path.join(defaultDir, defaultName)),
        filters: hasTabularResults
          ? { 'CSV Files': ['csv'], 'All Files': ['*'] }
          : { 'Text Files': ['txt'], 'All Files': ['*'] },
      });

      if (!destination) {
        return;
      }

      try {
        await fs.writeFile(destination.fsPath, serialized, 'utf8');
        void vscode.window.showInformationMessage(`DB Inspector: Saved query results to ${path.basename(destination.fsPath)}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`DB Inspector download failed: ${message}`);
      }
    }),

    vscode.commands.registerCommand('dbInspector.useConnection', async (node?: ExplorerNode) => {
      const connection = await resolveConnectionFromNode(node);
      if (!connection) {
        return;
      }

      queryContext.setCurrentConnection(connection.id);
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        queryContext.setConnectionForDocument(editor.document, connection.id);
      }

      void vscode.window.showInformationMessage(`DB Inspector: Active connection set to "${connection.name}".`);
    }),

    vscode.commands.registerCommand('dbInspector.openQueryEditor', async () => {
      let connection: ConnectionProfile | undefined;
      const currentConnectionId = queryContext.getCurrentConnectionId();
      if (currentConnectionId) {
        connection = connectionStore.get(currentConnectionId);
      }

      if (!connection) {
        connection = await chooseConnection({ placeholder: 'Select connection for this SQL editor (optional)' });
      }

      const content = connection
        ? `-- Connection: ${connection.name}\n-- Run with DB Inspector: Run Query\n\nSELECT 1;\n`
        : `-- Run with DB Inspector: Run Query\n\nSELECT 1;\n`;

      await openQueryConsole(connection, content);
    }),

    vscode.commands.registerCommand('dbInspector.runQuery', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Open a SQL editor first.');
        return;
      }

      const sql = editor.selection.isEmpty
        ? editor.document.getText().trim()
        : editor.document.getText(editor.selection).trim();

      if (!sql) {
        void vscode.window.showWarningMessage('No SQL to run. Select SQL or add SQL to the current editor.');
        return;
      }

      await executeSql(sql, editor.document);
    }),

    vscode.commands.registerCommand('dbInspector.runQueryAtCursor', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Open a SQL editor first.');
        return;
      }

      const document = editor.document;
      if (document.languageId !== 'sql') {
        void vscode.window.showWarningMessage('Shift+Enter query execution is only available in SQL editors.');
        return;
      }

      if (!editor.selection.isEmpty) {
        const selectedSql = document.getText(editor.selection).trim();
        if (!selectedSql) {
          void vscode.window.showWarningMessage('Selected SQL is empty.');
          return;
        }

        await executeSql(selectedSql, document);
        return;
      }

      const fullText = document.getText();
      const cursorOffset = document.offsetAt(editor.selection.active);
      const statement = findStatementAtOffset(fullText, cursorOffset);

      if (!statement) {
        void vscode.window.showWarningMessage('No SQL statement found at cursor.');
        return;
      }

      const sql = fullText.slice(statement.start, statement.end).trim();
      if (!sql) {
        void vscode.window.showWarningMessage('No SQL statement found at cursor.');
        return;
      }

      await executeSql(sql, document);
    }),

    vscode.commands.registerCommand('dbInspector.runQueryRange', async (args?: QueryRangeCommandArgs) => {
      if (!args?.uri) {
        void vscode.window.showWarningMessage('DB Inspector: Missing query range context.');
        return;
      }

      const uri = vscode.Uri.parse(args.uri);
      const document =
        vscode.workspace.textDocuments.find((item) => item.uri.toString() === args.uri) ??
        (await vscode.workspace.openTextDocument(uri));

      const fullText = document.getText();
      const start = Math.max(0, Math.min(args.start, fullText.length));
      const end = Math.max(start, Math.min(args.end, fullText.length));
      const sql = fullText.slice(start, end);

      await executeSql(sql, document);
    }),

    vscode.commands.registerCommand('dbInspector.previewTableData', async (node?: ObjectNode) => {
      if (!node || node.kind !== 'object' || node.objectType !== 'table') {
        void vscode.window.showWarningMessage('Use this command from a table node in DB Inspector.');
        return;
      }

      const connection = connectionStore.get(node.connectionId);
      if (!connection) {
        return;
      }

      try {
        await ensureConnected(connection);
        const rowLimit = vscode.workspace.getConfiguration('dbInspector').get<number>('previewRowLimit', 200);
        const result = await connectionManager.previewTableData(
          connection.id,
          node.schema,
          node.objectName,
          rowLimit,
        );
        const sql = `SELECT * FROM ${node.schema}.${node.objectName} LIMIT ${rowLimit};`;
        await resultsPanel.show(connection.name, sql, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`DB Inspector preview failed: ${message}`);
      }
    }),

    vscode.commands.registerCommand('dbInspector.newQueryConsoleFromTable', async (node?: ObjectNode) => {
      if (!node || node.kind !== 'object' || node.objectType !== 'table') {
        void vscode.window.showWarningMessage('Use this command from a table node in DB Inspector.');
        return;
      }

      const connection = connectionStore.get(node.connectionId);
      if (!connection) {
        return;
      }

      const rowLimit = vscode.workspace.getConfiguration('dbInspector').get<number>('previewRowLimit', 200);
      const qualifiedTableName = buildQualifiedTableName(connection, node.schema, node.objectName);
      const content = [
        `-- Connection: ${connection.name}`,
        `-- Table: ${node.schema}.${node.objectName}`,
        '-- Run with DB Inspector: Run Query',
        '',
        `SELECT *`,
        `FROM ${qualifiedTableName}`,
        `LIMIT ${rowLimit};`,
        '',
      ].join('\n');

      await openQueryConsole(connection, content);
    }),

    vscode.commands.registerCommand('dbInspector.showObjectDDL', async (node?: ObjectNode) => {
      if (!node || node.kind !== 'object') {
        void vscode.window.showWarningMessage('Use this command from a table, view, or function node.');
        return;
      }

      const connection = connectionStore.get(node.connectionId);
      if (!connection) {
        return;
      }

      try {
        await ensureConnected(connection);
        const ddl = await connectionManager.getObjectDdl(
          connection.id,
          node.schema,
          node.objectName,
          node.objectType,
        );
        const document = await vscode.workspace.openTextDocument({
          language: 'sql',
          content: `${ddl.trim()}\n`,
        });
        await vscode.window.showTextDocument(document, {
          preview: false,
        });
        queryContext.setConnectionForDocument(document, connection.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`DB Inspector DDL failed: ${message}`);
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  if (activeConnectionManager) {
    await activeConnectionManager.disconnectAll();
    activeConnectionManager = undefined;
  }
}

function buildQualifiedTableName(connection: ConnectionProfile, schema: string, table: string): string {
  if (connection.dialect === 'mysql') {
    return `${quoteIdentifierMysql(schema)}.${quoteIdentifierMysql(table)}`;
  }

  return `${quoteIdentifierAnsi(schema)}.${quoteIdentifierAnsi(table)}`;
}

function quoteIdentifierAnsi(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteIdentifierMysql(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function serializeResultAsCsv(result: QueryExecutionResult): string {
  if (result.columns.length === 0) {
    return result.message ?? 'Statement completed.';
  }

  const header = result.columns.map((column) => escapeCsvCell(column)).join(',');
  const rows = result.rows.map((row) =>
    result.columns
      .map((column) => {
        const rawValue = (row as Record<string, unknown>)[column];
        if (rawValue === null || rawValue === undefined) {
          return '';
        }
        if (typeof rawValue === 'object') {
          return escapeCsvCell(JSON.stringify(rawValue));
        }
        return escapeCsvCell(String(rawValue));
      })
      .join(','),
  );

  return [header, ...rows].join('\n');
}

function escapeCsvCell(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function createFileTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function deriveCompletionContext(sql: string, cursor: number): CompletionContext {
  const safeCursor = Math.max(0, Math.min(cursor, sql.length));
  const statement = findStatementAtOffset(sql, safeCursor);
  const statementStart = statement?.start ?? 0;
  const statementSql = sql.slice(statementStart, safeCursor);
  const before = statementSql;
  const lexical = analyzeSqlLexicalContext(before);
  const valueContext = /(?:=|<>|!=|<=|>=|<|>|like|ilike)\s*(?:[A-Za-z0-9_-]*)$/i.test(before);
  const qualifierMatch = before.match(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/);
  if (qualifierMatch) {
    return {
      qualifier: qualifierMatch[1]?.toLowerCase(),
      prefix: qualifierMatch[2] ?? '',
      tableContext: true,
      statementSql,
      inStringLiteral: lexical.inStringLiteral,
      inComment: lexical.inComment,
      valueContext: false,
    };
  }

  const prefixMatch = before.match(/([A-Za-z0-9_]*)$/);
  const prefix = prefixMatch?.[1] ?? '';
  const tableContext = /(?:from|join|update|into|table|delete\s+from)\s+[A-Za-z0-9_]*$/i.test(before);

  return {
    prefix,
    tableContext,
    statementSql,
    inStringLiteral: lexical.inStringLiteral,
    inComment: lexical.inComment,
    valueContext: valueContext && !lexical.inStringLiteral && !tableContext,
  };
}

function analyzeSqlLexicalContext(before: string): { inStringLiteral: boolean; inComment: boolean } {
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < before.length; index += 1) {
    const current = before[index];
    const next = before[index + 1];

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick) {
      if (current === '-' && next === '-') {
        inLineComment = true;
        index += 1;
        continue;
      }

      if (current === '/' && next === '*') {
        inBlockComment = true;
        index += 1;
        continue;
      }
    }

    if (!inDouble && !inBacktick && current === "'") {
      if (inSingle && next === "'") {
        index += 1;
        continue;
      }
      inSingle = !inSingle;
      continue;
    }

    if (!inSingle && !inBacktick && current === '"') {
      if (inDouble && next === '"') {
        index += 1;
        continue;
      }
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && current === '`') {
      inBacktick = !inBacktick;
      continue;
    }
  }

  return {
    inStringLiteral: inSingle || inDouble || inBacktick,
    inComment: inLineComment || inBlockComment,
  };
}

function parseTableReferences(sql: string): ParsedTableReference[] {
  const references: ParsedTableReference[] = [];
  const regex =
    /(?:from|join|update|into)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  const reservedAliases = new Set([
    'where',
    'join',
    'left',
    'right',
    'inner',
    'full',
    'on',
    'group',
    'order',
    'limit',
    'offset',
    'having',
    'union',
  ]);

  for (const match of sql.matchAll(regex)) {
    const first = match[1];
    const second = match[2];
    const aliasRaw = match[3];
    const alias = aliasRaw && !reservedAliases.has(aliasRaw.toLowerCase()) ? aliasRaw : undefined;

    if (second) {
      references.push({
        schema: first.toLowerCase(),
        table: second.toLowerCase(),
        alias: alias?.toLowerCase(),
      });
      continue;
    }

    references.push({
      table: first.toLowerCase(),
      alias: alias?.toLowerCase(),
    });
  }

  return references;
}

function resolveTableReferences(
  parsed: ParsedTableReference[],
  catalog: CompletionCatalog,
): ResolvedTableReference[] {
  const resolved: ResolvedTableReference[] = [];

  for (const item of parsed) {
    if (item.schema) {
      if (catalog.objects.some((object) => object.schema.toLowerCase() === item.schema && object.name.toLowerCase() === item.table)) {
        resolved.push({
          schema: item.schema,
          table: item.table,
          alias: item.alias,
        });
      }
      continue;
    }

    const matchingObjects = catalog.objects.filter((object) => object.name.toLowerCase() === item.table);
    for (const object of matchingObjects) {
      resolved.push({
        schema: object.schema.toLowerCase(),
        table: object.name.toLowerCase(),
        alias: item.alias,
      });
    }
  }

  const deduped = new Map<string, ResolvedTableReference>();
  for (const item of resolved) {
    const key = `${item.schema}.${item.table}.${item.alias ?? ''}`;
    deduped.set(key, item);
  }

  return [...deduped.values()];
}

function rankAndLimitCompletions(
  items: Array<SandboxCompletionItem & { sortWeight: number; matchWeight: number }>,
): SandboxCompletionItem[] {
  return items
    .sort((a, b) => {
      if (a.matchWeight !== b.matchWeight) {
        return a.matchWeight - b.matchWeight;
      }
      if (a.sortWeight !== b.sortWeight) {
        return a.sortWeight - b.sortWeight;
      }
      return a.label.localeCompare(b.label);
    })
    .slice(0, 40)
    .map((item) => ({
      label: item.label,
      detail: item.detail,
      insertText: item.insertText,
    }));
}

async function promptForConnection(existing?: ConnectionProfile): Promise<PromptResult | undefined> {
  const dialect = await promptDialect(existing?.dialect);
  if (!dialect) {
    return undefined;
  }

  const name = await vscode.window.showInputBox({
    title: existing ? 'Edit Database Connection' : 'Create Database Connection',
    prompt: 'Connection name',
    value: existing?.name ?? '',
    validateInput: (value) => (value.trim().length === 0 ? 'Connection name is required.' : undefined),
  });
  if (name === undefined) {
    return undefined;
  }

  if (dialect === 'sqlite') {
    const sqlitePath = await promptSqlitePath(existing?.sqlitePath);
    if (!sqlitePath) {
      return undefined;
    }

    return {
      profile: {
        name: name.trim(),
        dialect,
        sqlitePath,
      },
      passwordMode: existing ? { mode: 'clear' } : { mode: 'unchanged' },
    };
  }

  const host = await vscode.window.showInputBox({
    title: `${name.trim()} (${dialect})`,
    prompt: 'Host',
    value: existing?.host ?? 'localhost',
    validateInput: (value) => (value.trim().length === 0 ? 'Host is required.' : undefined),
  });
  if (host === undefined) {
    return undefined;
  }

  const defaultPort = dialect === 'postgres' ? '5432' : '3306';
  const portInput = await vscode.window.showInputBox({
    title: `${name.trim()} (${dialect})`,
    prompt: 'Port',
    value: String(existing?.port ?? defaultPort),
    validateInput: (value) => {
      const numeric = Number(value);
      if (!Number.isInteger(numeric) || numeric <= 0) {
        return 'Port must be a positive integer.';
      }
      return undefined;
    },
  });
  if (portInput === undefined) {
    return undefined;
  }

  const database = await vscode.window.showInputBox({
    title: `${name.trim()} (${dialect})`,
    prompt: 'Database',
    value: existing?.database ?? '',
    validateInput: (value) => (value.trim().length === 0 ? 'Database is required.' : undefined),
  });
  if (database === undefined) {
    return undefined;
  }

  const user = await vscode.window.showInputBox({
    title: `${name.trim()} (${dialect})`,
    prompt: 'User',
    value: existing?.user ?? '',
    validateInput: (value) => (value.trim().length === 0 ? 'User is required.' : undefined),
  });
  if (user === undefined) {
    return undefined;
  }

  const sslPick = await vscode.window.showQuickPick(
    [
      { label: 'No SSL', value: false },
      { label: 'Use SSL', value: true },
    ],
    {
      title: `${name.trim()} (${dialect})`,
      placeHolder: 'SSL mode',
    },
  );
  if (!sslPick) {
    return undefined;
  }

  const passwordPrompt = existing
    ? 'Password (leave empty to keep current password)'
    : 'Password (optional)';
  const passwordInput = await vscode.window.showInputBox({
    title: `${name.trim()} (${dialect})`,
    prompt: passwordPrompt,
    password: true,
    ignoreFocusOut: true,
  });
  if (passwordInput === undefined) {
    return undefined;
  }

  let passwordMode: PasswordMode = { mode: 'unchanged' };
  if (existing) {
    if (passwordInput.length > 0) {
      passwordMode = { mode: 'set', value: passwordInput };
    }
  } else if (passwordInput.length > 0) {
    passwordMode = { mode: 'set', value: passwordInput };
  }

  return {
    profile: {
      name: name.trim(),
      dialect,
      host: host.trim(),
      port: Number(portInput),
      database: database.trim(),
      user: user.trim(),
      ssl: sslPick.value,
    },
    passwordMode,
  };
}

async function promptSqlitePath(existingPath?: string): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: false,
    canSelectFiles: true,
    title: 'Select SQLite file',
    openLabel: 'Use SQLite File',
    defaultUri: existingPath ? vscode.Uri.file(path.dirname(existingPath)) : undefined,
  });

  if (picked && picked[0]) {
    return picked[0].fsPath;
  }

  const manualPath = await vscode.window.showInputBox({
    title: 'SQLite file path',
    prompt: 'Absolute path to SQLite database file',
    value: existingPath ?? '',
    validateInput: (value) => (value.trim().length === 0 ? 'Path is required.' : undefined),
  });

  if (!manualPath) {
    return undefined;
  }

  return manualPath;
}

async function promptDialect(existing?: DbDialect): Promise<DbDialect | undefined> {
  const options: Array<{ label: string; dialect: DbDialect; description: string }> = [
    {
      label: 'PostgreSQL',
      dialect: 'postgres',
      description: 'Best for production relational systems',
    },
    {
      label: 'MySQL',
      dialect: 'mysql',
      description: 'Compatible with MySQL and MariaDB servers',
    },
    {
      label: 'SQLite',
      dialect: 'sqlite',
      description: 'Local file database',
    },
  ];

  const picked = await vscode.window.showQuickPick(options, {
    title: existing ? 'Edit Connection Dialect' : 'Database Dialect',
    placeHolder: 'Select your database type',
  });

  return picked?.dialect;
}
