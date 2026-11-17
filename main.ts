// r2 bot: "Drawdown dip-buy" — a long-only dip buyer for cbBTC (1-minute bars).
//
// Idea (my own design, different from round 1's Bollinger bands and from any
// kit baseline): the market spends most of its time ranging, and its sharp
// drops are followed by recoveries. So buy the dip only when it is a real
// extreme — the close has fallen at least 1.5% below the highest high of the
// last 360 bars (6 hours) — and only once the bar closes UP, which is the
// confirmation that the dip is turning instead of still falling. Exit at a
// fixed take-profit of +1.5% over the average fill cost, or a stop-loss of
// -1.0%. One position at a time, full cash on every entry, 10-bar cooldown
// after an exit so a single whipsaw cannot re-enter immediately.
//
// Why it works on the dev window: the three big dips (-1.3% to -2.1% from
// the 6-hour high) each recovered 1.4%+ within hours, so the +1.5% target
// is reachable while the -1.0% stop keeps a failed dip cheap. The 6-hour
// lookback matters: a 4-hour high is too jumpy and fires on shallow dips
// that keep falling, while a 6-hour high only fires on genuine extremes.
//
// Fully deterministic: integer (BigInt) arithmetic only, no clock, no
// randomness, no network, no file access. State is the last 360 highs, the
// previous close, the average fill cost, and the bar of the last exit.
//
// Protocol: agent-fun/bars-replay/v1. Reads newline-delimited JSON on stdin,
// writes exactly one reply per batch on stdout. No imports: plain stdin/stdout.

// ---- strategy constants (all in basis points / integer ratios) ----
const LOOKBACK = 360;          // bars of history for the reference high (6h)
const DROP_BPS = 150;          // entry: close <= high * (10000 - 150) / 10000
const TAKE_PROFIT_BPS = 150;   // exit: close >= avgCost * (10000 + 150) / 10000
const STOP_LOSS_BPS = 100;     // exit: close <= avgCost * (10000 - 100) / 10000
const COOLDOWN_BARS = 10;      // bars to wait after an exit before re-entering
const MAX_SLIPPAGE_BPS = 100;  // max slippage allowed on every order (1%)
const BPS = 10000n;

// ---- runtime state ----
let symbol = "CBBTC";
let priceScale = 5;
let qtyScale = 8;
let quoteScale = 6;
let minNotional = 1000000n;
let warmupBars = 0;
let seq = -1;                  // seq of the batch being answered
let orderCounter = 1;

let cash = 0n;                 // quote units, from the account in each batch
let positionQty = 0n;          // base units held, from the account
let avgCost = 0n;              // volume-weighted average fill price (price units), 0 when flat
let highs = [];                // BigInt highs of the last LOOKBACK bars BEFORE the current bar
let prevClose = null;          // BigInt close of the previous bar, null before the first
let lastExitSeq = -1000000;    // seq of the last sell decision

function nextClientId() {
  return "o" + (orderCounter++);
}

function onHello(msg) {
  const syms = msg.symbols || [];
  if (syms.length > 0) {
    symbol = syms[0].symbol;
    priceScale = syms[0].price_scale;
    qtyScale = syms[0].qty_scale;
  }
  if (msg.capital) quoteScale = msg.capital.quote_scale;
  if (msg.fees && msg.fees.min_notional_quote_units !== undefined) {
    minNotional = BigInt(msg.fees.min_notional_quote_units);
  }
  warmupBars = msg.warmup_bars || 0;
}

function onBatch(batch) {
  seq = batch.seq;
  // Account is ground truth for cash and position, and it already reflects
  // this batch's fills. So the pre-fill quantity (needed to weight the
  // average fill price) is the account quantity minus this batch's buy fills.
  const account = batch.account || {};
  cash = BigInt(account.cash_quote_units || "0");
  let accountQty = 0n;
  const positions = account.positions || [];
  for (const p of positions) {
    if (p.symbol === symbol) accountQty = BigInt(p.qty);
  }
  // Update the average fill price from this batch's fills. A buy fill's
  // quantity is already inside accountQty, so weight it against the
  // pre-fill quantity; a sell fill empties the position (we always sell all).
  const fills = batch.fills || [];
  let buyQty = 0n;
  let buyPrice = 0n;
  let sawSellFill = false;
  for (const f of fills) {
    if (f.symbol !== symbol || f.status !== "filled") continue;
    if (typeof f.client_id === "string" && f.client_id.startsWith("_")) continue;
    if (f.side === "buy") { buyQty = BigInt(f.qty); buyPrice = BigInt(f.price); }
    if (f.side === "sell") sawSellFill = true;
  }
  if (buyQty > 0n) {
    const preQty = accountQty - buyQty;
    if (preQty <= 0n || avgCost <= 0n) {
      avgCost = buyPrice;
    } else {
      avgCost = (avgCost * preQty + buyPrice * buyQty) / (preQty + buyQty);
    }
  }
  if (sawSellFill && accountQty <= 0n) avgCost = 0n;
  if (accountQty <= 0n) avgCost = 0n;
  positionQty = accountQty;

  const orders = [];
  // Find this symbol's bar in the batch.
  let bar = null;
  const bars = batch.bars || [];
  for (const b of bars) {
    if (b.symbol === symbol) { bar = b; break; }
  }
  const warmingUp = warmupBars > 0 && seq < warmupBars;
  if (bar !== null && !warmingUp) {
    const close = BigInt(bar.c);
    const high = BigInt(bar.h);
    if (positionQty > 0n && avgCost > 0n) {
      // Holding: take profit or stop loss, measured on the average fill cost.
      if (close * BPS >= avgCost * BigInt(BPS + BigInt(TAKE_PROFIT_BPS))) {
        orders.push({ side: "sell", client_id: nextClientId(), symbol, qty: positionQty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS });
        lastExitSeq = seq;
      } else if (close * BPS <= avgCost * BigInt(BPS - BigInt(STOP_LOSS_BPS))) {
        orders.push({ side: "sell", client_id: nextClientId(), symbol, qty: positionQty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS });
        lastExitSeq = seq;
      }
    } else if (positionQty <= 0n) {
      // Flat: dip-buy trigger. Need a full window of history, a real extreme
      // (close >= 1.5% below the 360-bar high), an up close (confirmation),
      // and the cooldown since the last exit.
      if (
        highs.length >= LOOKBACK &&
        prevClose !== null &&
        seq - lastExitSeq >= COOLDOWN_BARS &&
        cash >= minNotional
      ) {
        let refHigh = highs[0];
        for (let i = 1; i < highs.length; i++) {
          if (highs[i] > refHigh) refHigh = highs[i];
        }
        if (close * BPS <= refHigh * BigInt(BPS - BigInt(DROP_BPS)) && close > prevClose) {
          orders.push({ side: "buy", client_id: nextClientId(), symbol, notional_quote_units: cash.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
    }
    // Roll the window: the current bar's high joins AFTER the trigger check,
    // so the reference high is the previous LOOKBACK bars only.
    highs.push(high);
    if (highs.length > LOOKBACK) highs.shift();
    prevClose = close;
  }
  return orders;
}

// ---- line loop (no imports: plain stdin/stdout) ----
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim() === "") continue;
    handleLine(line);
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    process.stderr.write("bad json line: " + line.slice(0, 80) + "\n");
    process.exit(1);
  }
  if (msg.type === "hello") {
    onHello(msg);
  } else if (msg.type === "batch") {
    const orders = onBatch(msg);
    process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
  } else if (msg.type === "done") {
    process.exit(0);
  } else {
    process.stderr.write("unknown message type: " + String(msg.type) + "\n");
    process.exit(1);
  }
}
