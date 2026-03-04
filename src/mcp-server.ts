#!/usr/bin/env node
/**
 * MCP Server for Sainsbury's CLI.
 * Thin wrapper — all logic and formatting lives in commands/handlers.ts.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  handleLogin,
  handleSearch,
  handleBasket,
  handleSlots,
  handleCheckout,
  handleOrders,
  handleAmendOrder,
  handleList,
  isLoggedIn,
} from './commands/handlers.js';

const server = new Server(
  { name: 'sainsburys-cli-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } },
);

// ─── Tool definitions ──────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'sainsburys_login',
      description: 'Login to Sainsbury\'s grocery account for online food shopping / weekly shop. Required before using basket/checkout tools. Uses saved credentials from ~/.sainsburys/credentials.json if no args provided. If no credentials are saved and none provided, returns an error asking for email and password — the caller should ask the user and call again with both. Pass logout=true to log out instead. Pass code to submit a 6-digit MFA code when a browser tool returns mfa_required — the browser is kept alive waiting for the code, and after MFA succeeds the original operation resumes automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Account email address (optional if credentials saved)' },
          password: { type: 'string', description: 'Account password (optional if credentials saved)' },
          logout: { type: 'boolean', description: 'Set to true to log out instead of logging in', default: false },
          code: { type: 'string', description: '6-digit MFA code from SMS. Use when a browser tool (checkout, slots) returns mfa_required.' },
        },
      },
    },
    {
      name: 'sainsburys_search',
      description: 'Search for products on Sainsbury\'s online grocery store. Use this to find food, drinks, household items for the weekly shop. Returns product names, prices, and IDs that can be added to basket.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term (e.g., "milk", "bread", "chicken")' },
          limit: { type: 'number', description: 'Maximum number of results (default: 12)', default: 12 },
        },
        required: ['query'],
      },
    },
    {
      name: 'sainsburys_basket',
      description: 'Manage the Sainsbury\'s shopping basket for the weekly food shop. Also works when an order is in amend mode — the amended order acts as the basket. IMPORTANT: If there is an active order (shown by sainsburys_basket), you MUST call sainsburys_order_amend FIRST before adding items. Adding to the basket without amending will NOT modify the active order. After adding items, the user MUST checkout (sainsburys_checkout) to confirm the changes — this applies to both fresh baskets and amended orders. The default "view" action is also what users mean when they say "check my basket", "check basket", "review my shop", or "anything missing?". It automatically refreshes shopping habits from order history, then cross-references the current basket and any active order against the shopping list and past purchases. Returns: (1) active order summary, (2) current basket contents with full pricing, (3) shopping list items marked as covered or missing, (4) frequently bought products not in the current order with product IDs. The caller should semantically match missing shopping list items to frequently bought products (e.g. "cheese" matches "Sainsbury\'s Mature Cheddar 400g") and suggest them to the user with product IDs so they can be added via sainsburys_basket. IMPORTANT: Show ALL uncovered frequently bought products returned — do not filter or cherry-pick. IMPORTANT: If an active order exists and the user wants to add items, you MUST call sainsburys_order_amend FIRST to enter amend mode before calling sainsburys_basket. The active order is NOT a basket — it must be explicitly amended before modifications.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['view', 'add', 'remove', 'clear'], description: 'Action to perform: "view" (default) shows basket contents, "add" adds a product, "remove" removes a product, "clear" removes all items. IMPORTANT: For "clear", you MUST confirm with the user before executing — this is destructive and cannot be undone.', default: 'view' },
          product_id: { type: 'string', description: 'Product ID — required for "add" and "remove"' },
          quantity: { type: 'number', description: 'Quantity to add (default: 1) — used with "add"', default: 1 },
        },
      },
    },
    {
      name: 'sainsburys_slots',
      description: 'List, book, or change Sainsbury\'s grocery delivery slots for the weekly food shop. Uses browser automation, may take 10-15 seconds. Use action "list" to view available slots, "book" to reserve one, or "change" to change an existing reserved slot. Reserving a slot is separate from checkout — after reserving, the user still needs to checkout (sainsburys_checkout) before the reservation expires to complete the order. IMPORTANT: Check sainsburys_basket first — if the basket already has a delivery slot reserved, do NOT book another one — use "change" instead. The basket response will show if a slot is already reserved and when the reservation expires.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'book', 'change'], description: 'Action to perform: "list" (default) shows available slots, "book" reserves a slot, "change" changes an existing reserved slot.', default: 'list' },
          slot_id: { type: 'string', description: 'Slot ID — required for "book", optional for "change" (omit to see available slots first). Format: "Day Date|StartTime" e.g. "Saturday 7th March|6:30 AM"' },
        },
      },
    },
    {
      name: 'sainsburys_checkout',
      description: 'Start the checkout flow for the current basket. Opens a visible browser window and walks through the Sainsbury\'s checkout. IMPORTANT: This tool NEVER completes payment automatically. In dry_run mode (default) it only previews the basket. With dry_run=false it navigates to the payment page and then STOPS — the user must complete payment manually in the browser window. Requires minimum £25 basket spend. If MFA is required, returns mfa_required status — use sainsburys_login with the code to continue. IMPORTANT: Checkout is REQUIRED after adding items to a basket or after amending an order — items are not confirmed until checkout is completed.',
      inputSchema: {
        type: 'object',
        properties: {
          dry_run: { type: 'boolean', description: 'If true (default), preview only — no slot booking or payment. If false, proceed through checkout to payment page.', default: true },
        },
      },
    },
    {
      name: 'sainsburys_orders',
      description: 'View Sainsbury\'s order history or a specific order. Without order_uid, returns recent orders with status, totals, and delivery slot info. With order_uid, returns full order details including all items.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum number of orders to return (default: 10)', default: 10 },
          order_uid: { type: 'string', description: 'Order UID to view details for. If provided, returns full order with items instead of the list.' },
        },
      },
    },
    {
      name: 'sainsburys_order_amend',
      description: 'Enter or cancel amend mode for a placed order. Use action "amend" (default) to enter amend mode — this turns the order into a logical basket so you can add/remove items using the basket tools. Use action "cancel" to discard ALL changes made during the amend session and revert the order to its original state — use this when the user wants to undo/discard/cancel their amendments. Only works on scheduled orders before cutoff. IMPORTANT: You MUST call this with action "amend" before using sainsburys_basket with action "add" or "remove" if the user wants to modify an active order. Without amending first, basket changes will NOT affect the order. After making changes, the user MUST checkout (sainsburys_checkout) to confirm the amended order — amendments are time-limited. To cancel/discard/undo amendments instead of checking out, call this tool with action "cancel".',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['amend', 'cancel'], description: 'Action to perform: "amend" (default) enters amend mode, "cancel" discards changes and reverts the order to its original state.', default: 'amend' },
          order_uid: { type: 'string', description: 'Order UID to amend. If not provided, amends the active (most recent scheduled) order.' },
        },
      },
    },
    {
      name: 'sainsburys_list',
      description: 'Show the current offline shopping list. This list is stored locally and does not interact with Sainsbury\'s.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['show', 'add', 'remove', 'clear'], description: 'Action to perform. Defaults to "show" if omitted.', default: 'show' },
          description: { type: 'string', description: 'Item description — required for "add" (e.g., "semi skimmed milk", "6 free range eggs")' },
          quantity: { type: 'number', description: 'Quantity — optional, used with "add"' },
          notes: { type: 'string', description: 'Notes — optional, used with "add" (e.g., "from bakery section")' },
          item_id: { type: 'string', description: 'Item ID — required for "remove" (get from sainsburys_list)' },
        },
      },
    },
  ],
}));


// ─── Tool routing ──────────────────────────────────────────

function text(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }] };
}

/** Map of tool name → handler. Each returns { text } from handlers.ts. */
const toolHandlers: Record<string, (args: any) => Promise<{ text: string }> | { text: string }> = {
  sainsburys_login: (args) => handleLogin(args),
  sainsburys_search: (args) => handleSearch(args),
  sainsburys_basket: (args) => handleBasket(args),
  sainsburys_slots: (args) => handleSlots(args),
  sainsburys_checkout: (args) => handleCheckout(args),
  sainsburys_orders: (args) => handleOrders(args),
  sainsburys_order_amend: (args) => handleAmendOrder(args),
  sainsburys_list: (args) => handleList(args),
};

// Tools that don't require auth
const noAuthTools = new Set(['sainsburys_login', 'sainsburys_list', 'sainsburys_checkout']);

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const handler = toolHandlers[name];
    if (!handler) return text(`❌ Unknown tool: ${name}`);

    // Auth gate
    if (!noAuthTools.has(name) && !isLoggedIn()) {
      return text('❌ Not logged in. Use sainsburys_login first.');
    }

    const result = await handler(args || {});
    return text(result.text);
  } catch (error: any) {
    return { content: [{ type: 'text', text: `❌ Error: ${error.message}` }], isError: true };
  }
});

// ─── Start ─────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Sainsbury\'s CLI MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
