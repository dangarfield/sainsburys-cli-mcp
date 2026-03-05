/**
 * Shared command handlers used by both CLI and MCP server.
 * All business logic AND response formatting lives here.
 * CLI and MCP are thin wrappers that just print/return the .text field.
 */

import { ProviderFactory } from '../providers/index.js';
import { SainsburysProvider } from '../providers/sainsburys.js';
import { ShoppingListManager } from '../shopping-list/manager.js';
import { CredentialsManager } from '../config/credentials.js';
import { checkout as browserCheckout } from '../browser/checkout.js';
import { submitMfaCode } from '../browser/session.js';
import { CONFIG_DIR, SESSION_FILE } from '../config/paths.js';
import * as fs from 'fs';

const listManager = new ShoppingListManager();
const credentialsManager = new CredentialsManager();

function getProvider(): SainsburysProvider {
  return ProviderFactory.create('sainsburys') as SainsburysProvider;
}

export function isLoggedIn(): boolean {
  return fs.existsSync(SESSION_FILE);
}

/** Every handler returns at least { text: string } for display. */
export interface HandlerResult {
  text: string;
  [key: string]: any;
}

// ─── Login (includes MFA submission) ───────────────────────

export interface LoginArgs {
  email?: string;
  password?: string;
  logout?: boolean;
  code?: string; // 6-digit MFA code to resume a parked browser session
}

export async function handleLogin(args: LoginArgs): Promise<HandlerResult & { success: boolean }> {
  // MFA code submission
  if (args.code) {
    if (args.code.length !== 6) {
      return { success: false, text: '❌ MFA code must be 6 digits.' };
    }
    const result = await submitMfaCode(args.code);

    // Format based on what the continuation returned
    if (result && typeof result === 'object') {
      if ('status' in result && 'total' in result) {
        if (result.status === 'preview') return { success: true, text: `✅ MFA verified. Checkout Preview\n   Basket total: £${result.total}` };
        if (result.status === 'payment_required') return { success: true, text: `✅ MFA verified. Payment Required\n   Total: £${result.total}` };
        if (result.status === 'completed') return { success: true, text: `✅ MFA verified. Order Completed!\n   Order ID: ${result.order_id}\n   Total: £${result.total}` };
      }
      if (Array.isArray(result)) {
        if (result.length === 0) return { success: true, text: '✅ MFA verified. 📅 No delivery slots available.' };
        const formatted = result.map((slot: any, i: number) =>
          `${i + 1}. ${slot.date} ${slot.start_time}-${slot.end_time}\n   £${slot.price?.toFixed(2)} | ID: ${slot.slot_id}`
        ).join('\n\n');
        return { success: true, text: `✅ MFA verified.\n\n📅 Available Delivery Slots:\n\n${formatted}` };
      }
    }
    return { success: true, text: '✅ MFA verified. Operation completed successfully.' };
  }

  // Logout — wipe all local data (session, credentials, lists, habits, order cache)
  if (args.logout) {
    const configDir = CONFIG_DIR;
    if (fs.existsSync(configDir)) {
      const files = fs.readdirSync(configDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          fs.unlinkSync(`${configDir}/${file}`);
        }
      }
    }
    return { success: true, text: '✅ Logged out. All local data cleared (session, credentials, shopping list, habits, order cache).' };
  }

  // Login
  const creds = credentialsManager.get();
  const email = args.email || creds?.email;
  const password = args.password || creds?.password;

  if (!email || !password) {
    return { success: false, text: '❌ Email and password required. Use --email and --password, or save credentials.' };
  }

  const provider = getProvider();
  const result = await provider.login(email, password) as any;

  if (args.email && args.password) {
    credentialsManager.save(email, password);
  }

  const profileName = result?.givenName ? `${result.givenName} ${result.familyName}` : '';
  return { success: true, text: `✅ Logged in to ${provider.name}${profileName ? ` as ${profileName}` : ''}` };
}


// ─── Search ────────────────────────────────────────────────

export interface SearchArgs {
  query: string;
  limit?: number;
}

export async function handleSearch(args: SearchArgs): Promise<HandlerResult & { products: any[] }> {
  const limit = args.limit || 12;
  const provider = getProvider();
  const products = await provider.search(args.query, { limit });
  const limited = products.slice(0, limit);

  const mapped = limited.map(p => ({
    name: p.name,
    price: p.retail_price.price,
    unit_price: p.unit_price ? `£${p.unit_price.price}/${p.unit_price.measure}` : undefined,
    product_uid: p.product_uid,
    in_stock: p.in_stock,
    rating: p.reviews ? `${p.reviews.average_rating.toFixed(1)}/5 (${p.reviews.total})` : undefined,
  }));

  const lines = mapped.map((p, i) => {
    const parts = [`£${p.price.toFixed(2)}`];
    if (p.unit_price) parts.push(p.unit_price);
    if (p.rating) parts.push(`⭐ ${p.rating}`);
    parts.push(`ID: ${p.product_uid}`);
    const oos = p.in_stock ? '' : ' · ❌ OUT OF STOCK';
    return `${i + 1}. ${p.name}\n   ${parts.join(' · ')}${oos}`;
  });

  return {
    products: mapped,
    text: `🔍 Found ${products.length} products (showing ${mapped.length}):\n\n${lines.join('\n\n')}`,
  };
}

// ─── Basket ────────────────────────────────────────────────

export interface BasketArgs {
  action?: 'view' | 'add' | 'remove' | 'clear';
  product_id?: string;
  quantity?: number;
}

export async function handleBasket(args: BasketArgs): Promise<HandlerResult & { data?: any }> {
  const provider = getProvider();
  const action = args.action || 'view';

  if (action === 'add') {
    if (!args.product_id) throw new Error('product_id is required for add action.');
    await provider.addToBasket(args.product_id, args.quantity || 1);
    return { text: `✅ Added ${args.quantity || 1}x product ${args.product_id} to basket` };
  }

  if (action === 'remove') {
    if (!args.product_id) throw new Error('product_id is required for remove action.');
    await provider.removeFromBasket(args.product_id);
    return { text: `✅ Removed product ${args.product_id} from basket` };
  }

  if (action === 'clear') {
    await provider.clearBasket();
    return { text: `✅ Basket cleared` };
  }

  // View — full basket check with habits
  const sainsburys = provider;

  // Auto-refresh habits from order history
  try {
    const rawOrders = await sainsburys.getOrdersRaw();
    if (rawOrders.length > 0) {
      const recentOrders = rawOrders.slice(0, 10);
      const orderUids = recentOrders.map((o: any) => o.order_uid);

      const orderMetas = recentOrders.map((o: any) => ({
        order_uid: o.order_uid,
        status: o.status,
        order_type: o.order_type || 'unknown',
        total: o.total,
        sub_total: o.sub_total,
        savings: o.savings || 0,
        vouchers_savings: o.vouchers_savings || 0,
        slot_start_time: o.slot_start_time || '',
        slot_end_time: o.slot_end_time || '',
        slot_price: o.slot_price || 0,
        store_identifier: o.store_identifier || '',
        delivery_address: o.delivery_address || { nickname: '', postcode: '', street: '', building_number: '', town: '', county: '' },
      }));
      listManager.saveOrderHistory({ orders: orderMetas, lastFetched: new Date().toISOString() });

      const { fetchOrders, pruneOldOrders } = await import('../browser/orders.js');
      const scrapedOrders = await fetchOrders(orderUids, (uid: string) => sainsburys.getOrderDetails(uid));
      pruneOldOrders(orderUids);

      if (scrapedOrders.length > 0) {
        listManager.analyzeHabits(orderMetas, scrapedOrders);
      }
    }
  } catch (e: any) {
    console.error('⚠️ Habits refresh failed (continuing with cached):', e.message);
  }

  const activeOrder = await sainsburys.getActiveOrder?.();
  const orderStatus = await sainsburys.getOrderStatus?.();
  const basket = await provider.getBasket();
  const habits = listManager.getHabits();
  const shoppingList = listManager.getShoppingList();

  const basketNames = basket.items.map((i: any) => i.name?.toLowerCase().trim()).filter(Boolean);
  const orderItemNames = (activeOrder?.items || []).map((i: any) => i.name?.toLowerCase().trim()).filter(Boolean);
  const allCoveredNames = [...basketNames, ...orderItemNames];

  const listStatus = shoppingList.items.map(item => {
    const desc = item.description.toLowerCase();
    const inBasket = basketNames.some((n: string) => n.includes(desc) || desc.includes(n));
    const inOrder = orderItemNames.some((n: string) => n.includes(desc) || desc.includes(n));
    return {
      description: item.description,
      quantity: item.quantity,
      status: (inBasket ? 'in_basket' : inOrder ? 'in_order' : 'missing') as 'in_basket' | 'in_order' | 'missing',
    };
  });

  const topHabits = habits.itemHabits.filter(h => h.confidence >= 0.6);
  const uncoveredHabits = topHabits.filter(h =>
    !allCoveredNames.some(n => n.includes(h.name.toLowerCase()) || h.name.toLowerCase().includes(n))
  );

  const data = {
    active_order: activeOrder ? {
      order_uid: activeOrder.order.order_uid,
      total: activeOrder.order.total,
      slot_start_time: activeOrder.order.slot_start_time,
      cutoff_time: activeOrder.order.cutoff_time,
      is_in_amend_mode: orderStatus?.is_in_amend_mode ?? false,
      items: activeOrder.items,
    } : null,
    basket: {
      total_cost: basket.total_cost,
      total_quantity: basket.total_quantity,
      items: basket.items.map((item: any) => ({
        name: item.name,
        quantity: item.quantity,
        unit_price: item.unit_price,
        total_price: item.total_price,
        item_id: item.item_id,
        product_uid: item.product_uid,
      })),
      slot: basket.slot ? {
        reserved: basket.slot.reserved,
        date: basket.slot.date,
        start_time: basket.slot.start_time,
        end_time: basket.slot.end_time,
        price: basket.slot.price,
        address: basket.slot.address,
        reserved_until: basket.slot.reserved_until,
      } : null,
    },
    order_habits: habits.orderHabits.totalOrdersAnalyzed > 0 ? {
      averageOrderFrequencyDays: habits.orderHabits.averageOrderFrequencyDays,
      preferredDeliveryDay: habits.orderHabits.preferredDeliveryDay,
      preferredDeliveryTime: habits.orderHabits.preferredDeliveryTime,
      lastOrderSlotTime: listManager.getOrderHistory().orders[0]?.slot_start_time || null,
    } : null,
    shopping_list: { items: listStatus },
    frequently_bought_uncovered: uncoveredHabits.map(h => ({
      name: h.name,
      product_id: h.product_id || '?',
      confidence: h.confidence,
      average_quantity: h.averageQuantity,
    })),
  };

  return { text: formatBasketView(data), data };
}

function formatSuggestedNextSlot(orderHabits: any): string {
  if (!orderHabits?.lastOrderSlotTime || !orderHabits.averageOrderFrequencyDays) return '';

  const lastSlot = new Date(orderHabits.lastOrderSlotTime);
  const nextDate = new Date(lastSlot.getTime() + orderHabits.averageOrderFrequencyDays * 24 * 60 * 60 * 1000);

  // Use preferred delivery time to set a reasonable hour
  let hour = 7; // default morning
  const prefTime = (orderHabits.preferredDeliveryTime || '').toLowerCase();
  if (prefTime.includes('afternoon')) hour = 14;
  else if (prefTime.includes('evening')) hour = 19;
  nextDate.setHours(hour, 30, 0, 0);

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const day = nextDate.getDate();
  const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
  const timeStr = nextDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const formatted = `${dayNames[nextDate.getDay()]} ${day}${suffix} ${monthNames[nextDate.getMonth()]} ${timeStr}`;

  return `\n   🔮 Suggested next delivery: ~${formatted} (every ~${orderHabits.averageOrderFrequencyDays} days from last order)`;
}

function formatBasketView(data: any): string {
  let t = '';

  // Status line — always first
  const hasOrder = !!data.active_order;
  const hasBasketItems = data.basket.items.length > 0;
  const isAmend = data.active_order?.is_in_amend_mode === true;

  if (isAmend) {
    t += `🔄 STATUS: AMEND MODE — Order #${data.active_order.order_uid} is being amended. Basket changes will modify this order. Checkout REQUIRED to confirm.\n\n`;
  } else if (hasOrder) {
    t += `📦 STATUS: SCHEDULED ORDER — Order #${data.active_order.order_uid} is placed. Call sainsburys_order_amend FIRST before modifying.\n\n`;
  } else if (hasBasketItems) {
    t += `🛒 STATUS: BASKET — No placed order. Items are in a fresh basket.`;
    t += formatSuggestedNextSlot(data.order_habits);
    t += `\n\n`;
  } else {
    t += `🫙 STATUS: EMPTY BASKET — No order, no items.`;
    t += formatSuggestedNextSlot(data.order_habits);
    t += `\n\n`;
  }

  // Active order
  if (data.active_order) {
    const ao = data.active_order;
    const slotDate = ao.slot_start_time?.split('T')[0] || '';
    t += `📦 ACTIVE ORDER #${ao.order_uid}`;
    if (ao.is_in_amend_mode) {
      t += ` ✏️ AMEND MODE`;
    }
    t += `\n`;
    t += `   Delivery: ${slotDate}, £${ao.total}\n`;
    t += `   Cutoff: ${ao.cutoff_time}\n`;
    const totalUnits = ao.items.reduce((sum: number, item: any) => sum + (item.quantity || 1), 0);
    t += `   Items (${ao.items.length} lines, ${totalUnits} units):\n`;
    ao.items.forEach((item: any) => {
      t += `   - ${item.quantity}x ${item.name} (ID: ${item.product_id || '?'})\n`;
    });
    t += '\n';
  }

  // Basket
  const b = data.basket;
  t += `🛒 CURRENT BASKET: £${b.total_cost.toFixed(2)} (${b.items.length} lines, ${b.total_quantity} units)\n`;
  if (b.slot?.reserved) {
    const startDt = b.slot.start_time ? new Date(b.slot.start_time) : null;
    const endDt = b.slot.end_time ? new Date(b.slot.end_time) : null;
    const slotDate = startDt ? startDt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : b.slot.date || '';
    const slotStart = startDt ? startDt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    const slotEnd = endDt ? endDt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    const slotPrice = b.slot.price != null ? `£${b.slot.price.toFixed(2)}` : '';
    const addr = b.slot.address ? ` to ${b.slot.address}` : '';
    t += `   📅 DELIVERY SLOT RESERVED: ${slotDate} ${slotStart}${slotEnd ? `-${slotEnd}` : ''} ${slotPrice}${addr}\n`;
    if (b.slot.reserved_until) {
      const until = new Date(b.slot.reserved_until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      t += `   ⚠️ Reserved until ${until} — checkout REQUIRED before then to keep this slot.\n`;
    }
    t += `   ⚠️ A slot is already reserved — do NOT reserve another slot.\n`;
  } else {
    t += `   📅 No delivery slot reserved\n`;
  }
  if (b.items.length > 0) {
    b.items.forEach((item: any) => {
      const unitPrice = item.unit_price ? `£${item.unit_price.toFixed(2)} each` : '';
      const totalPrice = item.total_price ? ` = £${item.total_price.toFixed(2)}` : '';
      const pricing = unitPrice ? ` — ${unitPrice}${totalPrice}` : '';
      t += `   - ${item.quantity}x ${item.name}${pricing} (ID: ${item.product_uid || item.item_id})\n`;
    });
  } else {
    t += `   (empty)\n`;
  }
  t += '\n';

  // Shopping list
  t += `📝 SHOPPING LIST (${data.shopping_list.items.length} items):\n`;
  if (data.shopping_list.items.length === 0) {
    t += `   (empty)\n`;
  } else {
    for (const item of data.shopping_list.items) {
      const qty = item.quantity ? ` x${item.quantity}` : '';
      if (item.status === 'in_basket') {
        t += `   ✅ ${item.description}${qty} — in basket\n`;
      } else if (item.status === 'in_order') {
        t += `   📦 ${item.description}${qty} — in active order\n`;
      } else {
        t += `   ❌ ${item.description}${qty} — MISSING\n`;
      }
    }
  }
  t += '\n';

  // Frequently bought
  if (data.frequently_bought_uncovered.length > 0) {
    t += `🛍️ FREQUENTLY BOUGHT (not in basket/order) — ${data.frequently_bought_uncovered.length} items:\n`;
    data.frequently_bought_uncovered.forEach((h: any) => {
      t += `   ${h.name} | ID: ${h.product_id} | ${Math.round(h.confidence * 100)}% | avg qty: ${h.average_quantity}\n`;
    });
  }

  if (data.shopping_list.items.every((i: any) => i.status !== 'missing') && data.frequently_bought_uncovered.length === 0) {
    t += '✅ Looks good! Nothing obviously missing.\n';
  }

  return t;
}


// ─── Slots ─────────────────────────────────────────────────

export interface SlotsArgs {
  action?: 'list' | 'book' | 'change';
  slot_id?: string;
}

export async function handleSlots(args: SlotsArgs): Promise<HandlerResult> {
  const provider = getProvider();
  const action = args.action || 'list';

  if (action === 'book') {
    if (!args.slot_id) throw new Error('slot_id is required for book action.');
    await provider.bookSlot(args.slot_id);
    return { text: `✅ Delivery slot ${args.slot_id} reserved. Remember to checkout to complete the order.` };
  }

  if (action === 'change') {
    const sainsburys = provider;
    const slots = await sainsburys.changeSlot(args.slot_id);

    if (args.slot_id) {
      return { text: `✅ Slot changed to ${args.slot_id}. Remember to checkout to complete the order.` };
    }

    // No slot_id — just show available slots for the user to pick
    if (slots.length === 0) {
      return { text: '📅 No delivery slots available to change to.' };
    }

    let t = '📅 Available Delivery Slots (pick one to change to):\n\n';
    t += slots.map((s, i) => {
      const available = s.available ? '✅' : '❌';
      return `${i + 1}. ${s.date} ${s.start_time}-${s.end_time}\n   £${s.price.toFixed(2)} ${available} | ID: ${s.slot_id}`;
    }).join('\n\n');
    t += '\n\nUse slots change <slot-id> to select one.';
    return { text: t };
  }

  const slots = await provider.getDeliverySlots();
  const habits = listManager.getHabits();
  const orderHistory = listManager.getOrderHistory();

  if (slots.length === 0) {
    return { text: '📅 No delivery slots available.' };
  }

  let t = '📅 Available Delivery Slots:\n\n';
  t += slots.map((s, i) => {
    const available = s.available ? '✅' : '❌';
    return `${i + 1}. ${s.date} ${s.start_time}-${s.end_time}\n   £${s.price.toFixed(2)} ${available} | ID: ${s.slot_id}`;
  }).join('\n\n');

  if (habits.orderHabits.totalOrdersAnalyzed > 0) {
    const oh = habits.orderHabits;
    t += `\n\n📊 DELIVERY PREFERENCES (from ${oh.totalOrdersAnalyzed} past orders):\n`;
    t += `   Preferred day: ${oh.preferredDeliveryDay}\n`;
    t += `   Preferred time: ${oh.preferredDeliveryTime}\n`;
    t += `   Order frequency: every ~${oh.averageOrderFrequencyDays} days\n`;
    t += `   Delivery address: ${oh.deliveryAddress}`;
  }

  if (orderHistory.orders.length > 0) {
    const lo = orderHistory.orders[0];
    const slotDate = lo.slot_start_time?.split('T')[0] || 'unknown';
    const slotTime = `${lo.slot_start_time?.split('T')[1]?.slice(0, 5) || ''}-${lo.slot_end_time?.split('T')[1]?.slice(0, 5) || ''}`;
    t += `\n\n📦 LAST ORDER: ${slotDate} ${slotTime}, £${lo.total} (slot: £${lo.slot_price})`;
  }

  return { text: t };
}

// ─── Checkout ──────────────────────────────────────────────

export interface CheckoutArgs {
  dry_run?: boolean;
}

export async function handleCheckout(args: CheckoutArgs): Promise<HandlerResult> {
  const dryRun = args.dry_run !== false; // default true
  const result = await browserCheckout(dryRun);

  if (result.status === 'mfa_required') {
    return { text: '🔐 MFA required — a 6-digit code has been sent to your phone.\nUse sainsburys_login with code param (MCP) or sains login --code <code> (CLI) to continue.' };
  }
  if (result.status === 'preview') {
    return { text: `🔍 Checkout Preview (dry run)\n   Basket total: £${result.total}` };
  }
  if (result.status === 'payment_required') {
    return { text: `💳 Checkout Ready — Payment Required\n   Total: £${result.total}\n   Delivery cost: £${result.delivery_cost}\n   Complete payment in the browser window.` };
  }
  if (result.status === 'completed') {
    return { text: `✅ Order Completed!\n   Order ID: ${result.order_id}\n   Total: £${result.total}` };
  }
  return { text: `Checkout status: ${result.status}` };
}

// ─── Orders ────────────────────────────────────────────────

export interface OrdersArgs {
  limit?: number;
  order_uid?: string;
}

export async function handleOrders(args: OrdersArgs): Promise<HandlerResult> {
  const sainsburys = getProvider();

  // View specific order
  if (args.order_uid) {
    const details = await sainsburys.getOrderDetails(args.order_uid);
    const items = (details.order_items || []).map((item: any) => {
      const name = item.product?.name || 'Unknown';
      const qty = item.quantity || 1;
      const price = item.sub_total || 0;
      const productId = item.product?.product_uid || '';
      return `   - ${qty}x ${name} — £${Number(price).toFixed(2)}${productId ? ` (ID: ${productId})` : ''}`;
    });

    const status = details.status || 'unknown';
    const total = details.total || 0;
    const slotStart = details.slot_start_time || '';
    const slotEnd = details.slot_end_time || '';
    const slotLine = slotStart ? `\n   📅 Delivery: ${slotStart} – ${slotEnd}` : '';

    return {
      text: `📦 Order #${args.order_uid} | ${status} | £${Number(total).toFixed(2)}${slotLine}\n\n${items.length > 0 ? items.join('\n') : '   No items found.'}`
    };
  }

  // List orders
  const orders = await sainsburys.getOrders();
  const limit = args.limit || 10;
  const limited = orders.slice(0, limit);

  if (limited.length === 0) {
    return { text: '📦 No orders found.' };
  }

  const lines = limited.map((o, i) => {
    let line = `${i + 1}. Order #${o.order_id} | ${o.status} | £${o.total.toFixed(2)}`;
    if (o.delivery_slot) {
      line += `\n   Delivery: ${o.delivery_slot.date} ${o.delivery_slot.start_time}-${o.delivery_slot.end_time}`;
    }
    return line;
  });

  return { text: `📦 Order History:\n\n${lines.join('\n\n')}` };
}

// ─── Amend Order ───────────────────────────────────────────

export interface AmendOrderArgs {
  order_uid?: string;
  action?: 'amend' | 'cancel';
}

export async function handleAmendOrder(args: AmendOrderArgs): Promise<HandlerResult> {
  const provider = getProvider();
  const action = args.action || 'amend';

  if (action === 'cancel') {
    await provider.cancelAmendOrder();
    return { text: '✅ Amend cancelled — changes discarded. Order reverted to its original state.' };
  }

  let uid = args.order_uid;
  if (!uid) {
    const activeOrder = await provider.getActiveOrder?.();
    if (!activeOrder) {
      throw new Error('No active (scheduled, pre-cutoff) order found to amend.');
    }
    uid = activeOrder.order.order_uid;
  }

  await provider.amendOrder(uid!);
  return { text: `✅ Order #${uid} is now in amend mode. Use basket commands to modify items, then checkout to confirm.` };
}

// ─── Shopping List ─────────────────────────────────────────

export interface ListArgs {
  action?: 'show' | 'add' | 'remove' | 'clear';
  description?: string;
  quantity?: number;
  notes?: string;
  item_id?: string;
}

export function handleList(args: ListArgs): HandlerResult {
  const action = args.action || 'show';

  if (action === 'add') {
    if (!args.description) throw new Error('description is required for add action.');
    const item = listManager.addItem(args.description, args.quantity, args.notes);
    const qty = args.quantity ? ` (x${args.quantity})` : '';
    return { text: `✅ Added: ${args.description}${qty}\n   ID: ${item.id}` };
  }

  if (action === 'remove') {
    if (!args.item_id) throw new Error('item_id is required for remove action.');
    if (listManager.removeItem(args.item_id)) {
      return { text: '✅ Removed from list' };
    }
    throw new Error(`Item not found: ${args.item_id}`);
  }

  if (action === 'clear') {
    listManager.clearList();
    return { text: '✅ Shopping list cleared' };
  }

  // show
  const list = listManager.getShoppingList();
  if (list.items.length === 0) {
    return { text: '📝 Shopping list is empty.\n   Add items: sains list add "semi skimmed milk"' };
  }

  const lines = list.items.map((item, i) => {
    const qty = item.quantity ? ` x${item.quantity}` : '';
    const notes = item.notes ? ` (${item.notes})` : '';
    return `${i + 1}. ${item.description}${qty}${notes}\n   ID: ${item.id}`;
  });

  return { text: `📝 Shopping List (${list.items.length} items)\n\n${lines.join('\n\n')}\n\nLast modified: ${list.lastModified}` };
}
