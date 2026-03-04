---
name: sainsburys-cli-mcp
description: Unofficial Sainsbury's grocery CLI + MCP server. Search products, manage basket, book delivery, and checkout. Built for AI agents.
license: MIT
compatibility: Node.js 18+, TypeScript, Playwright for auth. UK only (Sainsbury's delivery areas).
metadata:
  author: dangarfield
  version: "2.0.0"
  repository: https://github.com/dangarfield/sainsburys-cli-mcp
  tags: [groceries, sainsburys, uk, shopping, automation, cli, mcp, agent-tool]
allowed-tools: Bash({baseDir}/node:*), Bash(pnpm:run:sains:*)
---

# Unofficial Sainsbury's CLI + MCP

CLI + MCP server for Sainsbury's UK grocery automation. Built for AI agents.

**Location:** `{baseDir}`

---

## When to Use This Skill

Trigger when users:
- Want to plan meals or discuss recipes
- Need to order groceries or check prices
- Want to manage their Sainsbury's basket
- Need to book delivery slots or checkout
- Ask "what's for dinner?" or "plan my weekly shop"
- Want to check or amend an existing order

---

## Setup

```bash
cd {baseDir}
pnpm install
npx playwright install chromium
pnpm sains login --email USER@EMAIL.COM --password PASSWORD
```

---

## CLI Commands

```bash
# Search
pnpm sains search "milk"
pnpm sains search "organic eggs" -l 5

# Basket
pnpm sains basket                          # View (includes habits, shopping list, slot)
pnpm sains basket add <product-id>         # Add
pnpm sains basket add <product-id> -q 3    # Add with quantity
pnpm sains basket remove <product-id>      # Remove
pnpm sains basket clear                    # Clear all

# Delivery slots
pnpm sains slots                           # List available
pnpm sains slots book <slot-id>            # Reserve
pnpm sains slots change                    # Change existing

# Checkout
pnpm sains checkout                        # Dry-run (default)
pnpm sains checkout --dry-run              # Preview only

# Orders
pnpm sains orders                          # List recent
pnpm sains orders <order-uid>              # View specific order with items

# Amend order
pnpm sains amend-order                     # Amend most recent
pnpm sains amend-order <order-uid>         # Amend specific

# Shopping list (offline)
pnpm sains list                            # Show
pnpm sains list add semi skimmed milk      # Add
pnpm sains list remove <item-id>           # Remove
pnpm sains list clear                      # Clear

# Auth
pnpm sains login --email E --password P    # Login
pnpm sains login --code 123456             # Submit MFA
pnpm sains login --logout                  # Logout + wipe data
```

---

## MCP Tools

`sainsburys_login`, `sainsburys_search`, `sainsburys_basket`, `sainsburys_slots`, `sainsburys_checkout`, `sainsburys_orders`, `sainsburys_order_amend`, `sainsburys_list`.

---

## Error Handling

- **Session expired**: Auto-relogin using saved credentials
- **MFA required**: Returns `mfa_required` — submit code via `sains login --code`
- **Product not found**: Try alternative search terms
- **Out of stock**: Suggest substitutes

---

## License

MIT
