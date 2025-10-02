// server.js
// Complete merged prediction market server (LMSR AMM + builders + persistence)
// Run: node server.js
import express from "express";
import fetch from "node-fetch";
import Database from "better-sqlite3";
import dotenv from "dotenv";
dotenv.config();

const PORT = process.env.PORT || 3000;
const HOUSE_FEE = Number(process.env.HOUSE_FEE || "0.05");
const ADMIN_KEY = process.env.ADMIN_KEY || "changeme";
const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY || "";
const SPORTSDATA_API_KEY = process.env.SPORTSDATA_API_KEY || "";
const ROLIMONS_URL = "https://api.rolimons.com/items/v1/itemdetails"; // public-ish
const WEATHER_CITIES = (process.env.WEATHER_CITY || "Los Angeles,London,Tokyo,New York,Chicago").split(",").map(s=>s.trim());

// ----------------------
// LMSR market math
// ----------------------
function cost(q1, q2, b) {
  const e1 = Math.exp(q1 / b);
  const e2 = Math.exp(q2 / b);
  return b * Math.log(e1 + e2);
}
function priceForSide(q1, q2, b, side) {
  const e1 = Math.exp(q1 / b);
  const e2 = Math.exp(q2 / b);
  const sum = e1 + e2;
  return side === "answer1" ? e1 / sum : e2 / sum;
}
function sharesForAmount(q1, q2, b, side, amount) {
  const base = cost(q1, q2, b);
  if (amount <= 0) return 0;
  function deltaCost(delta) {
    if (side === "answer1") return cost(q1 + delta, q2, b) - base;
    return cost(q1, q2 + delta, b) - base;
  }
  // binary search for delta where deltaCost ~= amount
  let lo = 0;
  let hi = Math.max(1, amount * 4);
  let c = deltaCost(hi);
  let tries = 0;
  while (c < amount && tries < 80) {
    hi *= 2;
    c = deltaCost(hi);
    tries++;
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const cm = deltaCost(mid);
    if (cm > amount) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}
function amountForSell(q1, q2, b, side, shares) {
  const base = cost(q1, q2, b);
  if (shares <= 0) return 0;
  let newCost;
  if (side === "answer1") newCost = cost(Math.max(0, q1 - shares), q2, b);
  else newCost = cost(q1, Math.max(0, q2 - shares), b);
  return base - newCost;
}

// ----------------------
// In-memory caches (loaded from DB at start)
// ----------------------
let activeMarkets = loadActiveMarkets();
let resolvedMarkets = loadResolvedMarkets(200);

import fs from "fs";

function loadActiveMarkets() {
  try {
    if (fs.existsSync("activeMarkets.json")) {
      return JSON.parse(fs.readFileSync("activeMarkets.json", "utf-8"));
    }
    return [];
  } catch (err) {
    console.error("Failed to load active markets:", err);
    return [];
  }
}

// ensure next id for created markets (use DB autoincrement naturally when saving without id)
function persistActiveMarkets() {
  for (const m of activeMarkets) {
    saveMarketRow(m);
  }
}

// ----------------------
// Helpers: format + enrich market
// ----------------------
function formatNumber(num) {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(num));
}

function enrichMarket(m) {
  const q1 = Number(m.q1 || 0);
  const q2 = Number(m.q2 || 0);
  const b = Number(m.b || 50);
  const p1 = priceForSide(q1, q2, b, "answer1");
  const p2 = 1 - p1;
  const multipliers = {};
  multipliers[m.Answer1] = p1 > 0 ? +((1 / p1).toFixed(2)) : null;
  multipliers[m.Answer2] = p2 > 0 ? +((1 / p2).toFixed(2)) : null;
  const liquidity = { q1, q2, totalShares: q1 + q2 };
  const recentTrades = getRecentBets(m.id, 12);
  return {
    ...m,
    liquidity,
    prices: { [m.Answer1]: +(p1 * 100).toFixed(2), [m.Answer2]: +(p2 * 100).toFixed(2) },
    multipliers,
    recentTrades
  };
}

// ----------------------
// Builders: create many viral markets per source
// ----------------------

// dedupe using semantic key
function dedupeMarkets(markets) {
  const seen = new Set();
  const unique = [];
  for (const p of markets) {
    let key = `${p.source}|${p.meta && JSON.stringify(p.meta)}|${p.Name}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }
  return unique;
}

// build weather markets: multiple thresholds per city (over/under, rain yes/no)
async function fetchWeather(city) {
  if (!OPENWEATHER_KEY) return null;
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${OPENWEATHER_KEY}&units=metric`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.json();
}

function buildWeatherMarkets(weatherCitiesData) {
  const markets = [];
  const now = Date.now();
  for (const item of weatherCitiesData) {
    const city = item.city;
    const data = item.data;
    if (!data || !data.main) continue;
    const currentF = Math.round((data.main.temp * 9) / 5 + 32);
    // produce several thresholds around current temp
    const deltas = [-10, -5, 0, 5, 10];
    for (const d of deltas) {
      const target = Math.max(-50, currentF + d); // F
      const name = `Will the temperature in ${city} be over ${target}°F in 24 hours?`;
      const desc = `Currently ${currentF}°F (${data.weather && data.weather[0] && data.weather[0].description || 'N/A'})`;
      markets.push({
        source: "weather",
        Name: name,
        Description: desc,
        Answer1: `Over ${target}°F`,
        Answer2: `Under ${target}°F`,
        TimeHours: 24,
        meta: { city, target },
        created: now,
        expires: now + 24 * 60 * 60 * 1000,
        q1: 0, q2: 0, b: 40
      });
    }
    // rainfall yes/no market
    const rainName = `Will it rain in ${city} within 24 hours?`;
    markets.push({
      source: "weather",
      Name: rainName,
      Description: `Forecast: ${data.weather && data.weather[0] && data.weather[0].description || 'N/A'}`,
      Answer1: `Yes (Rain)`,
      Answer2: `No (No Rain)`,
      TimeHours: 24,
      meta: { city, type: 'rain' },
      created: now, expires: now + 24*60*60*1000, q1:0, q2:0, b:30
    });
  }
  return markets;
}

// Rolimons item markets - create multiple prop markets per item
async function fetchHighDemandItems() {
  try {
    const res = await fetch(ROLIMONS_URL);
    if (!res.ok) throw new Error("Rolimons fetch failed");
    const data = await res.json();
    const items = data.items || {};
    const now = Date.now();
    const arr = Object.entries(items).map(([id, details]) => {
      const [name, acronym, rap, value, defaultValue, demand, trend, projected, hyped, rare] = details;
      return { assetId: id, name, rap: rap || 0, value, demand, trend, projected, hyped, rare, lastUpdated: now };
    });
    // filter for hyped/demand items, sort by rap
    const filtered = arr.filter(i => i.demand >= 3).sort((a,b)=>b.rap - a.rap);
    return filtered.slice(0, 25);
  } catch (err) {
    console.warn("fetchHighDemandItems error:", err.message);
    return [];
  }
}

function buildRobloxItemMarkets(items) {
  const markets = [];
  const now = Date.now();
  for (const a of items) {
    // market: price over/under current RAP
    if (a.rap && a.rap > 0) {
      const rapFormatted = formatNumber(a.rap);
      markets.push({
        source: "roblox",
        Name: `Will ${a.name} sell for more or less than ${rapFormatted} R$?`,
        Description: `Current RAP: ${rapFormatted} R$.`,
        Answer1: `Higher than ${rapFormatted} R$`,
        Answer2: `Lower than ${rapFormatted} R$`,
        TimeHours: 72,
        meta: { assetId: a.assetId, lastKnownRap: a.rap, type: "rap_threshold" },
        created: now, expires: now + 72*60*60*1000, q1:0, q2:0, b:80
      });
    }
    // market: will RAP increase more than X% in 7 days (several % thresholds for virality)
    const thresholds = [2, 5, 10];
    for (const pct of thresholds) {
      markets.push({
        source: "roblox",
        Name: `Will ${a.name} RAP increase by at least ${pct}% within 7 days?`,
        Description: `Current RAP: ${formatNumber(a.rap)} R$.`,
        Answer1: `Yes (≥ ${pct}% up)`,
        Answer2: `No (< ${pct}% up)`,
        TimeHours: 24*7,
        meta: { assetId: a.assetId, lastKnownRap: a.rap, pct, type: "rap_pct" },
        created: now, expires: now + 7*24*60*60*1000, q1:0, q2:0, b:70
      });
    }
    // market: will demand trend stay hyped in 3 days (binary)
    markets.push({
      source: "roblox",
      Name: `Will ${a.name} remain 'hyped' in 3 days?`,
      Description: `Demand indicator: ${a.demand}, trend: ${a.trend}`,
      Answer1: `Yes (still hyped)`,
      Answer2: `No (not hyped)`,
      TimeHours: 72,
      meta: { assetId: a.assetId, type: "hype_check" },
      created: now, expires: now + 72*60*60*1000, q1:0, q2:0, b:60
    });
  }
  return markets;
}

// NFL markets: multiple props per game: spread, winner, over/under total
async function fetchNFLEvents() {
  if (!SPORTSDATA_API_KEY) return [];
  const NFL_SEASON_YEAR = process.env.NFL_SEASON_YEAR || "2025";
  const NFL_SEASON_TYPE = process.env.NFL_SEASON_TYPE || "REG";
  const NFL_SEASON = `${NFL_SEASON_YEAR}${NFL_SEASON_TYPE}`;
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/Schedules/${NFL_SEASON}?key=${SPORTSDATA_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Sportsdata NFL fetch failed");
  const events = await res.json();
  return events;
}

function buildNFLMarkets(events) {
  const markets = [];
  const now = Date.now();
  // pick next 7 days of games, create multiple props per game
  const futureGames = events.filter(ev => {
    const gd = new Date(ev.Date);
    return gd.getTime() > Date.now() - (24*60*60*1000); // upcoming or recent
  }).slice(0, 30);

  for (const ev of futureGames) {
    const home = ev.HomeTeam || ev.HomeTeamAbbr || "Home";
    const away = ev.AwayTeam || ev.AwayTeamAbbr || "Away";
    const kickoff = ev.Date;

    // winner market
    markets.push({
      source: "sports",
      Name: `Will ${home} beat ${away}?`,
      Description: `Kickoff: ${kickoff} (Home: ${home}, Away: ${away})`,
      Answer1: `${home} wins`,
      Answer2: `${away} wins or tie`,
      TimeHours: 72,
      meta: { eventId: ev.GameKey, league: "NFL", prop: "winner" },
      created: now, expires: new Date(ev.Date).getTime() + 6*60*60*1000, q1:0, q2:0, b:120
    });

    // over/under total points - generate 3 lines for virality
    const baseLine = 45 + Math.floor(Math.random()*12); // random-ish
    for (const offset of [-3, 0, 3]) {
      const line = baseLine + offset;
      markets.push({
        source: "sports",
        Name: `Will ${home} vs ${away} total score be over ${line}?`,
        Description: `Kickoff: ${kickoff} (Line: ${line})`,
        Answer1: `Over ${line}`,
        Answer2: `Under ${line}`,
        TimeHours: 72,
        meta: { eventId: ev.GameKey, league: "NFL", line, prop: "total" },
        created: now, expires: new Date(ev.Date).getTime() + 6*60*60*1000, q1:0, q2:0, b:100
      });
    }
    // simple player prop (if available) could be added, omitted for API simplicity
  }

  return markets;
}

// ----------------------
// Refresh builders -> create many markets, dedupe, persist
// ----------------------
async function buildPredictions() {
  const newPredictions = [];
  // 1) weather
  try {
    const chosen = [];
    for (const city of WEATHER_CITIES.slice(0, 8)) {
      const d = await fetchWeather(city);
      if (d) chosen.push({ city, data: d });
      await sleep(200); // be polite
    }
    newPredictions.push(...buildWeatherMarkets(chosen));
  } catch (err) {
    console.warn("Weather builder failed:", err.message);
  }

  // 2) rolimons
  try {
    const items = await fetchHighDemandItems();
    newPredictions.push(...buildRobloxItemMarkets(items));
  } catch (err) {
    console.warn("RoLimons builder failed:", err.message);
  }

  // 3) NFL
  try {
    const events = await fetchNFLEvents();
    if (events && events.length) newPredictions.push(...buildNFLMarkets(events));
  } catch (err) {
    console.warn("NFL builder failed:", err.message);
  }

  // --- combine with existing activeMarkets, dedupe, limit ---
  const combined = [...activeMarkets, ...newPredictions];
  const unique = dedupeMarkets(combined);
  // keep only the 200 most recent open markets
  // (prefer existing activeMarkets first then new ones)
  activeMarkets = unique.slice(-200); // keep last 200
  // Persist
  persistActiveMarkets();
  console.log(`Built ${newPredictions.length} new markets, active now ${activeMarkets.length}`);
}

// small sleep helper
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ----------------------
// Resolution logic
// - For auto-resolution we check expires; for weather/sports/roblox we attempt to fetch official result
// - For simplicity, markets without external data that cannot be resolved remain open or can be admin-resolved
// ----------------------
async function resolveExpiredMarkets() {
  const now = Date.now();
  const remaining = [];
  for (const m of activeMarkets) {
    if (m.expires && m.expires <= now) {
      try {
        let result = null;
        if (m.source === "weather" && m.meta && m.meta.city && typeof m.meta.target !== "undefined") {
          const w = await fetchWeather(m.meta.city);
          if (w && w.main) {
            const currentF = (w.main.temp * 9) / 5 + 32;
            result = currentF > m.meta.target ? m.Answer1 : m.Answer2;
          }
        } else if (m.source === "sports" && m.meta && m.meta.eventId) {
          // try fetch game result (sportsdata)
          try {
            const game = await fetchNFLGameResult(m.meta.eventId);
            if (game) {
              if (m.meta.prop === "total" && typeof game.HomeScore !== "undefined") {
                const home = Number(game.HomeScore || 0);
                const away = Number(game.AwayScore || 0);
                const total = home + away;
                result = total > m.meta.line ? m.Answer1 : m.Answer2;
              } else if (m.meta.prop === "winner") {
                const home = Number(game.HomeScore || 0);
                const away = Number(game.AwayScore || 0);
                if (home > away) result = m.Answer1; else result = m.Answer2;
              }
            }
          } catch (err) {
            // swallow
          }
        } else if (m.source === "roblox") {
          // for roblox items we try to re-fetch and compare rap/demand
          const items = await fetchHighDemandItems();
          const match = items.find(x => x.assetId === m.meta.assetId);
          if (match) {
            if (m.meta.type === "rap_threshold" && typeof m.meta.lastKnownRap !== "undefined") {
              result = match.rap > m.meta.lastKnownRap ? m.Answer1 : m.Answer2;
            } else if (m.meta.type === "rap_pct" && typeof m.meta.pct !== "undefined") {
              const pct = m.meta.pct || m.pct;
              const changed = ((match.rap - (m.meta.lastKnownRap||match.rap)) / ((m.meta.lastKnownRap||match.rap) || 1)) * 100;
              result = changed >= pct ? m.Answer1 : m.Answer2;
            } else {
              // if we can't decide automatically, set to No Result
              result = "No Result";
            }
          } else {
            result = "No Result";
          }
        }

        if (!result) {
          // fallback: No Result -> refund shares? Currently mark resolved with No Result
          result = "No Result";
        }

        // compute payouts on resolution: winners get 1 per share less house fee
        const positions = getPositionsByMarket(m.id);
        const payouts = [];
        for (const pos of positions) {
          if (String(pos.side) === String(result)) {
            const gross = Number(pos.shares) * 1.0;
            const payout = +(gross * (1 - HOUSE_FEE)).toFixed(2);
            payouts.push({ userId: pos.userId, username: pos.username, payout, shares: pos.shares });
            // clear position
            reducePosition(pos.userId, m.id, pos.side, Number(pos.shares));
          }
        }

        // mark market resolved and persist
        m.status = "resolved";
        m.result = result;
        saveMarketRow(m);
        resolvedMarkets.unshift(m);
        if (resolvedMarkets.length > 500) resolvedMarkets.length = 500;
        console.log(`Resolved market ${m.id} -> ${result} | payouts: ${payouts.length}`);
        // NOTE: you should credit users on Roblox side by notifying game server (or expose a payouts endpoint)
        // (we only record payout list; the game server earlier used /resolved polling to credit players)
      } catch (err) {
        console.warn("resolve error:", err.message);
        // if resolution fails, keep market open for manual admin resolution
        remaining.push(m);
      }
    } else {
      remaining.push(m);
    }
  }
  activeMarkets = remaining;
  persistActiveMarkets();
}

// helper to fetch game result for NFL
async function fetchNFLGameResult(gameKey) {
  if (!SPORTSDATA_API_KEY) return null;
  const NFL_SEASON_YEAR = process.env.NFL_SEASON_YEAR || "2025";
  const NFL_SEASON_TYPE = process.env.NFL_SEASON_TYPE || "REG";
  const NFL_SEASON = `${NFL_SEASON_YEAR}${NFL_SEASON_TYPE}`;
  const NFL_WEEK = parseInt(process.env.NFL_WEEK || "1", 10);
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/ScoresByWeek/${NFL_SEASON}/${NFL_WEEK}?key=${SPORTSDATA_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const games = await res.json();
  return games.find(g => g.GameKey === gameKey) || null;
}

// ----------------------
// Express app + endpoints
// ----------------------
const app = express();
app.use(express.json());

// GET /predictions -> active markets with enriched liquidity/prices
app.get("/predictions", (req, res) => {
  try {
    const enriched = activeMarkets.map(enrichMarket);
    return res.json({ ok: true, active: enriched, resolved: resolvedMarkets.slice(0, 30) });
  } catch (err) {
    console.error("GET /predictions error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// GET /resolved -> recent resolved markets
app.get("/resolved", (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  res.json({ ok: true, count: resolvedMarkets.length, resolved: resolvedMarkets.slice(0, limit) });
});

// GET /bets?predictionId= -> debug/market trades
app.get("/bets", (req, res) => {
  const pid = Number(req.query.predictionId || 0);
  if (pid) {
    return res.json({ ok: true, bets: getBetsByPrediction(pid) });
  }
  return res.json({ ok: true, error: "Provide predictionId param to query" });
});

// POST /bet -> buy shares (body: { userId, username, predictionId, side, amount })
app.post("/bet", (req, res) => {
  try {
    const { userId, username, predictionId, side, amount } = req.body || {};
    if (!userId || !username || typeof predictionId === "undefined" || !side || typeof amount === "undefined") {
      return res.status(400).json({ ok: false, error: "Missing parameters. Required: userId, username, predictionId, side, amount" });
    }
    const parsedAmount = Number(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ ok: false, error: "Invalid amount" });

    const market = activeMarkets.find(m => Number(m.id) === Number(predictionId));
    if (!market) return res.status(404).json({ ok: false, error: "Market not found or closed" });
    if (market.status && market.status !== "open") return res.status(400).json({ ok: false, error: "Market closed" });

    const q1 = Number(market.q1 || 0);
    const q2 = Number(market.q2 || 0);
    const b = Number(market.b || 50);

    const sideKey = side === market.Answer1 ? "answer1" : side === market.Answer2 ? "answer2" : null;
    if (!sideKey) return res.status(400).json({ ok: false, error: "Invalid side string (must be exact Answer1 or Answer2)" });

    const deltaShares = sharesForAmount(q1, q2, b, sideKey, parsedAmount);
    if (deltaShares <= 0) return res.status(400).json({ ok: false, error: "Amount too small to buy shares" });

    if (sideKey === "answer1") market.q1 = q1 + deltaShares; else market.q2 = q2 + deltaShares;

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

    upsertPosition({ userId: String(userId), username: String(username), marketId: Number(predictionId), side, additionalShares: deltaShares });

    persistActiveMarkets();

    return res.json({ ok: true, message: "Buy accepted", bet: { id: betId, shares: deltaShares, amount: parsedAmount }, market: enrichMarket(market) });
  } catch (err) {
    console.error("Bet handler error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /cashout -> sell shares (body: { userId, username, predictionId, side, shares })
app.post("/cashout", (req, res) => {
  try {
    const { userId, username, predictionId, side, shares } = req.body || {};
    if (!userId || !username || typeof predictionId === "undefined" || !side || typeof shares === "undefined") {
      return res.status(400).json({ ok: false, error: "Missing parameters. Required: userId, username, predictionId, side, shares" });
    }
    const s = Number(shares);
    if (isNaN(s) || s <= 0) return res.status(400).json({ ok: false, error: "Invalid shares" });

    const market = activeMarkets.find(m => Number(m.id) === Number(predictionId));
    if (!market) return res.status(404).json({ ok: false, error: "Market not found or closed" });
    if (market.status && market.status !== "open") return res.status(400).json({ ok: false, error: "Market closed" });

    const pos = getPosition(String(userId), Number(predictionId), side);
    if (!pos || Number(pos.shares || 0) < s) return res.status(400).json({ ok: false, error: "Not enough shares to sell" });

    const q1 = Number(market.q1 || 0);
    const q2 = Number(market.q2 || 0);
    const b = Number(market.b || 50);
    const sideKey = side === market.Answer1 ? "answer1" : "answer2";
    const gross = amountForSell(q1, q2, b, sideKey, s); // pre-fee
    const payout = +(gross * (1 - HOUSE_FEE)).toFixed(2);

    // reduce market q
    if (sideKey === "answer1") market.q1 = Math.max(0, q1 - s); else market.q2 = Math.max(0, q2 - s);

    reducePosition(String(userId), Number(predictionId), side, s);

    saveBet({
      userId: String(userId),
      username: String(username),
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

// Admin resolve endpoint (manual override) body: { adminKey, predictionId, result }
app.post("/admin/resolve", (req, res) => {
  try {
    const { adminKey, predictionId, result } = req.body || {};
    if (adminKey !== ADMIN_KEY) return res.status(403).json({ ok: false, error: "Unauthorized" });
    const idx = activeMarkets.findIndex(m => Number(m.id) === Number(predictionId));
    if (idx === -1) return res.status(404).json({ ok: false, error: "Market not found" });
    const m = activeMarkets[idx];
    m.status = "resolved";
    m.result = result;

    // payout winners
    const positions = getPositionsByMarket(m.id);
    const payouts = [];
    for (const p of positions) {
      if (String(p.side) === String(result)) {
        const gross = Number(p.shares) * 1.0;
        const payout = +(gross * (1 - HOUSE_FEE)).toFixed(2);
        payouts.push({ userId: p.userId, username: p.username, shares: p.shares, payout });
        reducePosition(p.userId, m.id, p.side, Number(p.shares));
      }
    }

    // persist resolved
    saveMarketRow(m);
    resolvedMarkets.unshift(m);
    if (resolvedMarkets.length > 500) resolvedMarkets.length = 500;
    activeMarkets.splice(idx, 1);

    return res.json({ ok: true, resolved: m, payouts });
  } catch (err) {
    console.error("Admin resolve error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// simple health
app.get("/", (req, res) => res.json({ ok: true, msg: "Prediction market server running" }));

// ----------------------
// Periodic tasks: build predictions and resolve expired
// ----------------------
async function refreshCycle() {
  try {
    await buildPredictions();
    await resolveExpiredMarkets();
    // persist just in case
    persistActiveMarkets();
  } catch (err) {
    console.warn("refreshCycle failed:", err.message);
  }
}

// run initial build if no markets
(async () => {
  if (!activeMarkets || activeMarkets.length === 0) {
    await buildPredictions();
  } else {
    console.log(`Loaded ${activeMarkets.length} active markets from DB`);
  }
  // schedule periodic refresh every 5 minutes
  setInterval(refreshCycle, 5 * 60 * 1000);
})();

// start server
app.listen(PORT, () => console.log(`Prediction server listening on ${PORT}`));
