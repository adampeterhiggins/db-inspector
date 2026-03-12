import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ConnectionProfile } from '../types';

const CONNECTIONS_KEY = 'dbInspector.connections';
const PASSWORD_KEY_PREFIX = 'dbInspector.password.';

export type PasswordMode =
  | { mode: 'unchanged' }
  | { mode: 'clear' }
  | { mode: 'set'; value: string };

export class ConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionProfile[] {
    const items = this.context.globalState.get<ConnectionProfile[]>(CONNECTIONS_KEY, []);
    return [...items].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(connectionId: string): ConnectionProfile | undefined {
    return this.list().find((profile) => profile.id === connectionId);
  }

  async create(
    input: Omit<ConnectionProfile, 'id' | 'hasPassword'>,
    password?: string,
  ): Promise<ConnectionProfile> {
    const profile: ConnectionProfile = {
      ...input,
      id: randomUUID(),
      hasPassword: Boolean(password),
    };

    const items = this.list();
    items.push(profile);
    await this.context.globalState.update(CONNECTIONS_KEY, items);

    if (password) {
      await this.setPassword(profile.id, password);
    }

    return profile;
  }

  async update(
    connectionId: string,
    updates: Omit<ConnectionProfile, 'id' | 'hasPassword'>,
    password: PasswordMode = { mode: 'unchanged' },
  ): Promise<ConnectionProfile | undefined> {
    const items = this.list();
    const index = items.findIndex((item) => item.id === connectionId);
    if (index < 0) {
      return undefined;
    }

    const current = items[index];
    const next: ConnectionProfile = {
      ...current,
      ...updates,
    };

    if (password.mode === 'set') {
      next.hasPassword = Boolean(password.value);
      if (password.value) {
        await this.setPassword(connectionId, password.value);
      } else {
        await this.deletePassword(connectionId);
      }
    } else if (password.mode === 'clear') {
      next.hasPassword = false;
      await this.deletePassword(connectionId);
    }

    items[index] = next;
    await this.context.globalState.update(CONNECTIONS_KEY, items);
    return next;
  }

  async delete(connectionId: string): Promise<void> {
    const items = this.list().filter((item) => item.id !== connectionId);
    await this.context.globalState.update(CONNECTIONS_KEY, items);
    await this.deletePassword(connectionId);
  }

  async getPassword(connectionId: string): Promise<string | undefined> {
    return this.context.secrets.get(this.keyFor(connectionId));
  }

  async setPassword(connectionId: string, password: string): Promise<void> {
    await this.context.secrets.store(this.keyFor(connectionId), password);

    const profile = this.get(connectionId);
    if (!profile || profile.hasPassword) {
      return;
    }

    await this.context.globalState.update(
      CONNECTIONS_KEY,
      this.list().map((item) =>
        item.id === connectionId
          ? {
              ...item,
              hasPassword: true,
            }
          : item,
      ),
    );
  }

  async deletePassword(connectionId: string): Promise<void> {
    await this.context.secrets.delete(this.keyFor(connectionId));
  }

  private keyFor(connectionId: string): string {
    return `${PASSWORD_KEY_PREFIX}${connectionId}`;
  }
}
