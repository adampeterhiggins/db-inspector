import * as vscode from 'vscode';
import { QueryExecutionResult } from '../types';

function escapeHtml(value: unknown): string {
  const text = String(value ?? '');
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCell(value: unknown): string {
  if (value === null) {
    return '<span class="null">NULL</span>';
  }

  if (typeof value === 'object') {
    return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  }

  return escapeHtml(value);
}

export class ResultsPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  show(connectionName: string, sql: string, result: QueryExecutionResult): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'dbInspector.results',
        'DB Inspector Results',
        vscode.ViewColumn.Beside,
        {
          enableFindWidget: true,
          retainContextWhenHidden: true,
        },
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    this.panel.title = `Results: ${connectionName}`;
    this.panel.webview.html = this.renderHtml(connectionName, sql, result);
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  private renderHtml(connectionName: string, sql: string, result: QueryExecutionResult): string {
    const rowsHtml = result.rows
      .map((row) => {
        const cells = result.columns
          .map((column) => `<td>${renderCell((row as Record<string, unknown>)[column])}</td>`)
          .join('');

        return `<tr>${cells}</tr>`;
      })
      .join('');

    const columnsHtml = result.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');

    const body = result.columns.length
      ? `
        <div class="table-container">
          <table>
            <thead>
              <tr>${columnsHtml}</tr>
            </thead>
            <tbody>
              ${rowsHtml || `<tr><td colspan="${result.columns.length}"><span class="empty">No rows returned.</span></td></tr>`}
            </tbody>
          </table>
        </div>
      `
      : `<p class="empty">${escapeHtml(result.message ?? 'Statement completed.')}</p>`;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>DB Inspector Results</title>
        <style>
          :root {
            color-scheme: light dark;
          }

          body {
            margin: 0;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
            padding: 16px;
          }

          .summary {
            display: grid;
            gap: 4px;
            margin-bottom: 12px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
          }

          .sql {
            margin: 10px 0 16px;
            background: var(--vscode-textCodeBlock-background);
            border-radius: 6px;
            padding: 10px;
            white-space: pre-wrap;
            word-break: break-word;
            border: 1px solid var(--vscode-widget-border);
          }

          .table-container {
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            overflow: auto;
            max-height: calc(100vh - 210px);
          }

          table {
            border-collapse: collapse;
            width: max-content;
            min-width: 100%;
          }

          th,
          td {
            border-bottom: 1px solid var(--vscode-editorWidget-border);
            text-align: left;
            padding: 8px 10px;
            vertical-align: top;
            max-width: 360px;
            overflow-wrap: break-word;
            white-space: pre-wrap;
          }

          th {
            position: sticky;
            top: 0;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            z-index: 2;
          }

          tr:nth-child(even) td {
            background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-list-hoverBackground));
          }

          .null {
            color: var(--vscode-symbolIcon-colorForeground);
            font-style: italic;
          }

          .empty {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
          }

          pre {
            margin: 0;
          }
        </style>
      </head>
      <body>
        <div class="summary">
          <div><strong>Connection:</strong> ${escapeHtml(connectionName)}</div>
          <div><strong>Rows:</strong> ${result.rowCount}</div>
          <div><strong>Duration:</strong> ${result.durationMs} ms</div>
          ${result.message ? `<div><strong>Message:</strong> ${escapeHtml(result.message)}</div>` : ''}
        </div>
        <div class="sql">${escapeHtml(sql.trim())}</div>
        ${body}
      </body>
      </html>
    `;
  }
}
