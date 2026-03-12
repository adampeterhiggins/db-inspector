import * as vscode from 'vscode';
import { ConnectionProfile } from '../types';

export class QueryContextManager {
  private readonly docToConnection = new Map<string, string>();
  private currentConnectionId: string | undefined;
  private readonly statusBar: vscode.StatusBarItem;

  constructor(
    private readonly listConnections: () => ConnectionProfile[],
    private readonly context: vscode.ExtensionContext,
  ) {
    this.currentConnectionId = context.workspaceState.get<string>('dbInspector.currentConnectionId');
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this.statusBar.command = 'dbInspector.useConnection';
    this.statusBar.show();
    this.refreshStatusBar(vscode.window.activeTextEditor?.document);
  }

  dispose(): void {
    this.statusBar.dispose();
  }

  onActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
    this.refreshStatusBar(editor?.document);
  }

  setCurrentConnection(connectionId: string | undefined): void {
    this.currentConnectionId = connectionId;
    void this.context.workspaceState.update('dbInspector.currentConnectionId', connectionId);
    this.refreshStatusBar(vscode.window.activeTextEditor?.document);
  }

  getCurrentConnectionId(): string | undefined {
    return this.currentConnectionId;
  }

  setConnectionForDocument(document: vscode.TextDocument, connectionId: string): void {
    this.docToConnection.set(document.uri.toString(), connectionId);
    this.refreshStatusBar(document);
  }

  getConnectionForDocument(document: vscode.TextDocument): string | undefined {
    return this.docToConnection.get(document.uri.toString()) ?? this.currentConnectionId;
  }

  removeConnectionForDocument(document: vscode.TextDocument): void {
    this.docToConnection.delete(document.uri.toString());
  }

  private refreshStatusBar(document: vscode.TextDocument | undefined): void {
    const connectionId = document ? this.getConnectionForDocument(document) : this.currentConnectionId;
    const connection = connectionId
      ? this.listConnections().find((profile) => profile.id === connectionId)
      : undefined;

    if (!connection) {
      this.statusBar.text = '$(database) DB: None';
      this.statusBar.tooltip = 'DB Inspector: Select active connection';
      return;
    }

    this.statusBar.text = `$(database) DB: ${connection.name}`;
    this.statusBar.tooltip = `DB Inspector active connection (${connection.dialect})`;
  }
}
