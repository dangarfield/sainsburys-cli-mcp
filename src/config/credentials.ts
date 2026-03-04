import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.sainsburys');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');

export interface Credentials {
  email: string;
  password: string;
  savedAt: string;
}

export class CredentialsManager {
  private ensureConfigDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
  }

  save(email: string, password: string) {
    this.ensureConfigDir();
    const credentials: Credentials = {
      email,
      password,
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    console.log(`💾 Credentials saved to ${CREDENTIALS_FILE}`);
  }

  load(): Credentials | null {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      return null;
    }

    try {
      const data = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      console.error('⚠️  Failed to load credentials:', error);
      return null;
    }
  }

  exists(): boolean {
    return fs.existsSync(CREDENTIALS_FILE);
  }

  clear() {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      fs.unlinkSync(CREDENTIALS_FILE);
      console.log('🗑️  Credentials cleared');
    }
  }

  // Get credentials from saved file only
  get(): { email: string; password: string } | null {
    const stored = this.load();
    if (stored) {
      return { email: stored.email, password: stored.password };
    }
    return null;
  }
}
