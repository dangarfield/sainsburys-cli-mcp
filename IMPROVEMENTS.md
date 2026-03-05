# Code Improvements

Critical review of the codebase. Items marked DONE have been fixed.

---

## DONE - Pervasive `as any` Type Erosion

Handlers now import `SainsburysProvider` directly and `getProvider()` returns the concrete type. Removed all `as any` casts on the provider in `handlers.ts`.

## DONE - Version Mismatch

`cli.ts` and `mcp-server.ts` now both report `3.0.0`, matching `package.json`.

## DONE - Checkout Tool in `noAuthTools` Set

Removed `sainsburys_checkout` from `noAuthTools`. All tools except `sainsburys_login` and `sainsburys_list` now require auth.

## DONE - Inconsistent Error Messages Reference Wrong Tool Names

Fixed all references from `grocery_login`/`groc` to `sainsburys_login`/`sains`.

## DONE - Duplicate `isDebugMode()` and `CONFIG_DIR` / Path Constants

Created `src/config/paths.ts` with all shared constants (`CONFIG_DIR`, `SESSION_FILE`, `CREDENTIALS_FILE`, `SHOPPING_LIST_FILE`, `HABITS_FILE`, `ORDER_HISTORY_FILE`) plus `isDebugMode()` and `ensureConfigDir()`. Updated all 7 files that previously defined these independently.

## DONE - `dotenv` Loaded But Not Used

Removed `import 'dotenv/config'` from `cli.ts` and removed `dotenv` from `package.json` dependencies.

## DONE - `package-lock.json` Alongside `pnpm`

Deleted `package-lock.json`. Project uses pnpm exclusively.

---

## Remaining (not addressed)

### Dead / Unused Code

- `src/api/client.ts` is never imported. 222 lines of dead code duplicating `SainsburysProvider`.
- `src/providers/ocado.ts` is a stub that throws on login. Registered in factory but never selectable.
- `compareProduct()` and `createAll()` in `providers/index.ts` are never called.
- `checkBasket()` in `ShoppingListManager` is never called (duplicated inline in `handleBasket`).
- `loadSession()`, `getCookieString()`, `clearSession()` in `auth/login.ts` are never imported.

### Provider Creates a New Instance on Every Call

Every handler call constructs a new `SainsburysProvider` (new axios instance, re-reads session, new interceptor). Should be a singleton or cached.

### Sequential Basket Clear

Removes items one at a time (~2N API calls). The PUT endpoint accepts multiple items in one call.

### `handleBasket` View is a God Function

130 lines mixing data fetching, business logic, and presentation. Should be decomposed.

### `waitForTimeout` Anti-Pattern

~29 instances of arbitrary timing delays across browser automation. Should use condition-based waits.

### Fragile Regex-Based Checkout Parsing

Checkout total extracted by regex from page body text. Silently produces `total: 0` on HTML changes.

### No Graceful Shutdown

No SIGTERM/SIGINT handler. Chromium processes leak if killed while browser is parked for MFA.

### Hardcoded Store Number Default

`storeNumber` defaults to `'0560'`. Should be derived from user session/address.

### No Tests

Zero test coverage for a tool handling real purchases.

### No Input Validation on MCP Tool Arguments

Tool arguments passed directly to handlers with no runtime validation.

### Sensitive Data Logging

Credentials file path and URLs with potential session tokens logged to console.
