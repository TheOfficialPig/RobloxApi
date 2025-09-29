// server.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

import {
  saveActive,
  loadActive,
  saveResolved,
  loadResolved
} from "./db.js";

const app = express();
const PORT = process.env.PORT || 3000;

const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
const SPORTSDATA_API_KEY = process.env.SPORTSDATA_API_KEY;

// ✅ NEW ENV VARS for NFL
const NFL_SEASON = process.env.NFL_SEASON || "2025REG"; // example: 2025REG, 2024POST
const NFL_WEEK = parseInt(process.env.NFL_WEEK || "1"); // defaults to 1

let activePredictions = loadActive();
let resolvedPredictions = loadResolved(20);

// global counter for unique IDs
let nextPredictionId = (activePredictions.length > 0)
  ? Math.max(...activePredictions.map(p => p.id || 0)) + 1
  : 1;

// === HELPERS ===

// Weather
async function fetchWeather(city) {
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
    city
  )}&appid=${OPENWEATHER_KEY}&units=metric`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.json();
}

// Roblox (via Rolimons)
async function fetchMovingLimiteds() {
  try {
    const url = "https://api.rolimons.com/items/v1/itemdetails";
    const res = await fetch(url);
    if (!res.ok) throw new Error("Rolimons fetch failed");

    const data = await res.json();
    const items = data.items || {};
    const now = Date.now();

    const moving = Object.entries(items)
      .map(([id, details]) => {
        const [name, recentAveragePrice, originalPrice, demand, rarity, projected] = details;
        return {
          assetId: id,
          name,
          recentAveragePrice: recentAveragePrice || 0,
          demand,
          rarity,
          projected,
          lastUpdated: now
        };
      })
      .filter((item) => item.recentAveragePrice > 0);

    // simulate % movement (replace with cache later)
    const movers = moving.filter((item) => {
      const changePercent = Math.random() * 20 - 10; // fake +/-10%
      return Math.abs(changePercent) >= 5;
    });

    return movers.slice(0, 10);
  } catch (err) {
    console.warn("fetchMovingLimiteds error:", err.message);
    return [];
  }
}

// Sports (NFL from Sportsdata.io)
async function fetchNFLEvents() {
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/Schedule/${NFL_SEASON}?key=${SPORTSDATA_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Sportsdata NFL fetch failed");
  return await res.json();
}

async function fetchNFLGameResult(gameId) {
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/ScoresByWeek/${NFL_SEASON}/${NFL_WEEK}?key=${SPORTSDATA_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const games = await res.json();
  return games.find((g) => g.GameKey === gameId) || null;
}

// === PREDICTION BUILDERS ===

// Weather
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

// Roblox
function buildRobloxPredictions(assets) {
  const predictions = [];

  for (const a of assets) {
    const current = a.recentAveragePrice;
    const target =
      current + (Math.random() < 0.5
        ? -Math.floor(current * 0.1)
        : Math.floor(current * 0.1));

    predictions.push({
      source: "roblox",
      Name: `Will ${a.name} average over/under ${target} R$ in 12 hours?`,
      Description: `Currently ${current} R$ (Demand: ${a.demand || "N/A"}).`,
      Answer1: `Over ${target} R$`,
      Answer2: `Under ${target} R$`,
      TimeHours: 12,
      meta: { assetId: a.assetId, target }
    });
  }

  return predictions;
}

// NFL
function buildNFLPredictions(events) {
  const predictions = [];

  for (const ev of events) {
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

  return predictions;
}

// === RESOLUTION ===
async function resolvePredictions() {
  const now = Date.now();
  const stillActive = [];

  for (const p of activePredictions) {
    if (now < p.expires) {
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
        const movers = await fetchMovingLimiteds();
        const match = movers.find((a) => a.assetId === p.meta.assetId);
        if (match) {
          const recent = match.recentAveragePrice ?? 0;
          result = recent > p.meta.target ? "Over" : "Under";
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

// === BUILDER (limit, no filler weather) ===
async function buildPredictions() {
  const newPredictions = [];
  const now = Date.now();

  // --- SPORTS FIRST ---
  try {
    const nflEvents = await fetchNFLEvents();
    const nflPreds = buildNFLPredictions(nflEvents).slice(0, 7);
    if (nflPreds.length > 0) {
      newPredictions.push(...nflPreds);
    } else {
      newPredictions.push({
        id: nextPredictionId++,
        source: "sports",
        Name: "No NFL games available right now",
        Description: "Check back later when new games are scheduled.",
        Answer1: "None",
        Answer2: "None",
        TimeHours: 24,
        created: now,
        expires: now + 24 * 60 * 60 * 1000,
        meta: { league: "NFL" }
      });
    }
  } catch (err) {
    console.warn("NFL fetch failed:", err.message);
  }

  // --- ROBLOX SECOND ---
  try {
    const movers = await fetchMovingLimiteds();
    const robloxPreds = buildRobloxPredictions(movers).slice(0, 7);
    if (robloxPreds.length > 0) {
      newPredictions.push(...robloxPreds);
    } else {
      newPredictions.push({
        id: nextPredictionId++,
        source: "roblox",
        Name: "No Roblox item movements detected",
        Description: "Check back later when more items are active.",
        Answer1: "None",
        Answer2: "None",
        TimeHours: 12,
        created: now,
        expires: now + 12 * 60 * 60 * 1000,
        meta: {}
      });
    }
  } catch (err) {
    console.warn("Roblox build failed:", err.message);
  }

  // --- WEATHER (limit 5 unique, no repeats) ---
  const weatherCities = (process.env.WEATHER_CITY || "Los Angeles,London,Tokyo")
    .split(",")
    .map((c) => c.trim());

  const chosenCities = [];
  const maxWeather = Math.min(weatherCities.length, 5);
  for (let i = 0; i < maxWeather; i++) {
    const city = weatherCities[i];
    const data = await fetchWeather(city);
    if (data) chosenCities.push({ city, data });
  }

  const weatherPreds = buildWeatherPredictions(chosenCities);
  newPredictions.push(...weatherPreds);

  // --- Attach IDs ---
  const fresh = newPredictions.map((p) => {
    if (!p.id) {
      p.id = nextPredictionId++;
      p.created = now;
      p.expires = now + p.TimeHours * 60 * 60 * 1000;
    }
    return p;
  });

  activePredictions = fresh;
  saveActive(activePredictions);
}

// === REFRESH LOOP ===
async function refreshPredictions() {
  await resolvePredictions();

  // filter expired
  const now = Date.now();
  activePredictions = activePredictions.filter((p) => p.expires > now);

  // refill back to 20 if needed
  if (activePredictions.length < 20) {
    await buildPredictions();
  }
}

setInterval(refreshPredictions, 5 * 60 * 1000);
await buildPredictions();

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
  console.log(`📅 NFL Season: ${NFL_SEASON}, Week: ${NFL_WEEK}`);
});
