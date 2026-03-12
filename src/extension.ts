import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionManager } from './db/connectionManager';
import { ConnectionStore, PasswordMode } from './store/connectionStore';
import {
  ConnectionProfile,
  ConnectionNode,
  DbDialect,
  ExplorerNode,
  ObjectNode,
} from './types';
import { DatabaseExplorerProvider } from './ui/databaseExplorerProvider';
import { QueryContextManager } from './ui/queryContext';
import { ResultsPanel } from './ui/resultsPanel';
import { QueryRangeCommandArgs, SqlQueryCodeLensProvider } from './ui/sqlQueryCodeLensProvider';

interface PromptResult {
  profile: Omit<ConnectionProfile, 'id' | 'hasPassword'>;
  passwordMode: PasswordMode;
}

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
  const resultsPanel = new ResultsPanel();

  const treeView = vscode.window.createTreeView('dbInspector.connectionsView', {
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

  context.subscriptions.push(treeView, queryContext, codeLensRegistration, resultsViewRegistration);

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

  async function executeSqlForDocument(document: vscode.TextDocument, sql: string): Promise<void> {
    const trimmedSql = sql.trim();
    if (!trimmedSql) {
      void vscode.window.showWarningMessage('No SQL to run.');
      return;
    }

    let connectionId = queryContext.getConnectionForDocument(document);
    let connection = connectionId ? connectionStore.get(connectionId) : undefined;
    if (!connection) {
      connection = await chooseConnection({ placeholder: 'Select connection to run SQL against' });
      if (!connection) {
        return;
      }

      connectionId = connection.id;
      queryContext.setConnectionForDocument(document, connectionId);
      queryContext.setCurrentConnection(connectionId);
    }

    try {
      await ensureConnected(connection);
      const result = await connectionManager.execute(connection.id, trimmedSql);
      await resultsPanel.show(connection.name, trimmedSql, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`DB Inspector query failed: ${message}`);
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

      await executeSqlForDocument(editor.document, sql);
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

      await executeSqlForDocument(document, sql);
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
