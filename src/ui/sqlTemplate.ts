import * as vscode from 'vscode';

const nunjucks: {
  Environment: new (
    loaders?: unknown,
    opts?: {
      autoescape?: boolean;
      throwOnUndefined?: boolean;
      trimBlocks?: boolean;
      lstripBlocks?: boolean;
    },
  ) => {
    renderString: (template: string, context: Record<string, unknown>) => string;
  };
} = require('nunjucks');

interface TemplateVariable {
  name: string;
  isList: boolean;
}

const RESERVED_IDENTIFIERS = new Set([
  'true',
  'false',
  'none',
  'null',
  'and',
  'or',
  'not',
  'in',
  'if',
  'else',
  'elif',
  'for',
  'endfor',
  'endif',
  'loop',
]);

function containsTemplateSyntax(sql: string): boolean {
  return sql.includes('{{') || sql.includes('{%');
}

function stripQuotedText(expression: string): string {
  return expression.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' ');
}

function previousNonWhitespace(source: string, index: number): string | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const char = source[i];
    if (!/\s/.test(char)) {
      return char;
    }
  }
  return undefined;
}

function collectExpressionIdentifiers(
  expression: string,
  locals: Set<string>,
): Array<{ name: string; index: number }> {
  const cleaned = stripQuotedText(expression);
  const matches = cleaned.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g);
  const identifiers: Array<{ name: string; index: number }> = [];

  for (const match of matches) {
    const name = match[0];
    const index = match.index ?? 0;
    const before = previousNonWhitespace(cleaned, index);

    if (before === '|' || before === '.') {
      continue;
    }
    if (RESERVED_IDENTIFIERS.has(name) || locals.has(name)) {
      continue;
    }

    identifiers.push({ name, index });
  }

  return identifiers;
}

function extractTemplateVariables(template: string): TemplateVariable[] {
  const variables = new Map<string, TemplateVariable>();
  const scopeStack: Array<Set<string>> = [new Set()];
  const tokenRegex = /({{[\s\S]*?}}|{%[\s\S]*?%})/g;

  const currentLocals = (): Set<string> => {
    const merged = new Set<string>();
    for (const scope of scopeStack) {
      for (const local of scope) {
        merged.add(local);
      }
    }
    return merged;
  };

  const addVariable = (name: string, isList: boolean): void => {
    if (RESERVED_IDENTIFIERS.has(name)) {
      return;
    }

    const existing = variables.get(name);
    if (!existing) {
      variables.set(name, { name, isList });
      return;
    }

    if (isList && !existing.isList) {
      existing.isList = true;
    }
  };

  const collectFromExpression = (expression: string, isList = false): void => {
    const locals = currentLocals();
    const identifiers = collectExpressionIdentifiers(expression, locals);
    for (const identifier of identifiers) {
      addVariable(identifier.name, isList);
    }
  };

  for (const match of template.matchAll(tokenRegex)) {
    const token = match[0];

    if (token.startsWith('{{')) {
      const expression = token.slice(2, -2);
      collectFromExpression(expression);
      continue;
    }

    const tag = token.slice(2, -2).trim();

    const forMatch = tag.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]+)$/);
    if (forMatch) {
      const loopVariable = forMatch[1];
      const iterableExpression = forMatch[2];
      collectFromExpression(iterableExpression, true);
      scopeStack.push(new Set([loopVariable]));
      continue;
    }

    if (/^endfor\b/.test(tag)) {
      if (scopeStack.length > 1) {
        scopeStack.pop();
      }
      continue;
    }

    const ifMatch = tag.match(/^(if|elif)\s+([\s\S]+)$/);
    if (ifMatch) {
      const condition = ifMatch[2];
      collectFromExpression(condition);

      for (const lengthMatch of condition.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\|\s*length\b/g)) {
        addVariable(lengthMatch[1], true);
      }

      for (const inMatch of condition.matchAll(/\bin\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
        addVariable(inMatch[1], true);
      }
      continue;
    }

    const setMatch = tag.match(/^set\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/);
    if (setMatch) {
      collectFromExpression(setMatch[2]);
      scopeStack[scopeStack.length - 1].add(setMatch[1]);
    }
  }

  return Array.from(variables.values());
}

function parseListValue(input: string): unknown[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('Input must be a JSON array.');
    }
    return parsed;
  }

  return trimmed
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

async function promptForTemplateValue(variable: TemplateVariable): Promise<unknown | undefined> {
  if (!variable.isList) {
    return vscode.window.showInputBox({
      title: `Template Variable: ${variable.name}`,
      prompt: `Value for "${variable.name}"`,
      ignoreFocusOut: true,
    });
  }

  while (true) {
    const input = await vscode.window.showInputBox({
      title: `Template Variable: ${variable.name}`,
      prompt: `Values for "${variable.name}" (comma-separated or JSON array)`,
      placeHolder: 'value1, value2',
      ignoreFocusOut: true,
    });

    if (input === undefined) {
      return undefined;
    }

    try {
      return parseListValue(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Template value error for "${variable.name}": ${message}`);
    }
  }
}

export async function renderSqlTemplateIfNeeded(sql: string): Promise<string | undefined> {
  if (!containsTemplateSyntax(sql)) {
    return sql;
  }

  const variables = extractTemplateVariables(sql);
  const context: Record<string, unknown> = {};

  for (const variable of variables) {
    const value = await promptForTemplateValue(variable);
    if (value === undefined) {
      return undefined;
    }

    context[variable.name] = value;
  }

  try {
    const environment = new nunjucks.Environment(undefined, {
      autoescape: false,
      throwOnUndefined: true,
      trimBlocks: true,
      lstripBlocks: true,
    });
    return environment.renderString(sql, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Template render failed: ${message}`);
    return undefined;
  }
}
