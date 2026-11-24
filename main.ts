// Pump.fun Replay Sprint — deterministic paper bot (agent-fun/replay/v2).
//
// Strategy, in one paragraph: snipe the very first buying, in tiny size,
// with a hard budget on how many round trips the bot will ever take.
//
// Why this shape: in the dev window the median coin ends below the price of
// its first trade while its median peak is +34%, and a round trip costs
// roughly 3% (95 bps protocol + 30 bps creator fees per side, plus a flat tx
// fee). Every momentum, dip-buying, whale-following and mean-reversion rule
// I tested on the dev data lost money per trade, so the edge is not in
// picking more winners — it is in risking as little as possible while still
// meeting the guardrail (a round trip of at least 0.01 SOL on at least 20
// coins, max drawdown 50%). The bot therefore buys only the earliest moment
// a coin shows real buying (its 2nd to 8th trade, at least two of the last
// three trades buys, real reserves already >= 2 SOL), risks exactly 0.02 SOL
// per coin, takes profit at +40% or cuts at -10%, trails winners once they
// are up 10%, exits stale coins, and stops entering entirely after 35
// completed round trips. The other ~9.3 SOL simply stays in cash.
//
// No clock, no randomness, no network: every decision is a pure function of
// the batches the harness delivers, so two runs on the same data produce
// the same action log.

import { runBot, type Batch, type BotState, type OrderInput } from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------------------
// Tunables (all in plain units; lamports are converted at the use site).

const LAMPORTS_PER_SOL = 1_000_000_000n;
const sol = (x: number): bigint => BigInt(Math.round(x * 1_000_000_000));

// Entry: only the first buying on a coin, while it is still tiny.
const MIN_TRADES = 2; // earliest trade index at which the bot may buy
const MAX_TRADES = 8; // latest trade index at which the bot may buy
const ENTRY_WINDOW = 3; // look-back for the buy-dominance check
const ENTRY_BUY_SHARE = 2 / 3; // >= 2 of the last 3 trades must be buys
const MIN_REAL_SOL = 2; // real SOL reserves needed (max buy is 1% of them)

// Sizing: one fixed tranche per coin, never more, never bigger.
const BUY_SOL = 0.02; // 2x the 0.01 SOL round-trip minimum, small on purpose
const MIN_BUY_SOL = 0.02;

// Risk budget: stop entering after this many completed round trips.
const MAX_ROUND_TRIPS = 35; // guardrail needs 20; this leaves margin

// Exits.
const TAKE_PROFIT = 1.4; // sell everything at +40%
const STOP_LOSS = 0.9; // sell everything at -10%
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
}

interface Coin {
  mint: string;
  trades: number;
  lastPrice: number;
  recent: TradeTick[];
  complete: boolean;
  lastSellSlot: number;
  // Position bookkeeping, filled in from the harness's own fill reports.
  entryPrice: number; // effective lamports per token, fees included
  entrySlot: number;
  entryTrades: number;
  peakSinceEntry: number;
  pendingBuy: boolean;
  pendingSell: boolean;
}

function newCoin(mint: string): Coin {
  return {
    mint,
    trades: 0,
    lastPrice: 0,
    recent: [],
    complete: false,
    lastSellSlot: -1,
    entryPrice: 0,
    entrySlot: 0,
    entryTrades: 0,
    peakSinceEntry: 0,
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

/** Mints the bot bought and has not yet counted as a completed round trip. */
const openRoundTrips = new Set<string>();
/** Round trips completed so far; gates all new entries. */
let completedRoundTrips = 0;

/** Price of a curve from its virtual reserves: SOL lamports per token. */
function curvePrice(state: BotState, mint: string): number {
  const c = state.curves.get(mint);
  if (c === undefined) return 0;
  const tok = Number(c.virtual_token_reserves);
  const solRes = Number(c.virtual_quote_reserves);
  if (tok <= 0 || solRes <= 0) return 0;
  return solRes / tok;
}

/** Share of buys over the last `n` trades. */
function buyShare(c: Coin, n: number): number {
  const window = c.recent.slice(-n);
  if (window.length === 0) return 0;
  let buys = 0;
  for (const t of window) if (t.buy) buys++;
  return buys / window.length;
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
          if (paid >= sol(MIN_BUY_SOL)) openRoundTrips.add(fill.mint);
        }
      }
      c.pendingBuy = false;
    } else {
      if (fill.status === "filled") {
        c.entryPrice = 0;
        c.lastSellSlot = batch.slot;
      }
      c.pendingSell = false;
    }
  }

  // 2. Count round trips that actually closed: a mint the bot bought whose
  //    position is no longer in the account has completed its round trip.
  for (const mint of [...openRoundTrips]) {
    if (!state.positions.has(mint)) {
      openRoundTrips.delete(mint);
      completedRoundTrips++;
    }
  }

  // 3. Fold in this batch's events and remember which mints moved.
  const moved = new Set<string>();
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      coinFor(e.mint);
      moved.add(e.mint);
      continue;
    }
    if (e.event === "TradeEvent") {
      const c = coinFor(e.mint);
      const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      if (Number.isFinite(price) && price > 0) {
        c.lastPrice = price;
        c.recent.push({ price, buy: e.is_buy });
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

  // 4. Exits first: free the position slots before deciding on new buys.
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

  // 5. Entries: only the first buying on a coin, only while the risk budget
  //    lasts, only while a position slot and cash are free.
  const maxPositions = state.hello.caps.max_open_positions;
  if (completedRoundTrips < MAX_ROUND_TRIPS) {
    for (const mint of moved) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (completedRoundTrips >= MAX_ROUND_TRIPS) break;
      const c = coins.get(mint);
      if (c === undefined || c.complete || c.pendingBuy || c.pendingSell) continue;
      if (c.trades < MIN_TRADES || c.trades > MAX_TRADES) continue;
      if (c.recent.length < ENTRY_WINDOW) continue;
      if (c.lastPrice <= 0) continue;
      if (batch.slot - c.lastSellSlot < COOLDOWN_SLOTS) continue;
      if (state.positions.has(mint)) continue; // one tranche per coin
      if (state.committedPositionCount() >= maxPositions) continue;
      if (buyShare(c, ENTRY_WINDOW) < ENTRY_BUY_SHARE) continue;

      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      if (curve.real_quote_reserves < sol(MIN_REAL_SOL)) continue;
      const cap = state.maxBuyLamports(mint);
      const size = sol(BUY_SOL) < cap ? sol(BUY_SOL) : cap;
      if (size < sol(MIN_BUY_SOL)) continue;
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
  }

  return orders;
}

await runBot({ onBatch });
