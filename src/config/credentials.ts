import * as fs from 'fs';
import { CREDENTIALS_FILE, ensureConfigDir } from './paths.js';

export interface Credentials {
  email: string;
  password: string;
  savedAt: string;
}

export class CredentialsManager {
  save(email: string, password: string) {
    ensureConfigDir();
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
