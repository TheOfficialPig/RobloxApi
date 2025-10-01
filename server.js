// server.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();
import { saveActive, loadActive, saveResolved, loadResolved } from "./db.js";

const app = express();
const PORT = process.env.PORT || 3000;
const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
const SPORTSDATA_API_KEY = process.env.SPORTSDATA_API_KEY;

// parse JSON bodies
app.use(express.json());

// Simple in-memory bet store (replace with DB persistence if you have one)
const bets = [];

// ✅ NFL CONFIG
const NFL_SEASON_YEAR = process.env.NFL_SEASON_YEAR || "2025";
const NFL_SEASON_TYPE = process.env.NFL_SEASON_TYPE || "REG"; // REG, POST, PRE
const NFL_SEASON = `${NFL_SEASON_YEAR}${NFL_SEASON_TYPE}`;
const NFL_WEEK = parseInt(process.env.NFL_WEEK || "1", 10);

let activePredictions = loadActive();
let resolvedPredictions = loadResolved(20);

// global counter for unique IDs
let nextPredictionId =
  activePredictions.length > 0
    ? Math.max(...activePredictions.map((p) => p.id || 0)) + 1
    : 1;

function formatNumber(num) {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return num.toString();
}

// === DEDUPE ===
function dedupePredictions(preds) {
  const seen = [];
  const unique = [];

  for (const p of preds) {
    let key = "";

    if (p.source === "roblox") {
      key = `roblox-${p.meta.assetId}-${p.meta.lastKnownRap}`;
    } else if (p.source === "sports") {
      key = `sports-${p.meta.eventId}`;
    } else if (p.source === "weather") {
      // Near-duplicate filter (within ±5°F for same city)
      const existing = seen.find(
        (k) => k.startsWith(`weather-${p.meta.city}-`) &&
               Math.abs(parseInt(k.split("-").pop()) - p.meta.target) < 5
      );
      if (existing) continue;
      key = `weather-${p.meta.city}-${p.meta.target}`;
    } else {
      key = `${p.source}-${p.Name}`;
    }

    if (!seen.includes(key)) {
      seen.push(key);
      unique.push(p);
    }
  }
  return unique;
}

// === HELPERS ===
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
        const [
          name, acronym, rap, value, defaultValue,
          demand, trend, projected, hyped, rare
        ] = details;

        return {
          assetId: id,
          name,
          rap: rap || 0,
          value,
          demand,
          trend,
          projected,
          hyped,
          rare,
          lastUpdated: now
        };
      })
      .filter(item => item.demand === 3 || item.demand === 4)
      .sort((a, b) => b.rap - a.rap);

    return filtered.slice(0, 10);
  } catch (err) {
    console.warn("fetchHighDemandItems error:", err.message);
    return [];
  }
}

// === NFL HELPERS ===
async function fetchNFLEvents() {
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/Schedules/${NFL_SEASON}?key=${SPORTSDATA_API_KEY}`;
  console.log("Fetching NFL Schedule:", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sportsdata NFL fetch failed: ${res.status}`);
  const data = await res.json();
  return data;
}

async function fetchNFLGameResult(gameId) {
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/ScoresByWeek/${NFL_SEASON}/${NFL_WEEK}?key=${SPORTSDATA_API_KEY}`;
  console.log("Fetching NFL Results:", url);
  const res = await fetch(url);
  if (!res.ok) return null;
  const games = await res.json();
  return games.find((g) => g.GameKey === gameId) || null;
}

// === PREDICTION BUILDERS ===
function buildWeatherPredictions(weatherCities) {
  const predictions = [];
  for (const city of weatherCities) {
    const currentF = Math.round((city.data.main.temp * 9) / 5 + 32);

    // Round to nearest 5°F
    const rounded = Math.round(currentF / 5) * 5;
    const target = rounded + (Math.random() < 0.5 ? -5 : 5);

    // Skip if already active with similar target
    const alreadyExists = activePredictions.some(
      (p) =>
        p.source === "weather" &&
        p.meta.city === city.city &&
        Math.abs(p.meta.target - target) < 5
    );
    if (alreadyExists) continue;

    predictions.push({
      source: "weather",
      Name: `Will the temperature in ${city.city} be over/under ${target}°F in 24 hours?`,
      Description: `Currently ${currentF}°F (${city.data.weather[0].description}).`,
      Answer1: `Over ${target}°F`,
      Answer2: `Under ${target}°F`,
      TimeHours: 24,
      meta: { city: city.city, target }
    });
  }
  return predictions;
}

function buildRobloxPredictions(assets) {
  const predictions = [];
  for (const a of assets) {
    if (!a.rap || a.rap <= 0) continue;

    const rapFormatted = formatNumber(a.rap);

    // Skip if already tracking this asset at this RAP
    const alreadyExists = activePredictions.some(
      (p) =>
        p.source === "roblox" &&
        p.meta.assetId === a.assetId &&
        p.meta.lastKnownRap === a.rap
    );
    if (alreadyExists) continue;

    predictions.push({
      source: "roblox",
      Name: `Will ${a.name} sell for more or less than ${rapFormatted} R$?`,
      Description: `Current RAP: ${rapFormatted} R$.`,
      Answer1: `Higher than ${rapFormatted} R$`,
      Answer2: `Lower than ${rapFormatted} R$`,
      TimeHours: 9999,
      meta: { assetId: a.assetId, lastKnownRap: a.rap }
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
      const alreadyExists = activePredictions.some(
        (p) => p.source === "sports" && p.meta.eventId === ev.GameKey
      );
      if (alreadyExists) continue;

      const line = 35 + Math.floor(Math.random() * 15);
      predictions.push({
        source: "sports",
        Name: `Will ${ev.HomeTeam} vs ${ev.AwayTeam} total score be over/under ${line}?`,
        Description: `Kickoff: ${ev.Date} (Home: ${ev.HomeTeam}, Away: ${ev.AwayTeam})`,
        Answer1: `Over ${line}`,
        Answer2: `Under ${line}`,
        TimeHours: 48,
        meta: { eventId: ev.GameKey, league: "NFL", line }
      });
    }
  }
  return predictions;
}

// === RESOLUTION ===
async function resolvePredictions() {
  const now = Date.now();
  const stillActive = [];

  for (const p of activePredictions) {
    if (p.source !== "roblox" && now < p.expires) {
      stillActive.push(p);
      continue;
    }

    let result = "No Result";
    try {
      // 🌤 WEATHER
      if (p.source === "weather") {
        const weather = await fetchWeather(p.meta.city);
        if (weather && weather.main) {
          const currentF = (weather.main.temp * 9) / 5 + 32;
          result = currentF > p.meta.target ? "Over" : "Under";
        }
        // ✅ Weather markets always expire after 24h, no auto-refresh
      }

      // 🟦 ROBLOX
      if (p.source === "roblox") {
        const items = await fetchHighDemandItems();
        const match = items.find((a) => a.assetId === p.meta.assetId);
        if (match) {
          if (match.rap !== p.meta.lastKnownRap) {
            // Close old market
            result = match.rap > p.meta.lastKnownRap ? "Higher" : "Lower";

            // Open fresh market for updated RAP
            const rapFormatted = formatNumber(match.rap);
            const newMarket = {
              id: nextPredictionId++,
              source: "roblox",
              Name: `Will ${match.name} sell for more or less than ${rapFormatted} R$?`,
              Description: `Current RAP: ${rapFormatted} R$.`,
              Answer1: `Higher than ${rapFormatted} R$`,
              Answer2: `Lower than ${rapFormatted} R$`,
              TimeHours: 9999,
              created: now,
              expires: now + 9999 * 60 * 60 * 1000,
              meta: { assetId: match.assetId, lastKnownRap: match.rap }
            };
            stillActive.push(newMarket);
          } else {
            stillActive.push(p); // RAP unchanged → keep tracking
            continue;
          }
        }
      }

      // 🏈 SPORTS (NFL)
      if (p.source === "sports") {
        const ev = await fetchNFLGameResult(p.meta.eventId);
        if (p.meta.league === "NFL" && ev) {
          const home = parseInt(ev.HomeScore);
          const away = parseInt(ev.AwayScore);
          if (!isNaN(home) && !isNaN(away)) {
            const total = home + away;
            result = total > p.meta.line ? "Over" : "Under";
          }
        }
        // ✅ NFL markets auto-close once scores are available
      }
    } catch (err) {
      console.warn("Resolve error:", err.message);
    }

    // ✅ Save the closed prediction with its result
    saveResolved({ ...p, result });
  }

  activePredictions = stillActive;
  saveActive(activePredictions);
}

// === BUILDER ===
async function buildPredictions() {
  const newPredictions = [];
  const now = Date.now();

  // SPORTS
  try {
    const nflEvents = await fetchNFLEvents();
    const nflPreds = buildNFLPredictions(nflEvents).slice(0, 7);
    newPredictions.push(...nflPreds);
  } catch (err) {
    console.warn("NFL fetch failed:", err.message);
  }

  // ROBLOX
  try {
    const items = await fetchHighDemandItems();
    const robloxPreds = buildRobloxPredictions(items).slice(0, 7);
    newPredictions.push(...robloxPreds);
  } catch (err) {
    console.warn("Roblox build failed:", err.message);
  }

  // WEATHER
  const weatherCities = (process.env.WEATHER_CITY || "Los Angeles,London,Tokyo")
    .split(",")
    .map((c) => c.trim());
  const chosenCities = [];
  for (const city of weatherCities.slice(0, 5)) {
    const data = await fetchWeather(city);
    if (data) chosenCities.push({ city, data });
  }
  const weatherPreds = buildWeatherPredictions(chosenCities);
  newPredictions.push(...weatherPreds);

  // Attach IDs
  const prepared = newPredictions.map((p) => {
    if (!p.id) {
      p.id = nextPredictionId++;
      p.created = now;
      p.expires = now + p.TimeHours * 60 * 60 * 1000;
    }
    return p;
  });

  // Deduplicate + limit
  const merged = dedupePredictions([...activePredictions, ...prepared]);
  activePredictions = merged.slice(0, 20);

  saveActive(activePredictions);
}

// === INIT FUNCTION ===
async function init() {
  if (activePredictions.length < 20) {
    await buildPredictions();
  } else {
    console.log(
      `♻️ Loaded ${activePredictions.length} active predictions from storage`
    );
  }

  // refresh loop
  setInterval(refreshPredictions, 5 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`Prediction server running on port ${PORT}`);
    console.log(
      `📅 NFL Season: ${NFL_SEASON_YEAR} ${NFL_SEASON_TYPE}, Week: ${NFL_WEEK}`
    );
  });
}

init().catch((err) => {
  console.error("Fatal init error:", err);
  process.exit(1);
});

// === ROUTES ===
app.get("/predictions", (req, res) => {
  res.json({
    ok: true,
    active: loadActive().slice(0, 20),
    resolved: loadResolved(20)
  });
});

/**
 * POST /bet
 * Expects JSON body:
 * {
 *   userId: <number|string>,
 *   username: <string>,
 *   predictionId: <number>,
 *   choice: <string>, // should match Answer1 or Answer2 ideally
 *   amount: <number>
 * }
 *
 * Responds: { ok: true, message: 'Bet accepted', betId: <id> }
 */
app.post("/bet", (req, res) => {
  try {
    const { userId, username, predictionId, choice, amount } = req.body || {};

    // Basic validation
    if (!userId || !username || typeof predictionId === "undefined" || !choice || typeof amount === "undefined") {
      return res.status(400).json({ ok: false, error: "Missing parameters. Required: userId, username, predictionId, choice, amount" });
    }

    const parsedPredictionId = Number(predictionId);
    const parsedAmount = Number(amount);

    if (isNaN(parsedPredictionId) || isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid predictionId or amount" });
    }

    // Check that prediction exists and is active
    const prediction = (activePredictions.find(p => p.id === parsedPredictionId) || loadActive().find(p => p.id === parsedPredictionId));
    if (!prediction) {
      return res.status(404).json({ ok: false, error: "Prediction not found or already closed" });
    }

    // Optionally validate choice against Answer1/Answer2
    const validChoices = [];
    if (prediction.Answer1) validChoices.push(prediction.Answer1);
    if (prediction.Answer2) validChoices.push(prediction.Answer2);
    // allow free-form choice too, but warn if it doesn't match
    if (validChoices.length && !validChoices.includes(choice)) {
      console.warn(`Player choice "${choice}" didn't match known answers for prediction ${parsedPredictionId}. Known: ${validChoices.join(", ")}`);
      // not blocking — accept it, but you can change to 400 if you prefer strict checking
    }

    const newBet = {
      id: bets.length + 1,
      userId,
      username,
      predictionId: parsedPredictionId,
      choice,
      amount: parsedAmount,
      created: Date.now()
    };

    // Save in-memory (replace with DB save if desired)
    bets.push(newBet);
    console.log("Received bet:", newBet);

    // If you have a DB function, call it here, e.g. saveBet(newBet)
    // try { await saveBet(newBet); } catch (err) { console.warn("saveBet failed", err); }

    return res.json({ ok: true, message: "Bet accepted", bet: newBet });
  } catch (err) {
    console.error("Bet handler error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// Debug route: get recent bets (remove or protect in production)
app.get("/bets", (req, res) => {
  const limit = Math.min(50, Number(req.query.limit) || 20);
  res.json({ ok: true, count: bets.length, bets: bets.slice(-limit).reverse() });
});

app.listen(PORT, () => {
  console.log(`Prediction server running on port ${PORT}`);
  console.log(`📅 NFL Season: ${NFL_SEASON_YEAR} ${NFL_SEASON_TYPE}, Week: ${NFL_WEEK}`);
});
