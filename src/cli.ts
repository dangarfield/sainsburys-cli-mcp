#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import {
  handleLogin,
  handleSearch,
  handleBasket,
  handleSlots,
  handleCheckout,
  handleOrders,
  handleAmendOrder,
  handleList,
} from './commands/handlers.js';

const program = new Command();

program
  .name('sains')
  .description('Sainsbury\'s grocery CLI + MCP server')
  .version('2.0.0');

function run(fn: () => Promise<any>) {
  fn().then(result => {
    console.log(result.text);
  }).catch(err => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}

program
  .command('login')
  .description('Login to Sainsbury\'s account (use --logout to log out, --code for MFA)')
  .option('-e, --email <email>', 'Email address')
  .option('-p, --password <password>', 'Password')
  .option('--logout', 'Log out instead of logging in')
  .option('-c, --code <code>', 'Submit 6-digit MFA code')
  .action((options) => run(async () => {
    const result = await handleLogin({ email: options.email, password: options.password, logout: options.logout, code: options.code });
    if (!result.success) process.exitCode = 1;
    return result;
  }));

program
  .command('search <query>')
  .description('Search for products')
  .option('-l, --limit <number>', 'Max results', '12')
  .action((query, options) => run(() => handleSearch({ query, limit: parseInt(options.limit, 10) })));

program
  .command('basket [action] [product-id]')
  .description('Manage basket: view (default), add <product-id>, remove <product-id>, clear')
  .option('-q, --qty <number>', 'Quantity (for add)', '1')
  .action((action, productId, options) => run(() =>
    handleBasket({ action: action || 'view', product_id: productId, quantity: parseInt(options.qty, 10) })
  ));

program
  .command('slots [action] [slot-id]')
  .description('Manage delivery slots: list (default), book <slot-id>, change [slot-id]')
  .action((action, slotId) => run(() => handleSlots({ action: action || 'list', slot_id: slotId })));

program
  .command('checkout')
  .description('Complete order and checkout')
  .option('--dry-run', 'Preview without placing order')
  .action((options) => run(() => handleCheckout({ dry_run: options.dryRun ? true : undefined })));

program
  .command('orders [order-uid]')
  .description('View order history, or a specific order with full item details')
  .option('--limit <number>', 'Max orders to show', '10')
  .action((orderUid, options) => run(() => handleOrders({ order_uid: orderUid, limit: parseInt(options.limit, 10) })));

program
  .command('amend-order [action] [order-uid]')
  .description('Amend a placed order: amend (default) or cancel to discard changes')
  .action((action, orderUid) => {
    // If first arg looks like a UID (not 'amend' or 'cancel'), treat it as order_uid
    if (action && action !== 'amend' && action !== 'cancel') {
      orderUid = action;
      action = 'amend';
    }
    return run(() => handleAmendOrder({ action: action || 'amend', order_uid: orderUid }));
  });

program
  .command('list [action] [args...]')
  .description('Manage shopping list: show (default), add <description>, remove <id>, clear')
  .option('-q, --qty <number>', 'Quantity (for add)')
  .option('-n, --notes <text>', 'Notes (for add)')
  .action((action, actionArgs, options) => {
    try {
      const resolvedAction = action || 'show';
      const result = handleList({
        action: resolvedAction,
        description: resolvedAction === 'add' ? actionArgs.join(' ') : undefined,
        quantity: options.qty ? parseInt(options.qty, 10) : undefined,
        notes: options.notes,
        item_id: resolvedAction === 'remove' ? actionArgs[0] : undefined,
      });
      console.log(result.text);
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
