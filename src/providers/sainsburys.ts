/**
 * Sainsbury's Grocery Provider
 *
 * Base URL: https://www.sainsburys.co.uk/groceries-api/gol-services
 *
 * Auth: All authenticated requests need Cookie header (session cookies from Playwright login)
 * and wcauthtoken header (value from WC_AUTHENTICATION_* cookie). Auto-relogins on 401/403.
 *
 * REST API endpoints used:
 *   GET  /product/v1/product?filter[keyword]=QUERY&page_number=1&page_size=24&sort_order=FAVOURITES_FIRST
 *   GET  /product/v1/product/{product_uid}
 *   GET  /basket/v2/basket?pick_time=ISO_DATE&store_number=STORE
 *   POST /basket/v2/basket/item  — add item { product_uid, quantity, uom: "ea" }
 *   PUT  /basket/v2/basket       — update/remove items { items: [{ product_uid, quantity, item_uid, ... }] }
 *                                  Set quantity=0 to remove. pick_time/slot_booked params must match slot state.
 *   GET  /slot/v1/slot/reservation — current slot reservation status
 *   GET  /customer/v1/customer/profile
 *   GET  /order/v1/order?page_size=N&page_number=1
 *   GET  /order/v1/order/{uid}?placed=true&deliveryPass=false — full order with items
 *   POST /order/v1/order/{uid}/amend — enter amend mode (order becomes logical basket)
 *
 * Browser automation (direct API returns "Access Denied"):
 *   Slots:    src/browser/slots.ts    — navigates trolley → slot picker, parses DOM
 *   Checkout: src/browser/checkout.ts — navigates checkout flow, stops at payment page
 *
 * Basket ID note: API returns item_uid (basket line ID) and product.sku (product ID).
 * These are different values. updateBasketItem/removeFromBasket accept either.
 *
 * Query params:
 *   pick_time   — ISO 8601 date. Tomorrow when no slot, slot date when reserved.
 *   store_number — fulfilment store, default "0560", configurable via SAINSBURYS_STORE_NUMBER env.
 *   slot_booked  — "true"/"false" reflecting current reservation state.
 */

import axios, { AxiosInstance } from 'axios';
import { GroceryProvider, Product, Basket, DeliverySlot, Order, SearchOptions } from './types';
import { login } from '../auth/login';
import { CredentialsManager } from '../config/credentials';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const API_BASE = 'https://www.sainsburys.co.uk/groceries-api/gol-services';
const SESSION_FILE = path.join(os.homedir(), '.sainsburys', 'session.json');

export class SainsburysProvider implements GroceryProvider {
  readonly name = 'sainsburys';
  private client: AxiosInstance;
  private storeNumber: string;
  private autoReloginEnabled: boolean = true;

  constructor() {
    // Store number can be configured via environment variable
    // Default to '0560' if not set
    this.storeNumber = process.env.SAINSBURYS_STORE_NUMBER || '0560';
    this.client = axios.create({
      baseURL: API_BASE,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    });

    // Add response interceptor for 401 handling
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;
        
        // If 401/403 and we haven't retried yet and auto-relogin is enabled
        if ((error.response?.status === 401 || error.response?.status === 403) && 
            !originalRequest._retry && 
            this.autoReloginEnabled) {
          
          originalRequest._retry = true;
          
          // Check if we have credentials
          const credManager = new CredentialsManager();
          const creds = credManager.get();
          
          if (creds) {
            console.log('⚠️  Session expired or invalidated. Auto-relogging in...');
            try {
              await this.login(creds.email, creds.password);
              
              // Update the original request headers with the new session
              originalRequest.headers['Cookie'] = this.client.defaults.headers.common['Cookie'];
              if (this.client.defaults.headers.common['wcauthtoken']) {
                originalRequest.headers['wcauthtoken'] = this.client.defaults.headers.common['wcauthtoken'];
              }
              
              // Retry the original request with new session
              return this.client(originalRequest);
            } catch (loginError) {
              console.error('❌ Auto-relogin failed:', loginError);
              throw error;
            }
          } else {
            console.error('❌ Session expired. Run: groc login or groc credentials');
            throw error;
          }
        }
        
        return Promise.reject(error);
      }
    );

    // Load session if exists
    this.loadSession();
  }

  private loadSession() {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        if (session.cookies) {
          // Handle both formats: array (from login.ts) or string (legacy)
          let cookieString: string;
          if (Array.isArray(session.cookies)) {
            // Convert cookie objects to header string
            cookieString = session.cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
            
            // Extract WC_AUTHENTICATION token for basket operations
            const authCookie = session.cookies.find((c: any) => c.name.startsWith('WC_AUTHENTICATION_'));
            if (authCookie) {
              this.client.defaults.headers.common['wcauthtoken'] = authCookie.value;
            }
          } else {
            // Already a string
            cookieString = session.cookies;
          }
          this.client.defaults.headers.common['Cookie'] = cookieString;
        }
      }
    } catch (error) {
      // Ignore session load errors
    }
  }

  async login(email: string, password: string): Promise<{ givenName: string; familyName: string }> {
    const sessionData = await login(email, password);
    // Convert cookie objects to cookie header string
    const cookieString = sessionData.cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
    
    // Extract WC_AUTHENTICATION token for basket operations
    const authCookie = sessionData.cookies.find((c: any) => c.name.startsWith('WC_AUTHENTICATION_'));
    if (authCookie) {
      this.client.defaults.headers.common['wcauthtoken'] = authCookie.value;
    }
    
    // Set the cookie header for API requests
    this.client.defaults.headers.common['Cookie'] = cookieString;

    // Fetch profile to confirm login and return account name
    const profile = await this.getProfile();
    return { givenName: profile.given_name, familyName: profile.family_name };
  }

  async getProfile(): Promise<any> {
    const response = await this.client.get('/customer/v1/customer/profile');
    return response.data;
  }

  async logout(): Promise<void> {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
    delete this.client.defaults.headers.common['Cookie'];
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.getBasket();
      return true;
    } catch {
      return false;
    }
  }

  async search(query: string, options?: SearchOptions): Promise<Product[]> {
    const params: any = {
      'filter[keyword]': query,
      page_number: options?.offset ? Math.floor(options.offset / (options.limit || 24)) + 1 : 1,
      page_size: options?.limit || 24,
      sort_order: 'FAVOURITES_FIRST'
    };

    const response = await this.client.get('/product/v1/product', { params });
    
    return response.data.products.map((p: any) => ({
      product_uid: p.product_uid,
      name: p.name,
      description: p.description,
      retail_price: p.retail_price,
      unit_price: p.unit_price,
      in_stock: p.is_available !== false,
      image_url: p.image,
      provider: this.name,
      promotions: (p.promotions || []).map((promo: any) => ({
        promotion_uid: promo.promotion_uid,
        description: promo.description || promo.strap_line || promo.title,
        start_date: promo.start_date,
        end_date: promo.end_date,
      })),
      reviews: p.reviews?.total > 0 ? { total: p.reviews.total, average_rating: p.reviews.average_rating } : undefined,
      brand: p.attributes?.brand?.[0],
      labels: (p.labels || []).map((l: any) => l.text),
    }));
  }

  async getProduct(productId: string): Promise<Product> {
    const response = await this.client.get(`/product/v1/product/${productId}`);
    const p = response.data;
    return {
      product_uid: p.product_uid,
      name: p.name,
      description: p.description,
      retail_price: p.retail_price,
      unit_price: p.unit_price,
      in_stock: p.in_stock !== false,
      image_url: p.image,
      provider: this.name
    };
  }

  async getCategories(): Promise<any> {
    const response = await this.client.get('/product/categories/tree');
    return response.data;
  }

  async getBasket(): Promise<Basket> {
      const pickTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const response = await this.client.get('/basket/v2/basket', {
        params: {
          pick_time: pickTime,
          store_number: this.storeNumber,
        }
      });
      const data = response.data;

      // Check slot reservation via separate API
      let slot: Basket['slot'] = undefined;
      try {
        const resResponse = await this.client.get('/slot/v1/slot/reservation');
        const res = resResponse.data;
        if (res?.slot && !res.is_expired) {
          slot = {
            reserved: true,
            start_time: res.slot.start_time || '',
            end_time: res.slot.end_time || '',
            date: (res.slot.start_time || '').split('T')[0] || '',
            price: res.slot.price ?? res.slot.unqualified_price ?? 0,
            address: res.delivery_address?.postcode || '',
            reserved_until: res.reserved_until || '',
          };
        }
      } catch {
        // No reservation or API error — slot stays undefined
      }

      return {
        items: data.items?.map((item: any) => ({
          item_id: item.item_uid,
          product_uid: item.product?.sku,
          name: item.product?.name,
          quantity: item.quantity,
          unit_price: parseFloat(item.subtotal_price) / item.quantity,
          total_price: parseFloat(item.subtotal_price || 0)
        })) || [],
        total_quantity: data.item_count || 0,
        total_cost: parseFloat(data.total_price || 0),
        provider: this.name,
        slot,
      };
    }

  /**
   * Get the current slot-aware params for basket operations.
   * If a slot is reserved, uses the slot date and slot_booked=true.
   */
  private async getBasketParams(): Promise<{ pick_time: string; store_number: string; slot_booked: string }> {
    let pickTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('.')[0] + 'Z';
    let slotBooked = 'false';

    try {
      const res = await this.client.get('/slot/v1/slot/reservation');
      if (res.data?.slot && !res.data.is_expired) {
        const slotStart = res.data.slot.start_time;
        if (slotStart) {
          pickTime = slotStart.split('T')[0] + 'T00:00:00Z';
          slotBooked = 'true';
        }
      }
    } catch {
      // No reservation — use defaults
    }

    return { pick_time: pickTime, store_number: this.storeNumber, slot_booked: slotBooked };
  }

  async addToBasket(productId: string, quantity: number): Promise<void> {
    const params = await this.getBasketParams();

    await this.client.post('/basket/v2/basket/item', {
      product_uid: productId,
      quantity,
      uom: 'ea',
      selected_catchweight: ''
    }, { params });
  }

  async updateBasketItem(itemId: string, quantity: number): Promise<void> {
      const params = await this.getBasketParams();

      // Get current basket to find the item
      const basket = await this.getBasket();
      let item = basket.items.find(i => i.item_id === itemId);

      if (!item) {
        // Fallback: match by product_uid (SKU) since callers often pass that
        item = basket.items.find(i => i.product_uid === itemId);
      }

      if (!item) {
        throw new Error(`Item ${itemId} not found in basket (checked both item_id and product_uid)`);
      }

      await this.client.put('/basket/v2/basket', {
        items: [{
          product_uid: item.product_uid,
          quantity,
          uom: 'ea',
          selected_catchweight: '',
          item_uid: item.item_id,
          decreasing_quantity: quantity < item.quantity
        }]
      }, { params });
    }

  async removeFromBasket(itemId: string): Promise<void> {
      // Remove by updating to quantity 0
      await this.updateBasketItem(itemId, 0);
    }

  async clearBasket(): Promise<void> {
    const basket = await this.getBasket();
    for (const item of basket.items) {
      await this.removeFromBasket(item.item_id);
    }
  }

  async getDeliverySlots(): Promise<DeliverySlot[]> {
    // Use browser automation to get slots
    const { getSlots } = await import('../browser/slots');
    const result = await getSlots();
    
    // If MFA required, can't return slots from here
    if (!Array.isArray(result)) {
      throw new Error('MFA required — use grocery_login with code to continue.');
    }
    
    return result.map(s => ({
      slot_id: s.slot_id,
      start_time: s.start_time,
      end_time: s.end_time,
      date: s.date,
      price: s.price,
      available: s.available
    }));
  }

  async bookSlot(slotId: string): Promise<void> {
    const { bookSlot } = await import('../browser/slots');
    const result = await bookSlot(slotId);
    if (result && typeof result === 'object' && 'status' in result) {
      throw new Error('MFA required — use grocery_login with code to continue.');
    }
  }

  async changeSlot(newSlotId?: string): Promise<DeliverySlot[]> {
    const { changeSlot } = await import('../browser/slots');
    const result = await changeSlot(newSlotId);

    if (!Array.isArray(result)) {
      throw new Error('MFA required — use grocery_login with code to continue.');
    }

    return result.map(s => ({
      slot_id: s.slot_id,
      start_time: s.start_time,
      end_time: s.end_time,
      date: s.date,
      price: s.price,
      available: s.available,
    }));
  }

  async checkout(dryRun: boolean = false): Promise<Order> {
    const { checkout } = await import('../browser/checkout');
    const result = await checkout(dryRun);
    
    return {
      order_id: result.order_id,
      status: result.status,
      total: result.total,
      items: []
    };
  }

  async getOrders(): Promise<Order[]> {
    try {
      const response = await this.client.get('/order/v1/order', {
        params: { page_size: 10, page_number: 1 }
      });

      const orders = response.data?.orders || [];
      return orders.map((o: any) => ({
        order_id: o.order_uid,
        status: o.status || 'unknown',
        total: parseFloat(o.total || 0),
        delivery_slot: o.slot_start_time ? {
          slot_id: '',
          start_time: o.slot_start_time,
          end_time: o.slot_end_time,
          date: o.slot_start_time?.split('T')[0] || '',
          price: parseFloat(o.slot_price || 0),
          available: true
        } : undefined,
        items: []
      }));
    } catch (error: any) {
      console.error(`❌ getOrders error: ${error.response?.status || 'no status'} - ${error.message}`);
      return [];
    }
  }

  /**
   * Get full order details including items via the JSON API.
   * GET /order/v1/order/{uid}?placed=true&deliveryPass=false
   */
  async getOrderDetails(orderUid: string): Promise<any> {
    const response = await this.client.get(`/order/v1/order/${orderUid}`, {
      params: { placed: true, deliveryPass: false }
    });
    return response.data;
  }

  /**
   * Get the raw order list response (includes delivery_address, savings, etc.)
   */
  async getOrdersRaw(): Promise<any[]> {
    try {
      const response = await this.client.get('/order/v1/order', {
        params: { page_size: 10, page_number: 1 }
      });
      return response.data?.orders || [];
    } catch (error: any) {
      console.error(`❌ getOrdersRaw error: ${error.response?.status || 'no status'} - ${error.message}`);
      return [];
    }
  }

  /**
   * Get the active (amendable) order if one exists.
   * An order is active if status is "scheduled" and is_cutoff is false.
   * Returns the order details with items, or null if no active order.
   */
  async getActiveOrder(): Promise<{ order: any; items: { name: string; quantity: number; price: number; product_id?: string }[] } | null> {
    try {
      const orders = await this.getOrdersRaw();
      const active = orders.find((o: any) => o.status === 'scheduled' && o.is_cutoff === false);
      if (!active) return null;

      const details = await this.getOrderDetails(active.order_uid);
      const items = (details.order_items || []).map((item: any) => ({
        name: item.product?.name || 'Unknown',
        quantity: item.quantity || 1,
        price: item.sub_total || 0,
        product_id: item.product?.product_uid,
      }));

      return {
        order: {
          order_uid: active.order_uid,
          status: active.status,
          total: active.total,
          slot_start_time: active.slot_start_time,
          slot_end_time: active.slot_end_time,
          is_cutoff: active.is_cutoff,
          cutoff_time: active.cutoff_time,
          delivery_address: active.delivery_address,
        },
        items,
      };
    } catch (error: any) {
      console.error(`❌ getActiveOrder error: ${error.message}`);
      return null;
    }
  }

  /**
   * Enter amend mode for a placed order.
   * POST /order/v1/order/{uid}/amend
   * This creates a logical basket from the order so items can be added/removed.
   */
  async amendOrder(orderUid: string): Promise<any> {
    const response = await this.client.post(`/order/v1/order/${orderUid}/amend`);
    return response.data;
  }
}
