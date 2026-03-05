import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const CONFIG_DIR = path.join(os.homedir(), '.sainsburys');
export const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');
export const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');
export const SHOPPING_LIST_FILE = path.join(CONFIG_DIR, 'shopping-list.json');
export const HABITS_FILE = path.join(CONFIG_DIR, 'habits.json');
export const ORDER_HISTORY_FILE = path.join(CONFIG_DIR, 'order-history.json');

export function isDebugMode(): boolean {
  return fs.existsSync(path.join(CONFIG_DIR, 'DEBUG'));
}

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}
