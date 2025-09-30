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

// ✅ NEW NFL CONFIG (separate year + type)
const NFL_SEASON_YEAR = process.env.NFL_SEASON_YEAR || "2025";
const NFL_SEASON_TYPE = process.env.NFL_SEASON_TYPE || "REG"; // REG, POST, PRE
const NFL_SEASON = `${NFL_SEASON_YEAR}${NFL_SEASON_TYPE}`;
const NFL_WEEK = parseInt(process.env.NFL_WEEK || "1", 10);

let activePredictions = loadActive();
let resolvedPredictions = loadResolved(20);

// global counter for unique IDs
let nextPredictionId = (activePredictions.length > 0)
  ? Math.max(...activePredictions.map(p => p.id || 0)) + 1
  : 1;

function formatNumber(num) {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return num.toString();
}

// ✅ NEW: Dedupe helper
function dedupePredictions(preds) {
  const seen = new Set();
  return preds.filter(p => {
    let key = "";

    if (p.source === "roblox") key = `roblox-${p.meta.assetId}`;
    else if (p.source === "sports") key = `sports-${p.meta.eventId}-${p.meta.line}`;
    else if (p.source === "weather") key = `weather-${p.meta.city}-${p.meta.target}`;
    else key = `${p.source}-${p.Name}`;

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// === HELPERS ===
// Weather
async function fetchWeather(city) {
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${OPENWEATHER_KEY}&units=metric`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.json();
}

// Roblox (via Rolimons) — only highest demand items
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
      .filter(item => item.demand === 3 || item.demand === 4) // High or Amazing demand only
      .sort((a, b) => b.rap - a.rap); // sort by RAP

    return filtered.slice(0, 10); // take top 10
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
  if (!Array.isArray(data) || data.length === 0) {
    console.warn("⚠️ No NFL games returned for season:", NFL_SEASON);
  }
  return data;
}

async function fetchNFLGameResult(gameId) {
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/ScoresByWeek/${NFL_SEASON}/${NFL_WEEK}?key=${SPORTSDATA_API_KEY}`;
  console.log("Fetching NFL Results:", url);
  const res = await fetch(url);
  if (!res.ok) {
    console.warn("NFL result fetch failed:", res.status);
    return null;
  }
  const games = await res.json();
  return games.find((g) => g.GameKey === gameId) || null;
}

// === PREDICTION BUILDERS ===
function buildWeatherPredictions(weatherCities) {
  const predictions = [];
  for (const city of weatherCities) {
    const currentF = Math.round((city.data.main.temp * 9) / 5 + 32);
    const target = currentF + (Math.random() < 0.5 ? -5 : 5);
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

    predictions.push({
      source: "roblox",
      Name: `Will ${a.name} sell for more or less than ${rapFormatted} R$?`,
      Description: `Current RAP: ${rapFormatted} R$.`,
      Answer1: `Higher than ${rapFormatted} R$`,
      Answer2: `Lower than ${rapFormatted} R$`,
      TimeHours: 9999, // keep active until RAP changes
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
      const line = 35 + Math.floor(Math.random() * 15); // 35–50 O/U line
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
    if (now < p.expires && p.source !== "roblox") {
      stillActive.push(p);
      continue;
    }

    let result = "No Result";
    try {
      if (p.source === "weather") {
        const weather = await fetchWeather(p.meta.city);
        if (weather && weather.main) {
          const currentF = (weather.main.temp * 9) / 5 + 32;
          result = currentF > p.meta.target ? "Over" : "Under";
        }
      }

      if (p.source === "roblox") {
        const items = await fetchHighDemandItems();
        const match = items.find((a) => a.assetId === p.meta.assetId);
        if (match) {
          if (match.rap !== p.meta.lastKnownRap) {
            result = match.rap > p.meta.lastKnownRap ? "Higher" : "Lower";
          } else {
            stillActive.push(p); // keep if no RAP change yet
            continue;
          }
        }
      }

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
      }
    } catch (err) {
      console.warn("Resolve error:", err.message);
    }

    saveResolved({ ...p, result });
  }

  activePredictions = stillActive;
  saveActive(activePredictions);
}

// === BUILDER (no repeats) ===
// === BUILDER (no repeats, no placeholders) ===
async function buildPredictions() {
  const newPredictions = [];
  const now = Date.now();

  // --- SPORTS ---
  try {
    const nflEvents = await fetchNFLEvents();
    const nflPreds = buildNFLPredictions(nflEvents).slice(0, 7);
    if (nflPreds.length > 0) {
      newPredictions.push(...nflPreds);
    } else {
      console.log("⚠️ No NFL predictions built (no upcoming games)");
    }
  } catch (err) {
    console.warn("NFL fetch failed:", err.message);
  }

  // --- ROBLOX ---
  try {
    const items = await fetchHighDemandItems();
    const robloxPreds = buildRobloxPredictions(items).slice(0, 7);
    if (robloxPreds.length > 0) {
      newPredictions.push(...robloxPreds);
    } else {
      console.log("⚠️ No Roblox high-demand items found");
    }
  } catch (err) {
    console.warn("Roblox build failed:", err.message);
  }

  // --- WEATHER ---
  const weatherCities = (process.env.WEATHER_CITY || "Los Angeles,London,Tokyo")
    .split(",")
    .map((c) => c.trim());
  const chosenCities = [];
  for (const city of weatherCities.slice(0, 5)) {
    const data = await fetchWeather(city);
    if (data) chosenCities.push({ city, data });
  }
  const weatherPreds = buildWeatherPredictions(chosenCities);
  if (weatherPreds.length > 0) {
    newPredictions.push(...weatherPreds);
  }

  // --- Attach IDs ---
  const prepared = newPredictions.map((p) => {
    if (!p.id) {
      p.id = nextPredictionId++;
      p.created = now;
      p.expires = now + p.TimeHours * 60 * 60 * 1000;
    }
    return p;
  });

  // ✅ Deduplicate across existing + new
  const merged = dedupePredictions([...activePredictions, ...prepared]);

  // ✅ Limit to 20 max
  activePredictions = merged.slice(0, 20);

  saveActive(activePredictions);
}

// === REFRESH LOOP ===
async function refreshPredictions() {
  await resolvePredictions();

  const now = Date.now();
  activePredictions = activePredictions.filter(
    (p) => p.source === "roblox" || p.expires > now
  );

  if (activePredictions.length < 20) {
    await buildPredictions();
  }
}

setInterval(refreshPredictions, 5 * 60 * 1000);

// ✅ Only build if we have no saved predictions
if (activePredictions.length < 20) {
  await buildPredictions();
} else {
  console.log(`♻️ Loaded ${activePredictions.length} active predictions from storage`);
}

// === ROUTES ===
app.get("/predictions", (req, res) => {
  res.json({
    ok: true,
    active: loadActive().slice(0, 20),
    resolved: loadResolved(20)
  });
});

app.listen(PORT, () => {
  console.log(`Prediction server running on port ${PORT}`);
  console.log(`📅 NFL Season: ${NFL_SEASON_YEAR} ${NFL_SEASON_TYPE}, Week: ${NFL_WEEK}`);
});
