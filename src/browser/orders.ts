/**
 * Order details fetcher using the Sainsbury's JSON API.
 * 
 * Replaces the previous Playwright HTML scraper with:
 * GET /order/v1/order/{uid}?placed=true&deliveryPass=false
 * 
 * Caches order details to ~/.sainsburys/order-{uid}.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_DIR, ensureConfigDir } from '../config/paths.js';

export interface OrderItem {
  name: string;
  quantity: number;
  price: number;
  image_url?: string;
  product_id?: string;
}

export interface ScrapedOrder {
  order_uid: string;
  items: OrderItem[];
  scrapedAt: string;
}

function getOrderFilePath(orderUid: string): string {
  return path.join(CONFIG_DIR, `order-${orderUid}.json`);
}

export function orderAlreadyScraped(orderUid: string): boolean {
  return fs.existsSync(getOrderFilePath(orderUid));
}

export function loadScrapedOrder(orderUid: string): ScrapedOrder | null {
  const filePath = getOrderFilePath(orderUid);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveScrapedOrder(order: ScrapedOrder): void {
  ensureConfigDir();
  fs.writeFileSync(
    getOrderFilePath(order.order_uid),
    JSON.stringify(order, null, 2),
    { mode: 0o600 }
  );
}

/**
 * Parse the JSON API response for a single order into our ScrapedOrder format.
 * The API returns order_items[] with product details.
 */
export function parseOrderDetailsResponse(orderUid: string, data: any): ScrapedOrder {
  const orderItems = data.order_items || [];
  
  const items: OrderItem[] = orderItems.map((item: any) => ({
    name: item.product?.name || 'Unknown',
    quantity: item.quantity || 1,
    price: item.sub_total || 0,
    image_url: item.product?.image_url,
    product_id: item.product?.product_uid,
  }));

  return {
    order_uid: orderUid,
    items,
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Fetch order details via the JSON API and cache them.
 * Uses the provider's getOrderDetails method.
 */
export async function fetchOrderDetails(
  orderUid: string,
  getDetailsFn: (uid: string) => Promise<any>
): Promise<ScrapedOrder> {
  console.log(`   📄 Fetching order ${orderUid} via API...`);
  const data = await getDetailsFn(orderUid);
  const order = parseOrderDetailsResponse(orderUid, data);
  saveScrapedOrder(order);
  console.log(`   ✅ Order ${orderUid}: ${order.items.length} items`);
  return order;
}

/**
 * Fetch multiple orders via API, skipping ones already cached.
 */
export async function fetchOrders(
  orderUids: string[],
  getDetailsFn: (uid: string) => Promise<any>
): Promise<ScrapedOrder[]> {
  const results: ScrapedOrder[] = [];

  for (const uid of orderUids) {
    if (orderAlreadyScraped(uid)) {
      console.log(`   ⏭️  Order ${uid} already cached, skipping`);
      const cached = loadScrapedOrder(uid);
      if (cached) results.push(cached);
      continue;
    }

    try {
      const order = await fetchOrderDetails(uid, getDetailsFn);
      results.push(order);
    } catch (error: any) {
      console.error(`   ❌ Failed to fetch order ${uid}: ${error.message}`);
    }
  }

  return results;
}

/**
 * Clean up old order files, keeping only the specified order UIDs.
 */
export function pruneOldOrders(keepUids: string[]): void {
  if (!fs.existsSync(CONFIG_DIR)) return;

  const files = fs.readdirSync(CONFIG_DIR);
  for (const file of files) {
    if (!file.startsWith('order-') || !file.endsWith('.json')) continue;
    const uid = file.replace('order-', '').replace('.json', '');
    if (!keepUids.includes(uid)) {
      fs.unlinkSync(path.join(CONFIG_DIR, file));
      console.log(`   🗑️  Pruned old order ${uid}`);
    }
  }
}

// Keep backward-compatible exports
export { fetchOrders as scrapeOrders };
