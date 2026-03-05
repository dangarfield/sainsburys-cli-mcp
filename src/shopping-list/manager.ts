import * as fs from 'fs';
import { SHOPPING_LIST_FILE, HABITS_FILE, ORDER_HISTORY_FILE, ensureConfigDir } from '../config/paths.js';

// ─── Shopping List Types ─────────────────────────────────────────

export interface ShoppingListItem {
  id: string;
  description: string;
  quantity?: number;
  addedAt: string;
  notes?: string;
}

export interface ShoppingList {
  items: ShoppingListItem[];
  lastModified: string;
}

// ─── Order History Types ─────────────────────────────────────────

export interface OrderMeta {
  order_uid: string;
  status: string;
  order_type: string;
  total: number;
  sub_total: number;
  savings: number;
  vouchers_savings: number;
  slot_start_time: string;
  slot_end_time: string;
  slot_price: number;
  store_identifier: string;
  delivery_address: {
    nickname: string;
    postcode: string;
    street: string;
    building_number: string;
    town: string;
    county: string;
  };
}

export interface OrderHistory {
  orders: OrderMeta[];
  lastFetched: string;
}

// ─── Habits Types ────────────────────────────────────────────────

export interface ItemHabit {
  name: string;
  occurrences: number;
  totalOrders: number;
  frequency: number;
  confidence: number;
  averageQuantity: number;
  averagePrice: number;
  lastPurchased: string;
  product_id?: string;
}

export interface OrderHabits {
  averageOrderFrequencyDays: number;
  averageOrderTotal: number;
  preferredDeliveryDay: string;
  preferredDeliveryTime: string;
  preferredOrderType: string;
  deliveryAddress: string;
  totalOrdersAnalyzed: number;
}

export interface Habits {
  orderHabits: OrderHabits;
  itemHabits: ItemHabit[];
  lastAnalyzed: string;
}

interface ScrapedOrderInput {
  order_uid: string;
  items: { name: string; quantity: number; price: number; product_id?: string }[];
}

export class ShoppingListManager {

  // ── Shopping List ────────────────────────────────────────────

  getShoppingList(): ShoppingList {
    if (!fs.existsSync(SHOPPING_LIST_FILE)) {
      return { items: [], lastModified: new Date().toISOString() };
    }
    return JSON.parse(fs.readFileSync(SHOPPING_LIST_FILE, 'utf-8'));
  }

  saveShoppingList(list: ShoppingList) {
    ensureConfigDir();
    list.lastModified = new Date().toISOString();
    fs.writeFileSync(SHOPPING_LIST_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  }

  addItem(description: string, quantity?: number, notes?: string): ShoppingListItem {
    const list = this.getShoppingList();
    const item: ShoppingListItem = {
      id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      description,
      quantity,
      addedAt: new Date().toISOString(),
      notes
    };
    list.items.push(item);
    this.saveShoppingList(list);
    return item;
  }

  removeItem(itemId: string): boolean {
    const list = this.getShoppingList();
    const before = list.items.length;
    list.items = list.items.filter(item => item.id !== itemId);
    if (list.items.length < before) {
      this.saveShoppingList(list);
      return true;
    }
    return false;
  }

  clearList() {
    this.saveShoppingList({ items: [], lastModified: new Date().toISOString() });
  }

  // ── Order History ────────────────────────────────────────────

  getOrderHistory(): OrderHistory {
    if (!fs.existsSync(ORDER_HISTORY_FILE)) {
      return { orders: [], lastFetched: new Date().toISOString() };
    }
    return JSON.parse(fs.readFileSync(ORDER_HISTORY_FILE, 'utf-8'));
  }

  saveOrderHistory(history: OrderHistory) {
    ensureConfigDir();
    history.lastFetched = new Date().toISOString();
    fs.writeFileSync(ORDER_HISTORY_FILE, JSON.stringify(history, null, 2), { mode: 0o600 });
  }

  // ── Habits ───────────────────────────────────────────────────

  getHabits(): Habits {
    if (!fs.existsSync(HABITS_FILE)) {
      return {
        orderHabits: {
          averageOrderFrequencyDays: 0, averageOrderTotal: 0,
          preferredDeliveryDay: '', preferredDeliveryTime: '',
          preferredOrderType: '', deliveryAddress: '', totalOrdersAnalyzed: 0,
        },
        itemHabits: [],
        lastAnalyzed: new Date().toISOString()
      };
    }
    return JSON.parse(fs.readFileSync(HABITS_FILE, 'utf-8'));
  }

  saveHabits(habits: Habits) {
    ensureConfigDir();
    fs.writeFileSync(HABITS_FILE, JSON.stringify(habits, null, 2), { mode: 0o600 });
  }

  // ── Analyze Habits ───────────────────────────────────────────

  analyzeHabits(orderMetas: OrderMeta[], scrapedOrders: ScrapedOrderInput[]): Habits {
    const orderHabits = this.analyzeOrderHabits(orderMetas);
    const itemHabits = this.analyzeItemHabits(orderMetas, scrapedOrders);

    const habits: Habits = {
      orderHabits,
      itemHabits,
      lastAnalyzed: new Date().toISOString()
    };

    this.saveHabits(habits);
    return habits;
  }

  private analyzeOrderHabits(orders: OrderMeta[]): OrderHabits {
    if (orders.length === 0) {
      return {
        averageOrderFrequencyDays: 0, averageOrderTotal: 0,
        preferredDeliveryDay: '', preferredDeliveryTime: '',
        preferredOrderType: '', deliveryAddress: '', totalOrdersAnalyzed: 0,
      };
    }

    // Order frequency: average days between consecutive orders
    const sortedDates = orders
      .map(o => new Date(o.slot_start_time).getTime())
      .sort((a, b) => b - a); // newest first

    let totalGapDays = 0;
    for (let i = 0; i < sortedDates.length - 1; i++) {
      totalGapDays += (sortedDates[i] - sortedDates[i + 1]) / (1000 * 60 * 60 * 24);
    }
    const avgFrequency = sortedDates.length > 1
      ? Math.round((totalGapDays / (sortedDates.length - 1)) * 10) / 10
      : 0;

    // Average total
    const avgTotal = Math.round(
      (orders.reduce((sum, o) => sum + o.total, 0) / orders.length) * 100
    ) / 100;

    // Preferred delivery day
    const dayCounts = new Map<string, number>();
    const timeCounts = new Map<string, number>();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    for (const order of orders) {
      const d = new Date(order.slot_start_time);
      const dayName = days[d.getDay()];
      dayCounts.set(dayName, (dayCounts.get(dayName) || 0) + 1);

      const hour = d.getHours();
      let timeSlot: string;
      if (hour < 12) timeSlot = 'Morning (before 12pm)';
      else if (hour < 17) timeSlot = 'Afternoon (12-5pm)';
      else timeSlot = 'Evening (after 5pm)';
      timeCounts.set(timeSlot, (timeCounts.get(timeSlot) || 0) + 1);
    }

    const preferredDay = [...dayCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const preferredTime = [...timeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    // Preferred order type
    const typeCounts = new Map<string, number>();
    for (const order of orders) {
      typeCounts.set(order.order_type, (typeCounts.get(order.order_type) || 0) + 1);
    }
    const preferredType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    // Delivery address (most common)
    const addrCounts = new Map<string, number>();
    for (const order of orders) {
      if (order.delivery_address) {
        const addr = `${order.delivery_address.building_number} ${order.delivery_address.street}, ${order.delivery_address.town} ${order.delivery_address.postcode}`;
        addrCounts.set(addr, (addrCounts.get(addr) || 0) + 1);
      }
    }
    const deliveryAddress = [...addrCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    return {
      averageOrderFrequencyDays: avgFrequency,
      averageOrderTotal: avgTotal,
      preferredDeliveryDay: preferredDay,
      preferredDeliveryTime: preferredTime,
      preferredOrderType: preferredType,
      deliveryAddress,
      totalOrdersAnalyzed: orders.length,
    };
  }

  private analyzeItemHabits(orderMetas: OrderMeta[], scrapedOrders: ScrapedOrderInput[]): ItemHabit[] {
    const totalOrders = scrapedOrders.length;
    if (totalOrders === 0) return [];

    // Sort order metas by date (newest first) for recency calculations
    const sortedMetas = [...orderMetas].sort(
      (a, b) => new Date(b.slot_start_time).getTime() - new Date(a.slot_start_time).getTime()
    );
    const mostRecentUid = sortedMetas[0]?.order_uid;
    const secondMostRecentUid = sortedMetas[1]?.order_uid;

    // Build item map: normalized name -> aggregated data
    const itemMap = new Map<string, {
      originalName: string;
      quantities: number[];
      prices: number[];
      orderUids: string[];
      product_id?: string;
    }>();

    for (const order of scrapedOrders) {
      for (const item of order.items) {
        const key = item.name.toLowerCase().trim();
        if (!itemMap.has(key)) {
          itemMap.set(key, {
            originalName: item.name,
            quantities: [],
            prices: [],
            orderUids: [],
            product_id: item.product_id,
          });
        }
        const entry = itemMap.get(key)!;
        entry.quantities.push(item.quantity);
        entry.prices.push(item.price);
        entry.orderUids.push(order.order_uid);
      }
    }

    const habits: ItemHabit[] = [];

    for (const [, data] of itemMap) {
      const occurrences = data.quantities.length;
      const frequency = occurrences / totalOrders;
      const avgQty = data.quantities.reduce((a, b) => a + b, 0) / occurrences;
      const avgPrice = data.prices.reduce((a, b) => a + b, 0) / occurrences;

      // Confidence: base is frequency, boosted by recency
      let confidence = frequency;
      if (data.orderUids.includes(mostRecentUid)) {
        confidence = Math.min(1, confidence + 0.15);
      }
      if (secondMostRecentUid && data.orderUids.includes(secondMostRecentUid)) {
        confidence = Math.min(1, confidence + 0.05);
      }

      // Find the most recent order date for this item
      const itemOrderDates = data.orderUids
        .map(uid => orderMetas.find(m => m.order_uid === uid)?.slot_start_time || '')
        .filter(Boolean)
        .sort()
        .reverse();

      habits.push({
        name: data.originalName,
        occurrences,
        totalOrders,
        frequency: Math.round(frequency * 100) / 100,
        confidence: Math.round(confidence * 100) / 100,
        averageQuantity: Math.round(avgQty * 10) / 10,
        averagePrice: Math.round(avgPrice * 100) / 100,
        lastPurchased: itemOrderDates[0] || '',
        product_id: data.product_id,
      });
    }

    // Sort by confidence descending
    habits.sort((a, b) => b.confidence - a.confidence);
    return habits;
  }

  // ── Check Basket ─────────────────────────────────────────────

  /**
   * Try to match a shopping list description against habit items.
   * Returns the best matching habit item, or null.
   */
  private matchHabitProduct(description: string, habits: Habits): ItemHabit | null {
    const desc = description.toLowerCase();
    const matches = habits.itemHabits.filter(h => {
      const name = h.name.toLowerCase();
      return name.includes(desc) || desc.includes(name);
    });
    if (matches.length === 0) return null;
    // Pick the one with highest confidence
    return matches.sort((a, b) => b.confidence - a.confidence)[0];
  }

  checkBasket(
    basketItems: { name: string }[],
    activeOrderItems?: { name: string }[]
  ): {
    inBasket: string[];
    inActiveOrder: string[];
    missing: { description: string; match?: { name: string; product_id?: string; confidence: number; averageQuantity: number } }[];
    suggestions: string[];
  } {
    const list = this.getShoppingList();
    const habits = this.getHabits();

    const basketNames = basketItems.map(item => item.name.toLowerCase().trim());
    const orderNames = (activeOrderItems || []).map(item => item.name.toLowerCase().trim());
    const allCoveredNames = [...basketNames, ...orderNames];

    // Check shopping list items against basket + active order
    const missing: { description: string; match?: { name: string; product_id?: string; confidence: number; averageQuantity: number } }[] = [];
    const inBasket: string[] = [];
    const inActiveOrder: string[] = [];

    for (const item of list.items) {
      const desc = item.description.toLowerCase();
      const foundInBasket = basketNames.some(name =>
        name.includes(desc) || desc.includes(name)
      );
      if (foundInBasket) {
        inBasket.push(item.description);
        continue;
      }
      const foundInOrder = orderNames.some(name =>
        name.includes(desc) || desc.includes(name)
      );
      if (foundInOrder) {
        inActiveOrder.push(item.description);
        continue;
      }
      // Try to correlate with a historic product
      const habit = this.matchHabitProduct(item.description, habits);
      missing.push({
        description: item.description,
        match: habit ? {
          name: habit.name,
          product_id: habit.product_id,
          confidence: habit.confidence,
          averageQuantity: habit.averageQuantity,
        } : undefined,
      });
    }

    // Suggest high-confidence habit items not on list, in basket, or in active order
    const suggestions: string[] = [];
    for (const habit of habits.itemHabits) {
      if (habit.confidence < 0.5) continue;

      const onList = list.items.some(item =>
        item.description.toLowerCase().includes(habit.name.toLowerCase()) ||
        habit.name.toLowerCase().includes(item.description.toLowerCase())
      );
      const alreadyCovered = allCoveredNames.some(name =>
        name.includes(habit.name.toLowerCase()) ||
        habit.name.toLowerCase().includes(name)
      );

      if (!onList && !alreadyCovered) {
        suggestions.push(`${habit.name} (${Math.round(habit.confidence * 100)}% likely, avg qty: ${habit.averageQuantity})`);
      }
    }

    return { inBasket, inActiveOrder, missing, suggestions };
  }
}
