// server.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

import { db, saveMarketRow, loadActiveMarkets, loadResolvedMarkets, upsertPosition, getPosition, reducePosition, getPositionsByMarket, saveBet, getRecentBets } from "./db.js";
import { priceForSide, sharesForAmount, amountForSell } from "./market.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HOUSE_FEE = Number(process.env.HOUSE_FEE || "0.05");
const ADMIN_KEY = process.env.ADMIN_KEY || "changeme";

// In-memory caches (persisted to DB when updated)
let activeMarkets = loadActiveMarkets() || [];
let resolvedMarkets = loadResolvedMarkets(200) || [];

// Helper: persist all active markets to DB
function persistActiveMarkets() {
  for (const m of activeMarkets) {
    try {
      saveMarketRow(m);
    } catch (err) {
      console.warn("saveMarketRow failed:", err.message);
    }
  }
}

// Enricher for /predictions
function enrichMarket(m) {
  const q1 = Number(m.q1 || 0);
  const q2 = Number(m.q2 || 0);
  const b = Number(m.b || 50);
  const p1 = priceForSide(q1, q2, b, "answer1");
  const p2 = 1 - p1;
  const multipliers = {};
  multipliers[m.Answer1] = p1 > 0 ? +( (1 / p1).toFixed(2) ) : null;
  multipliers[m.Answer2] = p2 > 0 ? +( (1 / p2).toFixed(2) ) : null;
  const liquidity = { q1, q2, totalShares: q1 + q2 };
  const recentTrades = getRecentBets(m.id, 10);
  return {
    ...m,
    liquidity,
    prices: { [m.Answer1]: +(p1 * 100).toFixed(2), [m.Answer2]: +(p2 * 100).toFixed(2) },
    multipliers,
    recentTrades
  };
}

// GET /predictions
app.get("/predictions", (req, res) => {
  try {
    const enriched = activeMarkets.map(enrichMarket);
    res.json({ ok: true, active: enriched, resolved: resolvedMarkets.slice(0, 20) });
  } catch (err) {
    console.error("GET /predictions error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /bet (buy shares)
app.post("/bet", (req, res) => {
  try {
    const { userId, username, predictionId, side, amount } = req.body || {};
    if (!userId || !username || typeof predictionId === "undefined" || !side || typeof amount === "undefined") {
      return res.status(400).json({ ok: false, error: "Missing parameters" });
    }
    const parsedAmount = Number(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ ok: false, error: "Invalid amount" });

    const market = activeMarkets.find(m => m.id === Number(predictionId));
    if (!market) return res.status(404).json({ ok: false, error: "Market not found or closed" });
    if (market.status && market.status !== "open") return res.status(400).json({ ok: false, error: "Market closed" });

    // compute shares for amount
    const q1 = Number(market.q1 || 0);
    const q2 = Number(market.q2 || 0);
    const b = Number(market.b || 50);

    const sideKey = side === market.Answer1 ? "answer1" :
                    side === market.Answer2 ? "answer2" : null;
    if (!sideKey) return res.status(400).json({ ok: false, error: "Invalid side" });

    const deltaShares = sharesForAmount(q1, q2, b, sideKey, parsedAmount);
    if (deltaShares <= 0) return res.status(400).json({ ok: false, error: "Amount too small to buy shares" });

    // update market q's
    if (sideKey === "answer1") market.q1 = q1 + deltaShares;
    else market.q2 = q2 + deltaShares;

    // save trade log
    const betId = saveBet({
      userId: String(userId),
      username: String(username),
      predictionId: Number(predictionId),
      choice: side,
      amount: parsedAmount,
      shares: deltaShares,
      type: "buy",
      timestamp: Date.now()
    });

    // update positions
    upsertPosition({ userId: String(userId), username, marketId: Number(predictionId), side, additionalShares: deltaShares });

    // persist market
    persistActiveMarkets();

    // respond with enriched market snapshot
    return res.json({ ok: true, message: "Buy accepted", bet: { id: betId, shares: deltaShares, amount: parsedAmount }, market: enrichMarket(market) });
  } catch (err) {
    console.error("Bet handler error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /cashout (sell shares back to AMM)
app.post("/cashout", (req, res) => {
  try {
    const { userId, username, predictionId, side, shares } = req.body || {};
    if (!userId || !username || typeof predictionId === "undefined" || !side || typeof shares === "undefined") {
      return res.status(400).json({ ok: false, error: "Missing parameters" });
    }
    const s = Number(shares);
    if (isNaN(s) || s <= 0) return res.status(400).json({ ok: false, error: "Invalid shares" });

    const market = activeMarkets.find(m => m.id === Number(predictionId));
    if (!market) return res.status(404).json({ ok: false, error: "Market not found" });
    if (market.status && market.status !== "open") return res.status(400).json({ ok: false, error: "Market closed" });

    // check user's position
    const pos = getPosition(String(userId), Number(predictionId), side);
    if (!pos || Number(pos.shares || 0) < s) return res.status(400).json({ ok: false, error: "Not enough shares" });

    const q1 = Number(market.q1 || 0);
    const q2 = Number(market.q2 || 0);
    const b = Number(market.b || 50);
    const sideKey = side === market.Answer1 ? "answer1" : "answer2";

    const gross = amountForSell(q1, q2, b, sideKey, s); // pre-fee
    const payout = +(gross * (1 - HOUSE_FEE)).toFixed(2);

    // reduce market q
    if (sideKey === "answer1") market.q1 = Math.max(0, q1 - s);
    else market.q2 = Math.max(0, q2 - s);

    // update position
    reducePosition(String(userId), Number(predictionId), side, s);

    // record trade
    saveBet({
      userId: String(userId),
      username,
      predictionId: Number(predictionId),
      choice: side,
      amount: payout,
      shares: s,
      type: "sell",
      timestamp: Date.now()
    });

    persistActiveMarkets();

    return res.json({ ok: true, message: "Cashed out", payout, market: enrichMarket(market) });
  } catch (err) {
    console.error("/cashout error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// Admin resolve (manual)
app.post("/admin/resolve", (req, res) => {
  try {
    const { adminKey, predictionId, result } = req.body || {};
    if (adminKey !== ADMIN_KEY) return res.status(403).json({ ok: false, error: "Unauthorized" });

    const idx = activeMarkets.findIndex(m => m.id === Number(predictionId));
    if (idx === -1) return res.status(404).json({ ok: false, error: "Market not found" });

    const market = activeMarkets[idx];
    market.status = "resolved";
    market.result = result;

    // Payout winners: each winning share pays 1; fee applied
    const positions = getPositionsByMarket(market.id);
    const payouts = [];
    for (const p of positions) {
      if (String(p.side) === String(result)) {
        const gross = Number(p.shares) * 1.0;
        const payout = +(gross * (1 - HOUSE_FEE)).toFixed(2);
        payouts.push({ userId: p.userId, username: p.username, shares: p.shares, payout });
        // clear position
        reducePosition(p.userId, market.id, p.side, Number(p.shares));
      }
    }

    // persist resolved to resolvedMarkets and save market row
    resolvedMarkets.unshift(market);
    if (resolvedMarkets.length > 200) resolvedMarkets.length = 200;

    saveMarketRow({ ...market, status: 'resolved' });
    activeMarkets.splice(idx, 1);

    return res.json({ ok: true, resolved: market, payouts });
  } catch (err) {
    console.error("Admin resolve error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// Basic sanity route
app.get("/", (req, res) => {
  res.json({ ok: true, msg: "Prediction market server running." });
});

// Periodic refresh (resolve/refresh/build predictions)
// NOTE: adapt your existing build/resolve logic here. For brevity, simple periodic persist.
setInterval(() => {
  try {
    persistActiveMarkets();
    // you can run resolution logic automatically here (e.g., check expires -> resolve)
    // For production, call your resolvePredictions() which fetches external results and resolves markets.
  } catch (err) {
    console.warn("Periodic persist error:", err.message);
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Market server running on port ${PORT}`);
});
