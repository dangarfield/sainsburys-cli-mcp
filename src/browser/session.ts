/**
 * Shared browser session helper with MFA-aware parking.
 * 
 * When a browser tool hits MFA during auto-login, the browser is parked
 * with a continuation callback. The MCP server returns "mfa_required" to
 * the LLM, which asks the user for the code and calls grocery_mfa_submit.
 * That tool picks up the parked browser, submits the MFA, then runs the
 * continuation so the original flow (checkout, slots, etc.) completes.
 */
import { chromium, Browser, Page } from 'playwright';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CONFIG_DIR = path.join(os.homedir(), '.sainsburys');
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');

/**
 * Debug mode: enabled by creating a file at ~/.sainsburys/DEBUG
 * Currently toggles Playwright headless mode (headless when debug is off, visible when on).
 * May control additional debug behaviour in future.
 */
function isDebugMode(): boolean {
  return fs.existsSync(path.join(CONFIG_DIR, 'DEBUG'));
}

const MFA_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ─── Parked browser state ──────────────────────────────────

export interface ParkedBrowser {
  browser: Browser;
  page: Page;
  continuation: (page: Page) => Promise<any>;
  originTool: string;
  parkedAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

let parkedBrowser: ParkedBrowser | null = null;

export function getParkedBrowser(): ParkedBrowser | null {
  if (!parkedBrowser) return null;
  // Check if timed out
  if (Date.now() - parkedBrowser.parkedAt > MFA_TIMEOUT_MS) {
    cleanupParkedBrowser();
    return null;
  }
  return parkedBrowser;
}

export function parkBrowser(entry: Omit<ParkedBrowser, 'parkedAt' | 'timeout'>): void {
  // Clean up any existing parked browser
  cleanupParkedBrowser();
  
  const timeout = setTimeout(() => {
    console.error('⏰ MFA timeout — closing parked browser');
    cleanupParkedBrowser();
  }, MFA_TIMEOUT_MS);

  parkedBrowser = {
    ...entry,
    parkedAt: Date.now(),
    timeout,
  };
}

export async function cleanupParkedBrowser(): Promise<void> {
  if (parkedBrowser) {
    clearTimeout(parkedBrowser.timeout);
    try { await parkedBrowser.browser.close(); } catch {}
    parkedBrowser = null;
  }
}


// ─── Cookie / session helpers ──────────────────────────────

export async function loadSessionCookies(page: Page): Promise<boolean> {
  if (!fs.existsSync(SESSION_FILE)) {
    return false;
  }
  try {
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    await page.context().addCookies(session.cookies);
    return true;
  } catch {
    return false;
  }
}

export async function saveSessionCookies(page: Page): Promise<void> {
  const cookies = await page.context().cookies();
  const sessionData = {
    cookies,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    lastLogin: new Date().toISOString(),
  };
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2), { mode: 0o600 });
}

export function isLoginPage(page: Page): boolean {
  const url = page.url();
  return url.includes('/login') || url.includes('/oauth') || url.includes('/auth');
}

export function isMfaPage(page: Page): boolean {
  return page.url().includes('/mfa');
}

// ─── Browser auto-login (parks on MFA) ────────────────────

export type MfaRequiredResult = { status: 'mfa_required'; tool: string };

/**
 * Attempt browser auto-login. If MFA is required, parks the browser
 * and returns { status: 'mfa_required', tool } instead of blocking.
 * 
 * Returns true if login succeeded without MFA.
 * Returns MfaRequiredResult if MFA is needed (browser is parked).
 * Returns false if no credentials available.
 */
export async function browserAutoLogin(
  page: Page,
): Promise<boolean | 'mfa_required'> {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    return false;
  }
  let creds: { email: string; password: string };
  try {
    creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
  } catch {
    return false;
  }
  if (!creds.email || !creds.password) return false;

  console.log('🔐 Session expired — auto-logging in...');

  // Accept cookies if banner present
  try {
    await page.click('#onetrust-accept-btn-handler', { timeout: 3000 });
    await page.waitForTimeout(1000);
  } catch {}

  // Wait for login form
  await page.waitForSelector('input[type="email"], input[name="email"], #username', { timeout: 10000 });

  // Fill credentials
  await page.fill('input[type="email"], input[name="email"], #username', creds.email);
  await page.waitForTimeout(300);
  await page.fill('input[type="password"], input[name="password"], #password', creds.password);
  await page.waitForTimeout(300);

  // Remove cookie overlays
  await page.evaluate(`(() => {
    document.querySelector('.onetrust-pc-dark-filter')?.remove();
    document.querySelector('#onetrust-consent-sdk')?.remove();
  })()`);
  await page.waitForTimeout(500);

  // Submit
  await page.click('button[type="submit"], button[data-testid="log-in"]');
  await page.waitForTimeout(5000);

  // Check for MFA
  if (isMfaPage(page)) {
    return 'mfa_required';
  }

  if (isLoginPage(page)) {
    throw new Error('Auto-login failed — still on login page. Credentials may be wrong.');
  }

  console.log('✅ Auto-login successful');
  await saveSessionCookies(page);
  return true;
}

// ─── MFA submission (called from grocery_mfa_submit tool) ──

export async function submitMfaCode(code: string): Promise<any> {
  const parked = getParkedBrowser();
  if (!parked) {
    throw new Error('No browser waiting for MFA. The session may have timed out.');
  }

  const { page, continuation, browser } = parked;

  console.log('🔑 Submitting MFA code...');
  await page.fill('#code, input[name="code"]', code);
  await page.waitForTimeout(500);

  // Remove cookie overlays
  await page.evaluate(`(() => {
    document.querySelector('.onetrust-pc-dark-filter')?.remove();
    document.querySelector('#onetrust-consent-sdk')?.remove();
  })()`);
  await page.waitForTimeout(500);

  await page.click('button[data-testid="submit-code"], button[type="submit"]:has-text("Continue")');
  await page.waitForTimeout(5000);

  if (isMfaPage(page) || isLoginPage(page)) {
    // Don't clean up — let user retry with correct code
    throw new Error('MFA verification failed — code may be wrong. Try again.');
  }

  console.log('✅ MFA verified');
  await saveSessionCookies(page);

  // Clear the parked reference (but don't close browser — continuation needs it)
  clearTimeout(parked.timeout);
  parkedBrowser = null;

  // Run the continuation (the rest of checkout/slots/etc.)
  try {
    const result = await continuation(page);
    return result;
  } finally {
    await browser.close();
  }
}


// ─── High-level helper for browser tools ───────────────────

/**
 * Internal: navigate to login page and auto-login.
 * Returns null on success, 'parked' if MFA required (browser parked).
 * Throws if no credentials.
 */
async function doLoginFlow<T>(
  page: Page,
  browser: Browser,
  toolName: string,
  targetUrl: string,
  continuation: (page: Page) => Promise<T>,
): Promise<null | 'parked'> {
  // Navigate to login page if not already there
  if (!isLoginPage(page)) {
    await page.goto('https://www.sainsburys.co.uk/gol-ui/oauth/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(3000);
  }

  const loginResult = await browserAutoLogin(page);

  if (loginResult === false) {
    throw new Error('No session and no saved credentials. Please login first.');
  }

  if (loginResult === 'mfa_required') {
    const wrappedContinuation = async (p: Page) => {
      console.log(`🔄 Navigating back to ${targetUrl}...`);
      await p.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForTimeout(3000);
      return continuation(p);
    };

    parkBrowser({
      browser,
      page,
      continuation: wrappedContinuation,
      originTool: toolName,
    });

    return 'parked';
  }

  return null;
}

/**
 * Launch a browser, load session, navigate to targetUrl, and auto-login if needed.
 * 
 * Auth strategy: navigate to /gol-ui/MyAccount first. If it redirects to login,
 * session is dead → auto-login. Once authenticated, click the trolley icon in the
 * header to navigate to the trolley (direct URL navigation can render a broken page).
 * 
 * If MFA is required, parks the browser with the continuation and returns { status: 'mfa_required', tool }.
 * If login succeeds (or session is valid), calls the continuation immediately and returns its result.
 * 
 * This is the main entry point for all browser-based tools.
 */
export async function withBrowserSession<T>(
  toolName: string,
  targetUrl: string,
  continuation: (page: Page) => Promise<T>,
): Promise<T | MfaRequiredResult> {
  const debug = isDebugMode();
  const browser = await chromium.launch({
    headless: !debug,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  let shouldCloseBrowser = true;

  try {
    // Load saved cookies into browser context
    await loadSessionCookies(page);

    // Auth test: navigate to MyAccount — if it redirects to login, session is dead
    console.log('🔐 Checking session via MyAccount...');
    await page.goto('https://www.sainsburys.co.uk/gol-ui/MyAccount', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Dismiss cookie banner if present
    try {
      await page.click('#onetrust-accept-btn-handler', { timeout: 3000 });
      await page.waitForTimeout(1000);
    } catch {}

    await page.waitForTimeout(3000);

    if (isLoginPage(page)) {
      // Session is dead — auto-login from the login page we landed on
      console.log('⚠️ Session expired (redirected to login) — logging in...');
      const mfaOrOk = await doLoginFlow(page, browser, toolName, targetUrl, continuation);
      if (mfaOrOk === 'parked') {
        shouldCloseBrowser = false;
        return { status: 'mfa_required' as const, tool: toolName };
      }
      // After login, go to MyAccount to get the header
      await page.goto('https://www.sainsburys.co.uk/gol-ui/MyAccount', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await page.waitForTimeout(3000);
    } else {
      // On MyAccount — check for trolley icon as proof of full auth
      const trolleyCheck = await page.$('[data-testid="header-trolley"]');
      if (!trolleyCheck) {
        console.log('⚠️ On MyAccount but trolley icon missing — session incomplete, re-logging in...');
        const mfaOrOk = await doLoginFlow(page, browser, toolName, targetUrl, continuation);
        if (mfaOrOk === 'parked') {
          shouldCloseBrowser = false;
          return { status: 'mfa_required' as const, tool: toolName };
        }
        // After login, go to MyAccount to get the header
        await page.goto('https://www.sainsburys.co.uk/gol-ui/MyAccount', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        await page.waitForTimeout(3000);
      } else {
        console.log('✅ Session valid (trolley icon present)');
      }
    }

    // Navigate to target — if it's the trolley, click the header trolley icon
    // instead of direct URL navigation (which can render a broken/empty page)
    if (targetUrl.includes('/trolley')) {
      console.log('🛒 Clicking trolley icon to navigate...');
      const trolleyBtn = await page.$('[data-testid="header-trolley"]');
      if (trolleyBtn) {
        await trolleyBtn.click();
        await page.waitForTimeout(4000);
      } else {
        // Fallback to direct navigation
        console.log('⚠️ Trolley icon still not found — navigating directly...');
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
      }
    } else {
      console.log(`🔄 Navigating to ${targetUrl}...`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
    }

    // Run the continuation
    return await continuation(page);

  } finally {
    if (shouldCloseBrowser) {
      await browser.close();
    }
  }
}
