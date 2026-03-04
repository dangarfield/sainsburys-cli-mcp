/**
 * Delivery slot browser automation.
 *
 * Direct API calls to /slot/v1/slots return "Access Denied", so we use Playwright.
 * Flow: navigate to trolley → click through to slot picker → parse slot buttons from DOM.
 * Slot buttons use class `button.book-slot-grid__slot` with aria-labels like:
 *   "Saturday 7th March between 6 30 AM and 7 30 AM for £4"
 * Slot IDs are derived as: "Saturday 7th March|6:30 AM"
 */
import { Page } from 'playwright';
import { withBrowserSession, MfaRequiredResult } from './session.js';

export interface Slot {
  slot_id: string;
  date: string;
  day: string;
  start_time: string;
  end_time: string;
  price: number;
  available: boolean;
}

export type SlotsResult = Slot[] | MfaRequiredResult;
export type BookSlotResult = void | MfaRequiredResult;
export type ChangeSlotResult = Slot[] | MfaRequiredResult;

const TROLLEY_URL = 'https://www.sainsburys.co.uk/gol-ui/trolley';

/**
 * List available delivery slots.
 * Goes to trolley → clicks through to slot picker.
 */
export async function getSlots(): Promise<SlotsResult> {
  return withBrowserSession<Slot[]>(
    'grocery_slots',
    TROLLEY_URL,
    async (page: Page) => {
      await navigateToSlotPicker(page);
      return doGetSlots(page);
    },
  );
}

/**
 * Book a delivery slot.
 * Goes to trolley → clicks through to slot picker → selects slot.
 */
export async function bookSlot(slotId: string): Promise<BookSlotResult> {
  return withBrowserSession<void>(
    'grocery_slots',
    TROLLEY_URL,
    async (page: Page) => {
      await navigateToSlotPicker(page);
      await doBookSlot(page, slotId);
    },
  );
}

/**
 * Change an existing reserved slot.
 * Goes to trolley → clicks "Change slot time" → shows/books slots.
 */
export async function changeSlot(newSlotId?: string): Promise<ChangeSlotResult> {
  return withBrowserSession<Slot[]>(
    'grocery_slots',
    TROLLEY_URL,
    async (page: Page) => doChangeSlot(page, newSlotId),
  );
}


// ─── Navigation helpers ────────────────────────────────────

/**
 * From the trolley page, navigate to the slot picker.
 * Looks for a "Book delivery slot" or similar CTA and clicks it.
 * If already on the slot page (e.g. redirected), does nothing.
 */
async function navigateToSlotPicker(page: Page): Promise<void> {
  await page.waitForTimeout(2000);

  // If we're already on the slot page, nothing to do
  if (page.url().includes('/slot')) return;

  // Look for the slot booking link/button in the MAIN CONTENT area only
  // (avoid matching header/nav links which can cause circular navigation)
  const slotLink = await page.$(
    [
      'main a[href*="/slot/book"]',
      '#content a[href*="/slot/book"]',
      '.trolley a[href*="/slot/book"]',
      'main button:has-text("Book delivery")',
      'main a:has-text("Book delivery")',
      'main a:has-text("Choose a slot")',
      '#content button:has-text("Book delivery")',
      '#content a:has-text("Book delivery")',
      '#content a:has-text("Choose a slot")',
    ].join(', ')
  );

  if (slotLink) {
    console.log('🔗 Found slot booking link in main content, clicking...');
    await slotLink.click();
    await page.waitForTimeout(3000);
    return;
  }

  // Fallback: navigate directly to slot/book (works for order amend)
  console.log('⚠️ No slot link found in main content — navigating directly to /slot/book');
  await page.goto('https://www.sainsburys.co.uk/gol-ui/slot/book', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(3000);
}

// ─── Slot scraping ─────────────────────────────────────────

async function doGetSlots(page: Page): Promise<Slot[]> {
  await page.waitForSelector('[data-testid="slot-table"]', { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(2000);

  const slots: Slot[] = [];

  // Each available slot button has an aria-label like:
  // "Saturday 7th March between 6 30 AM and 7 30 AM for £4"
  const slotButtons = await page.$$('button.book-slot-grid__slot:not([disabled])');

  for (const btn of slotButtons) {
    try {
      const ariaLabel = await btn.getAttribute('aria-label');
      if (!ariaLabel || ariaLabel === 'This slot is fully booked') continue;

      const match = ariaLabel.match(
        /^(.+?)\s+between\s+(\d{1,2}\s+\d{2}\s+[AP]M)\s+and\s+(\d{1,2}\s+\d{2}\s+[AP]M)\s+for\s+£([\d.]+)$/i
      );
      if (!match) continue;

      const [, dateStr, startRaw, endRaw, priceStr] = match;
      const formatTime = (raw: string) => raw.replace(/^(\d{1,2})\s+(\d{2})\s+([AP]M)$/i, '$1:$2 $3');
      const slotId = `${dateStr.trim()}|${formatTime(startRaw)}`;

      slots.push({
        slot_id: slotId,
        date: dateStr.trim(),
        day: dateStr.split(' ')[0],
        start_time: formatTime(startRaw),
        end_time: formatTime(endRaw),
        price: parseFloat(priceStr),
        available: true,
      });
    } catch {
      // Skip element
    }
  }

  if (slots.length === 0) {
    const pageText = await page.textContent('body');
    if (pageText?.includes('£25') || pageText?.includes('minimum')) {
      throw new Error('Basket does not meet £25 minimum spend. Add more items first.');
    }

    await page.screenshot({ path: '/tmp/slots-debug.png', fullPage: true });
    throw new Error('No slots found on page. Check /tmp/slots-debug.png for details.');
  }

  return slots;
}

// ─── Slot booking ──────────────────────────────────────────

async function doBookSlot(page: Page, slotId: string): Promise<void> {
  await page.waitForSelector('[data-testid="slot-table"]', { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(2000);

  const parts = slotId.split('|');
  if (parts.length !== 2) {
    throw new Error(`Invalid slot_id format "${slotId}". Expected "Day Date|StartTime" e.g. "Saturday 7th March|6:30 AM"`);
  }

  const [datePart, timePart] = parts;
  const ariaTime = timePart.trim().replace(':', ' ');
  const ariaSubstring = `${datePart.trim()} between ${ariaTime}`;

  const allButtons = await page.$$('button.book-slot-grid__slot:not([disabled])');
  let slotElement = null;

  for (const btn of allButtons) {
    const label = await btn.getAttribute('aria-label');
    if (label && label.startsWith(ariaSubstring)) {
      slotElement = btn;
      break;
    }
  }

  if (!slotElement) {
    throw new Error(`Slot "${slotId}" not found on page. It may be fully booked or on a different week.`);
  }

  await slotElement.click();

  // Wait for the reserve/confirm modal
  await page.waitForSelector(
    '.reserve-slot-modal, [data-testid="basic-modal-primary-button"]',
    { timeout: 5000 },
  ).catch(() => null);
  await page.waitForTimeout(1000);

  const reserveButton = await page.$('[data-testid="basic-modal-primary-button"]');
  if (!reserveButton) {
    throw new Error('Reserve slot confirmation modal did not appear.');
  }

  // Read the button text before clicking to know what we're confirming
  const buttonText = (await reserveButton.textContent())?.trim().toLowerCase() || '';
  await reserveButton.click();
  await page.waitForTimeout(3000);

  // Verify the reservation succeeded by checking the page state after click
  await verifySlotReservation(page, slotId, buttonText);
}

/**
 * After clicking the reserve/confirm button, verify it actually worked.
 * Checks for error banners, still-open modals, and confirms we're no longer
 * on the slot picker (or that a success indicator is present).
 */
async function verifySlotReservation(page: Page, slotId: string, buttonText: string): Promise<void> {
  // Check for error messages on the page
  const errorBanner = await page.$('.error-message, [data-testid="error-banner"], .alert--error, .notification--error');
  if (errorBanner) {
    const errorText = (await errorBanner.textContent())?.trim() || 'Unknown error';
    await page.screenshot({ path: '/tmp/slot-reserve-error.png', fullPage: true });
    throw new Error(`Slot reservation failed: ${errorText}`);
  }

  // Check if the modal is still open (means it didn't process)
  const modalStillOpen = await page.$('.reserve-slot-modal');
  if (modalStillOpen) {
    const modalText = (await modalStillOpen.textContent())?.trim() || '';
    if (modalText.toLowerCase().includes('error') || modalText.toLowerCase().includes('sorry') || modalText.toLowerCase().includes('unable')) {
      await page.screenshot({ path: '/tmp/slot-reserve-error.png', fullPage: true });
      throw new Error(`Slot reservation failed. Modal says: ${modalText.slice(0, 200)}`);
    }
  }

  // Check for success indicators
  const pageText = (await page.textContent('body'))?.toLowerCase() || '';
  const hasSuccess = pageText.includes('slot reserved') ||
    pageText.includes('reservation confirmed') ||
    pageText.includes('delivery slot') ||
    page.url().includes('/trolley');

  if (!hasSuccess) {
    // Take a screenshot for debugging but don't necessarily fail —
    // the page may have navigated away from slots which is a good sign
    const stillOnSlotPage = page.url().includes('/slot');
    if (stillOnSlotPage) {
      await page.screenshot({ path: '/tmp/slot-reserve-unclear.png', fullPage: true });
      throw new Error(`Slot reservation status unclear for "${slotId}". Check /tmp/slot-reserve-unclear.png`);
    }
  }

  console.log(`✅ Slot "${slotId}" reserved (button was: "${buttonText}")`);
}

// ─── Slot change ───────────────────────────────────────────

async function doChangeSlot(page: Page, newSlotId?: string): Promise<Slot[]> {
  // We're on the trolley page — find and click "Change slot time"
  await page.waitForTimeout(2000);

  const changeLink = await page.$(
    '.slot-details a[aria-label="Change slot time"], a:has-text("Change slot"), a:has-text("Change slot time")'
  );
  if (!changeLink) {
    await page.screenshot({ path: '/tmp/change-slot-debug.png', fullPage: true });
    throw new Error('No "Change slot time" link found on trolley page. You may not have a slot reserved. Check /tmp/change-slot-debug.png');
  }

  await changeLink.click();
  await page.waitForTimeout(3000);

  // If a new slot ID was provided, book it directly
  if (newSlotId) {
    await doBookSlot(page, newSlotId);
    // After booking, try to re-scrape to confirm — but don't fail if page moved on
    return doGetSlots(page).catch(() => []);
  }

  // Otherwise just return available slots for the user to pick from
  return doGetSlots(page);
}
