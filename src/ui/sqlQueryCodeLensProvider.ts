import * as vscode from 'vscode';

export interface StatementRange {
  start: number;
  end: number;
}

export interface QueryRangeCommandArgs {
  uri: string;
  start: number;
  end: number;
}

export class SqlQueryCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private readonly isEnabled: () => boolean) {}

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isEnabled() || document.languageId !== 'sql') {
      return [];
    }

    const text = document.getText();
    const ranges = getStatementRanges(text).filter((range) =>
      isMeaningfulSql(text.slice(range.start, range.end)),
    );

    return ranges.map((range) => {
      const start = document.positionAt(range.start);

      return new vscode.CodeLens(new vscode.Range(start, start), {
        title: '$(play) Run Query',
        tooltip: 'Run this SQL statement with DB Inspector',
        command: 'dbInspector.runQueryRange',
        arguments: [
          {
            uri: document.uri.toString(),
            start: range.start,
            end: range.end,
          } satisfies QueryRangeCommandArgs,
        ],
      });
    });
  }
}

export function getStatementRanges(sql: string): StatementRange[] {
  const ranges: StatementRange[] = [];

  let startOffset: number | undefined;
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktickQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
      }
      index += 1;
      continue;
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktickQuote) {
      if (current === '-' && next === '-') {
        inLineComment = true;
        index += 2;
        continue;
      }

      if (current === '/' && next === '*') {
        inBlockComment = true;
        index += 2;
        continue;
      }

      if (startOffset === undefined && !/\s/.test(current)) {
        startOffset = index;
      }

      if (current === ';' && startOffset !== undefined) {
        ranges.push({
          start: startOffset,
          end: index + 1,
        });
        startOffset = undefined;
        index += 1;
        continue;
      }
    }

    if (!inDoubleQuote && !inBacktickQuote && current === "'") {
      if (inSingleQuote && next === "'") {
        index += 2;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      index += 1;
      continue;
    }

    if (!inSingleQuote && !inBacktickQuote && current === '"') {
      if (inDoubleQuote && next === '"') {
        index += 2;
        continue;
      }
      inDoubleQuote = !inDoubleQuote;
      index += 1;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && current === '`') {
      inBacktickQuote = !inBacktickQuote;
      index += 1;
      continue;
    }

    index += 1;
  }

  if (startOffset !== undefined) {
    ranges.push({
      start: startOffset,
      end: sql.length,
    });
  }

  return ranges;
}

export function isMeaningfulSql(sql: string): boolean {
  const withoutBlockComments = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const withoutLineComments = withoutBlockComments.replace(/^\s*--.*$/gm, ' ');
  return withoutLineComments.trim().length > 0;
}

export function findStatementAtOffset(sql: string, offset: number): StatementRange | undefined {
  const ranges = getStatementRanges(sql).filter((range) => isMeaningfulSql(sql.slice(range.start, range.end)));
  if (ranges.length === 0) {
    return undefined;
  }

  const normalizedOffset = Math.max(0, Math.min(offset, sql.length));

  let previous: StatementRange | undefined;
  for (const range of ranges) {
    if (normalizedOffset >= range.start && normalizedOffset <= range.end) {
      return range;
    }

    if (normalizedOffset < range.start) {
      return previous ?? range;
    }

    previous = range;
  }

  return previous;
}
