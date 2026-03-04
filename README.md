<div align="center">

🛒

# sainsburys-cli-mcp

**Unofficial CLI + MCP server for Sainsbury's grocery shopping, built for AI agents.**
Search products, manage baskets, book delivery slots, and checkout — via CLI or Model Context Protocol.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

[Quick Start — CLI](#quick-start--cli) • [Quick Start — MCP](#quick-start--mcp) • [CLI Commands](#cli-commands) • [MCP Tools](#mcp-server) • [Agent Integration](#agent-integration)

</div>

---

## Why

UK supermarkets offer zero developer APIs. No OAuth, no REST endpoints, no webhooks. If you want your AI agent to shop for groceries, there's no official way to do it.

**sainsburys-cli-mcp closes that gap.** Reverse-engineered API integrations + browser automation give your agent a clean interface to Sainsbury's. Your agent calls `sains search "milk"` and it works. Built as both a CLI and an MCP server so it plugs into any agent framework.

It also learns your shopping habits from order history and maintains a local shopping list. When you view your basket, it automatically cross-references against your list and past purchases — surfacing missing items and things you frequently buy but haven't added yet.

## Quick Start — CLI

```bash
git clone https://github.com/dangarfield/sainsburys-cli-mcp.git
cd sainsburys-cli-mcp
pnpm install
npx playwright install chromium

# Login (opens browser, may require SMS MFA)
pnpm sains login --email YOUR_EMAIL --password YOUR_PASSWORD

# Test it
pnpm sains search "milk"
pnpm sains basket
```

## Quick Start — MCP

```bash
# Build first
pnpm run build
```

Add to your MCP config (e.g. `.kiro/settings/mcp.json` or `~/.kiro/settings/mcp.json`):

```json
{
  "mcpServers": {
    "sainsburys-cli-mcp": {
      "command": "node",
      "args": ["dist/mcp-server.js"],
      "cwd": "/path/to/sainsburys-cli-mcp"
    }
  }
}
```

Then use `sainsburys_login`, `sainsburys_search`, `sainsburys_basket`, etc. from your agent.

## How It Works

All commands flow through a single code path:

```
Handler (commands/handlers.ts) → CLI (sains) → MCP (sainsburys_*)
```

Under the hood, the Sainsbury's provider uses:
- **REST API** for search, basket, orders, profile
- **Browser automation** (Playwright) for login, delivery slots, checkout
- **Auto-relogin** on 401/403 using saved credentials


## CLI Commands

All commands use `pnpm sains <command>`.

### Authentication

```bash
sains login --email <email> --password <pass>   # Login (saves session + credentials)
sains login --code <6-digit-code>               # Submit MFA code
sains login --logout                            # Logout and wipe local data
```

### Search

```bash
sains search "milk"                # Search products
sains search "organic eggs" -l 5   # Limit results
```

### Basket

```bash
sains basket                       # View basket (includes slot, shopping list, habits)
sains basket add <product-id>      # Add product
sains basket add <product-id> -q 3 # Add with quantity
sains basket remove <product-id>   # Remove product (accepts product_uid or item_uid)
sains basket clear                 # Remove all items
```

### Delivery Slots

```bash
sains slots                        # List available slots
sains slots book <slot-id>         # Reserve a slot
sains slots change                 # Change existing slot (shows available)
sains slots change <slot-id>       # Change to specific slot
```

Slot IDs use the format: `"Saturday 7th March|6:30 AM"`

### Checkout

```bash
sains checkout                     # Checkout (dry-run by default)
sains checkout --dry-run           # Preview only
```

Checkout opens a visible browser. It never completes payment automatically — the user must finish payment manually.

### Orders

```bash
sains orders                       # List recent orders
sains orders --limit 5             # Limit results
sains orders <order-uid>           # View specific order with all items
```

### Order Amend

```bash
sains amend-order                  # Amend most recent scheduled order
sains amend-order <order-uid>      # Amend specific order
```

After amending, use basket commands to modify items, then checkout to confirm.

### Shopping List (Offline)

```bash
sains list                         # Show list
sains list add semi skimmed milk   # Add item
sains list add bread -q 2          # Add with quantity
sains list add eggs -n "free range" # Add with notes
sains list remove <item-id>        # Remove item
sains list clear                   # Clear list
```

The shopping list is local only (`~/.sainsburys/shopping-list.json`). The `basket` view command cross-references it against your basket and purchase history.

## MCP Server

The CLI also runs as an MCP server for use with Claude Desktop, Kiro, or any MCP-compatible agent.

### Tools

| Tool | Description |
|------|-------------|
| `sainsburys_login` | Login, logout, or submit MFA code |
| `sainsburys_search` | Search products |
| `sainsburys_basket` | View, add, remove, or clear basket |
| `sainsburys_slots` | List, book, or change delivery slots |
| `sainsburys_checkout` | Checkout (dry-run or real) |
| `sainsburys_orders` | List orders or view specific order details |
| `sainsburys_order_amend` | Enter amend mode for a placed order |
| `sainsburys_list` | Manage offline shopping list |

## Agent Integration

Your agent calls CLI commands or MCP tools. The CLI handles auth, API calls, and basket state. Your agent handles the intelligence.

### Any Agent (Bash)

```typescript
// Search and add to basket
const output = await bash("pnpm sains search 'chicken breast'");
await bash("pnpm sains basket add 357937 -q 2");

// Review basket (includes habits + shopping list check)
await bash("pnpm sains basket");

// Book slot and checkout
await bash('pnpm sains slots book "Saturday 7th March|6:30 AM"');
await bash("pnpm sains checkout");
```

### MCP (Claude Desktop / Kiro)

The MCP server exposes the same functionality as tools. Your agent calls `sainsburys_search`, `sainsburys_basket`, `sainsburys_slots`, etc. directly — no bash needed.

### OpenClaw / Skills-Based Agents

Copy to your skills directory. The `SKILL.md` frontmatter tells the agent when to activate:

```bash
cp -r sainsburys-cli-mcp /path/to/agent/skills/
```

The agent loads the skill when users mention their basket, shopping list, delivery slots, orders, or Sainsbury's.

### Slack Bots (Pi / Mom)

Call CLI commands from your bot, then render results with Block Kit:

```typescript
// In your Slack bot handler
const basket = await bash("pnpm sains basket");
await sendBlocks([{
  type: "section",
  text: { type: "mrkdwn", text: `*🛒 Your Basket*\n${basket}` }
}]);
```

### Automated Weekly Shopping

The real power is the full loop. Throughout the week, tell your agent what you need in plain language:

> "Add Dan's deodorant"
> "We need honey for cereal"
> "Running low on bananas"

Your agent adds these to the local shopping list via `sainsburys_list`. They don't need to be exact product names.

When it's time to order, your agent (you can schedule it):
1. Views the basket (`sainsburys_basket`) — this pulls in your shopping list, order history, and frequently bought items
2. Matches shopping list entries to real products by searching and suggests them to you
3. Adds approved items to the basket
4. Flags anything from your usual shop that's missing
5. Books a delivery slot and checks out

If you forget something after ordering, amend the order (`sainsburys_order_amend`), add the item, and checkout again.

### Error Handling

The CLI auto-relogins on 401/403 using saved credentials. If MFA is needed, it returns `mfa_required` — submit the code via `pnpm sains login --code <code>` and the interrupted operation resumes.

## Smart Shopping

The `basket` view command automatically:
1. Refreshes shopping habits from order history
2. Cross-references basket against your shopping list
3. Shows frequently bought items not in the current order

Your agent can use this to suggest missing items and build smarter shopping lists.

## Local Data

All local data stored in `~/.sainsburys/`:

| File | Purpose |
|------|---------|
| `session.json` | Browser session cookies |
| `credentials.json` | Saved email/password for auto-relogin |
| `shopping-list.json` | Offline shopping list |
| `habits.json` | Learned shopping habits |
| `history.json` | Cached order history |

## Project Structure

```
sainsburys-cli-mcp/
├── src/
│   ├── providers/
│   │   ├── types.ts           # Common interface
│   │   ├── sainsburys.ts      # Sainsbury's provider
│   │   ├── ocado.ts           # Ocado provider (stub)
│   │   └── index.ts           # Provider factory
│   ├── auth/login.ts          # Playwright authentication
│   ├── config/credentials.ts  # Credentials management
│   ├── shopping-list/manager.ts # Shopping list, habits, basket check
│   ├── browser/
│   │   ├── session.ts         # Browser session management + auto-login
│   │   ├── slots.ts           # Delivery slot browser automation
│   │   ├── checkout.ts        # Checkout browser automation
│   │   └── orders.ts          # Order history scraping
│   ├── commands/handlers.ts   # All command logic (shared by CLI + MCP)
│   ├── cli.ts                 # CLI entry point
│   └── mcp-server.ts          # MCP server entry point
└── SKILL.md                   # Open skills format
```

## Authentication Notes

- Login uses Playwright browser automation
- SMS MFA is required on new logins — pass the code via `sains login --code 123456`
- Sessions last ~7 days, then auto-relogin kicks in using saved credentials
- Logging in on the Sainsbury's website invalidates the CLI session tokens, but the CLI auto-relogins when needed
- Session stored in `~/.sainsburys/session.json`
- `wcauthtoken` extracted automatically from cookies for API auth

## Payment & Security

- Checkout uses your saved payment method from your Sainsbury's account
- No card details ever touch the CLI
- The CLI never completes payment — it navigates to the payment page and stops
- Session files are git-ignored

## Known Limitations

- **Sainsbury's only** — Ocado/Tesco not yet implemented
- **UK only** — Sainsbury's delivery areas, uses your existing preferred location
- **MFA required** on every new login (SMS code)
- **Checkout** needs proper implementation (basic flow works)
- **Order amend discard** — no way to cancel an amend yet (API endpoint unknown)

## Development

```bash
pnpm install
pnpm run build
pnpm sains search "milk"
```

## License

MIT

---

<div align="center">

**Built by [zish](https://github.com/abracadabra50)**
**Built by [dangarfield](https://github.com/dangarfield)**

</div>
