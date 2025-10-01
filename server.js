// server.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

import {
  saveActive,
  loadActive,
  saveResolved,
  loadResolved,
  saveBet,
  getBetsByPrediction,
  markBetsPaid
} from "./db.js";

const app = express();
const PORT = process.env.PORT || 3000;
const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
const SPORTSDATA_API_KEY = process.env.SPORTSDATA_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY || "changeme";
const HOUSE_FEE = Number(process.env.HOUSE_FEE || "0.05"); // 5% default fee

app.use(express.json());

// Load persisted predictions
let activePredictions = loadActive() || [];
let resolvedPredictions = loadResolved(50) || [];

// id counters (DB handles primary keys for stored rows, these are local for generated markets)
let nextPredictionId =
  activePredictions.length > 0
    ? Math.max(...activePredictions.map((p) => p.id || 0)) + 1
    : 1;

function formatNumber(num) {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(num);
}

function dedupePredictions(preds) {
  const seen = new Set();
  const unique = [];
  for (const p of preds) {
    let key = "";
    if (p.source === "roblox") key = `roblox-${p.meta.assetId}-${p.meta.lastKnownRap}`;
    else if (p.source === "sports") key = `sports-${p.meta.eventId}`;
    else if (p.source === "weather") key = `weather-${p.meta.city}-${p.meta.target}`;
    else key = `${p.source}-${p.Name}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }
  return unique;
}

// --- Helpers that query bets in DB to compute liquidity / odds ---
async function getMarketLiquidityFromDB(prediction) {
  // getBetsByPrediction returns array of bets: { id, userId, username, predictionId, choice, amount, paidOut }
  const bets = await Promise.resolve(getBetsByPrediction(prediction.id)); // getBetsByPrediction is synchronous in db.js, but keep Promise.resolve for parity
  const totals = {};
  if (prediction.Answer1) totals[prediction.Answer1] = 0;
  if (prediction.Answer2) totals[prediction.Answer2] = 0;

  for (const b of bets) {
    if (!totals[b.choice]) totals[b.choice] = 0;
    totals[b.choice] += Number(b.amount || 0);
  }

  const total = Object.values(totals).reduce((s, n) => s + n, 0);

  // implied probabilities (pari-mutuel style): share of liquidity (fallback to 50/50)
  const odds = {};
  if (total === 0) {
    const choices = Object.keys(totals);
    const half = 1 / Math.max(choices.length, 2);
    for (const c of choices) odds[c] = half;
  } else {
    for (const [k, v] of Object.entries(totals)) odds[k] = total === 0 ? 0 : v / total;
  }

  // multipliers (naive): total / amount_on_choice (if nobody bet on a side, set multiplier ~ total+1)
  const multipliers = {};
  for (const [k, v] of Object.entries(totals)) {
    multipliers[k] = v === 0 ? total + 1 : total / (v || 1);
  }

  return { bets, totals, total, odds, multipliers };
}

// --- External fetch helpers (unchanged) ---
async function fetchWeather(city) {
  if (!OPENWEATHER_KEY) return null;
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${OPENWEATHER_KEY}&units=metric`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.json();
}

async function fetchHighDemandItems() {
  try {
    const url = "https://api.rolimons.com/items/v1/itemdetails";
    const res = await fetch(url);
    if (!res.ok) throw new Error("Rolimons fetch failed");
    const data = await res.json();
    const items = data.items || {};
    const now = Date.now();
    const filtered = Object.entries(items)
      .map(([id, details]) => {
        const [name, acronym, rap, value, defaultValue, demand, trend, projected, hyped, rare] = details;
        return { assetId: id, name, rap: rap || 0, value, demand, trend, projected, hyped, rare, lastUpdated: now };
      })
      .filter(item => item.demand === 3 || item.demand === 4)
      .sort((a, b) => b.rap - a.rap);
    return filtered.slice(0, 10);
  } catch (err) {
    console.warn("fetchHighDemandItems error:", err.message);
    return [];
  }
}

async function fetchNFLEvents() {
  const NFL_SEASON_YEAR = process.env.NFL_SEASON_YEAR || "2025";
  const NFL_SEASON_TYPE = process.env.NFL_SEASON_TYPE || "REG";
  const NFL_SEASON = `${NFL_SEASON_YEAR}${NFL_SEASON_TYPE}`;
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/Schedules/${NFL_SEASON}?key=${SPORTSDATA_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sportsdata NFL fetch failed: ${res.status}`);
  return await res.json();
}

async function fetchNFLGameResult(gameId) {
  const NFL_SEASON_YEAR = process.env.NFL_SEASON_YEAR || "2025";
  const NFL_SEASON_TYPE = process.env.NFL_SEASON_TYPE || "REG";
  const NFL_SEASON = `${NFL_SEASON_YEAR}${NFL_SEASON_TYPE}`;
  const NFL_WEEK = parseInt(process.env.NFL_WEEK || "1", 10);
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/ScoresByWeek/${NFL_SEASON}/${NFL_WEEK}?key=${SPORTSDATA_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const games = await res.json();
  return games.find((g) => g.GameKey === gameId) || null;
}

// --- Builders (unchanged logic, but attach id/expires) ---
function buildWeatherPredictions(weatherCities) {
  const predictions = [];
  for (const city of weatherCities) {
    const currentF = Math.round((city.data.main.temp * 9) / 5 + 32);
    const rounded = Math.round(currentF / 5) * 5;
    const target = rounded + (Math.random() < 0.5 ? -5 : 5);

    const alreadyExists = activePredictions.some(p => p.source === "weather" && p.meta.city === city.city && Math.abs(p.meta.target - target) < 5);
    if (alreadyExists) continue;

    predictions.push({
      id: nextPredictionId++,
      source: "weather",
      Name: `Will the temperature in ${city.city} be over/under ${target}°F in 24 hours?`,
      Description: `Currently ${currentF}°F (${city.data.weather[0].description}).`,
      Answer1: `Over ${target}°F`,
      Answer2: `Under ${target}°F`,
      TimeHours: 24,
      meta: { city: city.city, target },
      created: Date.now(),
      expires: Date.now() + 24 * 60 * 60 * 1000
    });
  }
  return predictions;
}

function buildRobloxPredictions(items) {
  const predictions = [];
  for (const a of items) {
    if (!a.rap || a.rap <= 0) continue;
    const rapFormatted = formatNumber(a.rap);
    const alreadyExists = activePredictions.some(p => p.source === "roblox" && p.meta.assetId === a.assetId && p.meta.lastKnownRap === a.rap);
    if (alreadyExists) continue;
    predictions.push({
      id: nextPredictionId++,
      source: "roblox",
      Name: `Will ${a.name} sell for more or less than ${rapFormatted} R$?`,
      Description: `Current RAP: ${rapFormatted} R$.`,
      Answer1: `Higher than ${rapFormatted} R$`,
      Answer2: `Lower than ${rapFormatted} R$`,
      TimeHours: 9999,
      meta: { assetId: a.assetId, lastKnownRap: a.rap },
      created: Date.now(),
      expires: Date.now() + 9999 * 60 * 60 * 1000
    });
  }
  return predictions;
}

function buildNFLPredictions(events) {
  const predictions = [];
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const startOfDayAfterTomorrow = new Date(startOfTomorrow);
  startOfDayAfterTomorrow.setDate(startOfDayAfterTomorrow.getDate() + 1);

  for (const ev of events) {
    const gameDate = new Date(ev.Date);
    if (gameDate >= startOfToday && gameDate < startOfDayAfterTomorrow) {
      const alreadyExists = activePredictions.some(p => p.source === "sports" && p.meta.eventId === ev.GameKey);
      if (alreadyExists) continue;
      const line = 35 + Math.floor(Math.random() * 15);
      predictions.push({
        id: nextPredictionId++,
        source: "sports",
        Name: `Will ${ev.HomeTeam} vs ${ev.AwayTeam} total score be over/under ${line}?`,
        Description: `Kickoff: ${ev.Date} (Home: ${ev.HomeTeam}, Away: ${ev.AwayTeam})`,
        Answer1: `Over ${line}`,
        Answer2: `Under ${line}`,
        TimeHours: 48,
        meta: { eventId: ev.GameKey, league: "NFL", line },
        created: Date.now(),
        expires: Date.now() + 48 * 60 * 60 * 1000
      });
    }
  }
  return predictions;
}

// --- Resolution: compute result, payouts (pari-mutuel), persist, mark bets paid ---
async function resolvePredictions() {
  const now = Date.now();
  const remaining = [];

  for (const p of activePredictions) {
    // keep if not expired (roblox markets are handled specially later)
    if (p.source !== "roblox" && now < p.expires) {
      remaining.push(p);
      continue;
    }

    let result = "No Result";
    try {
      if (p.source === "weather") {
        const weather = await fetchWeather(p.meta.city);
        if (weather && weather.main) {
          const currentF = (weather.main.temp * 9) / 5 + 32;
          result = currentF > p.meta.target ? p.Answer1.replace(/^Over\s*/, "").trim() ? "Over" : p.Answer1 : p.Answer2;
          // normalize to the exact Answer1/Answer2 strings
          result = currentF > p.meta.target ? p.Answer1 : p.Answer2;
        }
      }

      if (p.source === "roblox") {
        const items = await fetchHighDemandItems();
        const match = items.find(a => a.assetId === p.meta.assetId);
        if (match) {
          if (match.rap !== p.meta.lastKnownRap) {
            result = match.rap > p.meta.lastKnownRap ? p.Answer1 : p.Answer2;

            // open fresh market for updated RAP
            const rapFormatted = formatNumber(match.rap);
            const newMarket = {
              id: nextPredictionId++,
              source: "roblox",
              Name: `Will ${match.name} sell for more or less than ${rapFormatted} R$?`,
              Description: `Current RAP: ${rapFormatted} R$.`,
              Answer1: `Higher than ${rapFormatted} R$`,
              Answer2: `Lower than ${rapFormatted} R$`,
              TimeHours: 9999,
              meta: { assetId: match.assetId, lastKnownRap: match.rap },
              created: now,
              expires: now + 9999 * 60 * 60 * 1000
            };
            remaining.push(newMarket);
          } else {
            // unchanged -> keep tracking
            remaining.push(p);
            continue;
          }
        } else {
          result = "No Result";
        }
      }

      if (p.source === "sports") {
        const ev = await fetchNFLGameResult(p.meta.eventId);
        if (p.meta.league === "NFL" && ev) {
          const home = parseInt(ev.HomeScore);
          const away = parseInt(ev.AwayScore);
          if (!isNaN(home) && !isNaN(away)) {
            const total = home + away;
            result = total > p.meta.line ? p.Answer1 : p.Answer2;
          }
        }
      }
    } catch (err) {
      console.warn("Resolve error:", err.message);
    }

    // Fetch bets for this market
    const bets = getBetsByPrediction(p.id) || [];
    const totalPot = bets.reduce((s, b) => s + Number(b.amount || 0), 0);

    // Determine winners (strings compared case-insensitively)
    const winners = bets.filter(b => String(b.choice).toLowerCase() === String(result).toLowerCase());
    const winnersTotal = winners.reduce((s, b) => s + Number(b.amount || 0), 0);

    // Payout calculation: pari-mutuel distribution after house fee
    let payoutList = [];
    if (winners.length > 0 && winnersTotal > 0) {
      const poolAfterFee = totalPot * (1 - HOUSE_FEE);
      // Each winner's payout = (bet.amount / winnersTotal) * poolAfterFee
      payoutList = winners.map((w) => {
        const share = Number(w.amount || 0) / winnersTotal;
        const payout = +(share * poolAfterFee).toFixed(2);
        return { betId: w.id, userId: w.userId, username: w.username, choice: w.choice, amount: Number(w.amount), payout };
      });
    } else {
      payoutList = []; // no winners => house keeps pot (or could refund)
    }

    // Mark winning bets as paid (so Roblox can safely credit players only once)
    try {
      const paidBetIds = payoutList.map(pw => pw.betId);
      if (paidBetIds.length) markBetsPaid(paidBetIds);
    } catch (err) {
      console.warn("markBetsPaid failed:", err.message);
    }

    // Build payout summary and resolved record
    const totals = {};
    if (p.Answer1) totals[p.Answer1] = 0;
    if (p.Answer2) totals[p.Answer2] = 0;
    for (const b of bets) {
      totals[b.choice] = (totals[b.choice] || 0) + Number(b.amount || 0);
    }

    const odds = {};
    for (const [k, v] of Object.entries(totals)) odds[k] = totalPot === 0 ? 0 : v / totalPot;

    const payoutSummary = {
      totalPot,
      totals,
      odds,
      houseFee: HOUSE_FEE,
      winners: payoutList,
      winnerCount: payoutList.length
    };

    const resolvedRecord = {
      ...p,
      result,
      resolvedAt: now,
      payoutSummary
    };

    // persist resolved
    try {
      saveResolved(resolvedRecord);
    } catch (err) {
      console.warn("saveResolved failed:", err.message);
    }

    // push into resolvedPredictions in-memory list
    resolvedPredictions.unshift(resolvedRecord);
    if (resolvedPredictions.length > 200) resolvedPredictions.length = 200;
  }

  // replace active with remaining
  activePredictions = dedupePredictions(remaining).slice(0, 200);
  try {
    saveActive(activePredictions);
  } catch (err) {
    console.warn("saveActive failed:", err.message);
  }
}

// --- Builder: create markets and attach IDs/expires ---
async function buildPredictions() {
  const newPredictions = [];
  const now = Date.now();

  // try NFL
  try {
    const events = await fetchNFLEvents();
    newPredictions.push(...buildNFLPredictions(events).slice(0, 7));
  } catch (err) {
    console.warn("NFL build failed:", err.message);
  }

  // rolimons
  try {
    const items = await fetchHighDemandItems();
    newPredictions.push(...buildRobloxPredictions(items).slice(0, 7));
  } catch (err) {
    console.warn("RoLimons build failed:", err.message);
  }

  // weather
  const weatherCities = (process.env.WEATHER_CITY || "Los Angeles,London,Tokyo").split(",").map(s => s.trim());
  const chosen = [];
  for (const city of weatherCities.slice(0, 5)) {
    const d = await fetchWeather(city);
    if (d) chosen.push({ city, data: d });
  }
  newPredictions.push(...buildWeatherPredictions(chosen));

  // attach created/expires already done in builders; dedupe + limit
  activePredictions = dedupePredictions([...activePredictions, ...newPredictions]).slice(0, 50);
  try {
    saveActive(activePredictions);
  } catch (err) {
    console.warn("saveActive failed:", err.message);
  }
}

// wrapper to run resolve + build
async function refreshPredictions() {
  try {
    await resolvePredictions();
    await buildPredictions();
    console.log("♻️ Predictions refreshed");
  } catch (err) {
    console.error("Refresh failed:", err);
  }
}

// --- INIT ---
async function init() {
  if (!activePredictions || activePredictions.length === 0) {
    await buildPredictions();
  } else {
    console.log(`♻️ Loaded ${activePredictions.length} active predictions from storage`);
  }

  // periodic refresh every 5 minutes
  setInterval(refreshPredictions, 5 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`Prediction server running on port ${PORT}`);
  });
}
init().catch((err) => {
  console.error("Fatal init error:", err);
  process.exit(1);
});

// --- ROUTES ---

// GET /predictions -> active markets with liquidity/odds
app.get("/predictions", async (req, res) => {
  try {
    const enriched = [];
    for (const p of activePredictions) {
      const { totals, total, odds, multipliers } = await getMarketLiquidityFromDB(p);
      enriched.push({
        ...p,
        liquidity: { totals, total },
        odds: Object.fromEntries(Object.entries(odds).map(([k, v]) => [k, +(v * 100).toFixed(2)])),
        multipliers
      });
    }
    res.json({ ok: true, active: enriched, resolved: resolvedPredictions.slice(0, 20) });
  } catch (err) {
    console.error("GET /predictions error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// GET /resolved -> recent resolved markets (includes payoutSummary winners)
app.get("/resolved", (req, res) => {
  const limit = Math.min(50, Number(req.query.limit) || 20);
  res.json({ ok: true, count: resolvedPredictions.length, resolved: resolvedPredictions.slice(0, limit) });
});

/**
 * POST /bet
 * Body: { userId, username, predictionId, choice, amount }
 */
app.post("/bet", (req, res) => {
  try {
    const { userId, username, predictionId, choice, amount } = req.body || {};
    if (!userId || !username || typeof predictionId === "undefined" || !choice || typeof amount === "undefined") {
      return res.status(400).json({ ok: false, error: "Missing parameters. Required: userId, username, predictionId, choice, amount" });
    }

    const parsedPredictionId = Number(predictionId);
    const parsedAmount = Number(amount);
    if (isNaN(parsedPredictionId) || isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid predictionId or amount" });
    }

    const prediction = activePredictions.find(p => p.id === parsedPredictionId);
    if (!prediction) return res.status(404).json({ ok: false, error: "Prediction not found or closed" });

    // persist bet
    const bet = { userId: String(userId), username: String(username), predictionId: parsedPredictionId, choice: String(choice), amount: parsedAmount };
    try {
      saveBet(bet);
    } catch (err) {
      console.warn("saveBet failed:", err.message);
      return res.status(500).json({ ok: false, error: "Failed to save bet" });
    }

    // return updated market snapshot (recompute liquidity)
    const { totals, total, odds, multipliers } = (async () => await getMarketLiquidityFromDB(prediction))();
    // Note: getMarketLiquidityFromDB uses getBetsByPrediction synchronously from db.js; if yours is sync, no need for await

    // quick enriched view
    const enriched = {
      ...prediction,
      liquidity: { totals, total },
      odds: Object.fromEntries(Object.entries(odds).map(([k, v]) => [k, +(v * 100).toFixed(2)])),
      multipliers
    };

    return res.json({ ok: true, message: "Bet accepted", bet, market: enriched });
  } catch (err) {
    console.error("Bet handler error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// Admin: manual resolve for testing. Body: { adminKey, predictionId, result }
app.post("/admin/resolve", (req, res) => {
  try {
    const { adminKey, predictionId, result } = req.body || {};
    if (adminKey !== ADMIN_KEY) return res.status(403).json({ ok: false, error: "Unauthorized" });
    const idx = activePredictions.findIndex(p => p.id === predictionId);
    if (idx === -1) return res.status(404).json({ ok: false, error: "Prediction not found" });

    const p = activePredictions[idx];
    // manually set result and compute payouts similar to resolvePredictions logic
    const bets = getBetsByPrediction(p.id) || [];
    const totalPot = bets.reduce((s, b) => s + Number(b.amount || 0), 0);
    const winners = bets.filter(b => String(b.choice).toLowerCase() === String(result).toLowerCase());
    const winnersTotal = winners.reduce((s, b) => s + Number(b.amount || 0), 0);
    let payoutList = [];
    if (winners.length > 0 && winnersTotal > 0) {
      const poolAfterFee = totalPot * (1 - HOUSE_FEE);
      payoutList = winners.map(w => {
        const share = Number(w.amount || 0) / winnersTotal;
        const payout = +(share * poolAfterFee).toFixed(2);
        return { betId: w.id, userId: w.userId, username: w.username, choice: w.choice, amount: Number(w.amount), payout };
      });
      markBetsPaid(payoutList.map(pw => pw.betId));
    }

    const payoutSummary = { totalPot, winners: payoutList, winnerCount: payoutList.length, houseFee: HOUSE_FEE };
    const resolvedRecord = { ...p, result, resolvedAt: Date.now(), payoutSummary };

    // remove active & persist resolved
    activePredictions.splice(idx, 1);
    resolvedPredictions.unshift(resolvedRecord);
    if (resolvedPredictions.length > 200) resolvedPredictions.length = 200;
    try { saveActive(activePredictions); saveResolved(resolvedRecord); } catch (err) { console.warn("persist fail:", err.message); }

    return res.json({ ok: true, resolved: resolvedRecord });
  } catch (err) {
    console.error("Admin resolve error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// Debug: list bets (for admin/debug)
app.get("/bets", (req, res) => {
  // Note: if you want this, add a db function to query bets; otherwise keep as diagnostic route (not implemented here)
  res.json({ ok: false, error: "Use DB tool to query bets (getBetsByPrediction) or add an admin-only bets route" });
});
