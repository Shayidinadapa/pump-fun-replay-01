// Pump.fun Replay Sprint — deterministic paper bot (agent-fun/replay/v2).
//
// Strategy, in one paragraph: ride the early pump, never marry a coin.
// A new bonding curve usually pumps hard in its first minutes and then bleeds
// back down (in the dev window the median coin ends below the price of its
// first trade, while its median peak is +34%). So the bot only buys a coin
// that is *already* moving up with buy-side dominance, buys a small tranche
// capped at 1% of the coin's real SOL reserve, pyramids at most twice more
// while the move keeps going, and exits on a fixed take-profit, a fixed
// stop-loss, a trailing stop once the trade is in profit, or a staleness
// rule when the coin stops moving. No clock, no randomness, no network:
// every decision is a pure function of the batches the harness delivered,
// so two runs on the same data produce the same action log.
//
// Fees are ~1.25% of size per side (95 bps protocol + 30 bps creator) plus a
// flat tx fee per order, so a round trip costs roughly 3%: the take-profit
// (+25%) and stop-loss (-12%) are set well outside that band.

import { runBot, type Batch, type BotState, type OrderInput } from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------------------
// Tunables (all in plain units; lamports are converted at the use site).

const LAMPORTS_PER_SOL = 1_000_000_000n;
const sol = (x: number): bigint => BigInt(Math.round(x * 1_000_000_000));

// Entry: a coin must have enough history and size to be worth a trade.
const MIN_TRADES = 8; // trades seen before the coin may be bought
const MIN_REAL_SOL = 2; // real SOL reserves needed (max buy is 1% of them)
const MOMENTUM_TRADES = 10; // look-back window for the entry momentum check
const MOMENTUM_MIN = 1.06; // price must be up >= 6% over the window
const BUY_SHARE_MIN = 0.6; // >= 60% of the window's trades must be buys
const BUY_VOLUME_MIN = 0.55; // >= 55% of the window's SOL volume must be buys
const MAX_RUNUP = 2.0; // never chase a coin already 2x its early price
const RUNUP_TRADES = 20; // look-back window for the run-up check

// Sizing: one tranche per buy, at most this much, never below the guardrail.
const TARGET_BUY_SOL = 0.2;
const MIN_BUY_SOL = 0.02; // round trips must be >= 0.01 SOL; stay above it
const MAX_TRANCHES = 3; // initial buy + up to 2 pyramids
const PYRAMID_GAIN = 1.08; // pyramid only once the position is up >= 8%
const PYRAMID_MOMENTUM = 1.03; // ...and still rising >= 3% over the window
const PYRAMID_MAX_GAIN = 1.3; // ...but not once it is up >= 30% already
const PYRAMID_MIN_TRADES = 10; // trades between tranches on the same coin

// Exits.
const TAKE_PROFIT = 1.25; // sell everything at +25%
const STOP_LOSS = 0.88; // sell everything at -12%
const TRAIL_ARM = 1.1; // trailing stop arms once the trade is up >= 10%
const TRAIL_DROP = 0.9; // ...then sells on a 10% pullback from the peak
const STALE_TRADES = 150; // trades with no profit after entry -> exit
const STALE_MAX_GAIN = 1.05;
const MAX_HOLD_SLOTS = 40000; // hard cap on holding time (~4.5h of slots)

// Behaviour.
const COOLDOWN_SLOTS = 3000; // do not rebuy a coin shortly after selling it
const MAX_SLIPPAGE_BPS = 500; // 5% slippage guard on every order
const RECENT_MAX = 24; // trades of history kept per coin

// ---------------------------------------------------------------------------
// Per-coin state. Only the last RECENT_MAX trades are kept, so memory stays
// flat no matter how long the replay runs.

interface TradeTick {
  price: number; // lamports of SOL per token (virtual reserves ratio)
  buy: boolean;
  vol: bigint; // SOL amount of the trade, in lamports
}

interface Coin {
  mint: string;
  trades: number;
  firstPrice: number;
  lastPrice: number;
  recent: TradeTick[];
  complete: boolean;
  lastSellSlot: number;
  // Position bookkeeping, filled in from the harness's own fill reports.
  entryPrice: number; // effective lamports per token, fees included
  entrySlot: number;
  entryTrades: number;
  peakSinceEntry: number;
  tranches: number;
  lastBuyTrades: number;
  pendingBuy: boolean;
  pendingSell: boolean;
}

function newCoin(mint: string): Coin {
  return {
    mint,
    trades: 0,
    firstPrice: 0,
    lastPrice: 0,
    recent: [],
    complete: false,
    lastSellSlot: -1,
    entryPrice: 0,
    entrySlot: 0,
    entryTrades: 0,
    peakSinceEntry: 0,
    tranches: 0,
    lastBuyTrades: -1_000_000,
    pendingBuy: false,
    pendingSell: false,
  };
}

const coins = new Map<string, Coin>();

function coinFor(mint: string): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = newCoin(mint);
    coins.set(mint, c);
  }
  return c;
}

/** Price of a curve from its virtual reserves: SOL lamports per token. */
function curvePrice(state: BotState, mint: string): number {
  const c = state.curves.get(mint);
  if (c === undefined) return 0;
  const tok = Number(c.virtual_token_reserves);
  const solRes = Number(c.virtual_quote_reserves);
  if (tok <= 0 || solRes <= 0) return 0;
  return solRes / tok;
}

/** Price N trades ago inside the coin's recent window, or -1 if unknown. */
function priceAgo(c: Coin, n: number): number {
  const idx = c.recent.length - 1 - n;
  if (idx < 0) return -1;
  return c.recent[idx].price;
}

/** Share of buys (by count and by SOL volume) over the last `n` trades. */
function buyPressure(c: Coin, n: number): { countShare: number; volShare: number } {
  const window = c.recent.slice(-n);
  if (window.length === 0) return { countShare: 0, volShare: 0 };
  let buys = 0;
  let buyVol = 0n;
  let totalVol = 0n;
  for (const t of window) {
    if (t.buy) {
      buys++;
      buyVol += t.vol;
    }
    totalVol += t.vol;
  }
  return {
    countShare: buys / window.length,
    volShare: totalVol > 0n ? Number(buyVol) / Number(totalVol) : 0,
  };
}

/** Size of one buy tranche on this coin right now, or 0n when too small. */
function trancheSize(state: BotState, mint: string): bigint {
  const cap = state.maxBuyLamports(mint);
  if (cap <= 0n) return 0n;
  const want = sol(TARGET_BUY_SOL);
  const size = want < cap ? want : cap;
  return size >= sol(MIN_BUY_SOL) ? size : 0n;
}

// ---------------------------------------------------------------------------
// The strategy: one function per batch, pure in the harness data.

async function onBatch(state: BotState, batch: Batch): Promise<OrderInput[]> {
  const orders: OrderInput[] = [];

  // 1. Fold in the fills the harness reports: they are the only source of
  //    truth for what we paid, what we hold, and what got rejected.
  for (const fill of batch.fills) {
    const c = coins.get(fill.mint);
    if (c === undefined) continue;
    if (fill.client_id.startsWith("_")) {
      // A harness close (complete / flatten / writeoff): the position is gone.
      c.entryPrice = 0;
      c.tranches = 0;
      c.pendingBuy = false;
      c.pendingSell = false;
      if (fill.side === "sell") c.lastSellSlot = batch.slot;
      continue;
    }
    if (fill.side === "buy") {
      if (fill.status === "filled") {
        const tokens = BigInt(fill.token_amount);
        const paid = BigInt(fill.quote_lamports);
        if (tokens > 0n && paid > 0n) {
          c.entryPrice = Number(paid) / Number(tokens);
          c.entrySlot = batch.slot;
          c.entryTrades = c.trades;
          c.peakSinceEntry = c.lastPrice > 0 ? c.lastPrice : c.entryPrice;
          c.tranches += 1;
          c.lastBuyTrades = c.trades;
        }
      }
      c.pendingBuy = false;
    } else {
      if (fill.status === "filled") {
        c.entryPrice = 0;
        c.tranches = 0;
        c.lastSellSlot = batch.slot;
      }
      c.pendingSell = false;
    }
  }

  // 2. Fold in this batch's events and remember which mints moved.
  const moved = new Set<string>();
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      const c = coinFor(e.mint);
      moved.add(e.mint);
      continue;
    }
    if (e.event === "TradeEvent") {
      const c = coinFor(e.mint);
      const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      if (Number.isFinite(price) && price > 0) {
        if (c.firstPrice === 0) c.firstPrice = price;
        c.lastPrice = price;
        c.recent.push({ price, buy: e.is_buy, vol: BigInt(e.sol_amount) });
        if (c.recent.length > RECENT_MAX) c.recent.splice(0, c.recent.length - RECENT_MAX);
      }
      c.trades += 1;
      moved.add(e.mint);
      continue;
    }
    if (e.event === "CompleteEvent") {
      const c = coinFor(e.mint);
      c.complete = true;
      moved.add(e.mint);
    }
  }

  // 3. Exits first: free the position slots before deciding on new buys.
  for (const [mint, holding] of state.positions) {
    const c = coins.get(mint);
    if (c === undefined || c.pendingSell || c.entryPrice <= 0) continue;
    const price = curvePrice(state, mint);
    if (price <= 0) continue;
    if (price > c.peakSinceEntry) c.peakSinceEntry = price;
    const gain = price / c.entryPrice;
    const sinceEntry = c.trades - c.entryTrades;
    const ageSlots = batch.slot - c.entrySlot;
    let exit = false;
    if (gain >= TAKE_PROFIT) exit = true; // bank the winner
    else if (gain <= STOP_LOSS) exit = true; // cut the loser
    else if (c.peakSinceEntry >= c.entryPrice * TRAIL_ARM && price <= c.peakSinceEntry * TRAIL_DROP) exit = true; // trailing stop
    else if (sinceEntry >= STALE_TRADES && gain < STALE_MAX_GAIN) exit = true; // dead money
    else if (ageSlots >= MAX_HOLD_SLOTS) exit = true; // hard time cap
    if (!exit) continue;
    orders.push({
      side: "sell",
      mint,
      token_amount: holding.token_amount,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    c.pendingSell = true;
  }

  // 4. Entries and pyramids, only on coins that traded in this batch, only
  //    while a position slot and cash are free.
  const maxPositions = state.hello.caps.max_open_positions;
  for (const mint of moved) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    const c = coins.get(mint);
    if (c === undefined || c.complete || c.pendingBuy || c.pendingSell) continue;
    if (c.trades < MIN_TRADES || c.recent.length < MOMENTUM_TRADES) continue;
    if (c.lastPrice <= 0) continue;
    if (batch.slot - c.lastSellSlot < COOLDOWN_SLOTS) continue;

    const curve = state.curves.get(mint);
    if (curve === undefined) continue;
    if (curve.real_quote_reserves < sol(MIN_REAL_SOL)) continue;

    const ago = priceAgo(c, MOMENTUM_TRADES);
    if (ago <= 0) continue;
    const momentum = c.lastPrice / ago;
    const pressure = buyPressure(c, MOMENTUM_TRADES);
    const base = priceAgo(c, RUNUP_TRADES);
    const refPrice = base > 0 ? base : c.firstPrice;
    if (refPrice > 0 && c.lastPrice / refPrice > MAX_RUNUP) continue; // too late

    const held = state.positions.get(mint);
    if (held !== undefined) {
      // Pyramid: only into a winner that is still rising, at most twice.
      if (c.entryPrice <= 0 || c.tranches >= MAX_TRANCHES) continue;
      if (c.trades - c.lastBuyTrades < PYRAMID_MIN_TRADES) continue;
      if (c.lastPrice < c.entryPrice * PYRAMID_GAIN) continue;
      if (c.lastPrice > c.entryPrice * PYRAMID_MAX_GAIN) continue;
      if (momentum < PYRAMID_MOMENTUM) continue;
      if (pressure.countShare < BUY_SHARE_MIN) continue;
    } else {
      // Fresh entry: momentum + buy dominance, with a free position slot.
      // The move must still be going, not already reversing: the price over
      // the last 5 trades must also be up.
      if (state.committedPositionCount() >= maxPositions) continue;
      if (momentum < MOMENTUM_MIN) continue;
      const ago5 = priceAgo(c, 5);
      if (ago5 > 0 && c.lastPrice / ago5 < 1.02) continue;
      if (pressure.countShare < BUY_SHARE_MIN) continue;
      if (pressure.volShare < BUY_VOLUME_MIN) continue;
    }

    const size = trancheSize(state, mint);
    if (size <= 0n) continue;
    const free = state.freeCashLamports();
    if (free < size + state.txFeeLamports()) continue;
    orders.push({
      side: "buy",
      mint,
      quote_lamports: size,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    c.pendingBuy = true;
  }

  return orders;
}

await runBot({ onBatch });
