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

let activePredictions = loadActive();
let resolvedPredictions = loadResolved(20);

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

// === ROBLOX (via Rolimons) ===
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
        const [
          name, // 0
          recentAveragePrice, // 1
          originalPrice, // 2
          demand, // 3
          rarity, // 4
          projected // 5
        ] = details;

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

    // TEMP: simulate % movement (replace with real cache later)
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
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/Schedule/2025REG?key=${SPORTSDATA_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Sportsdata NFL fetch failed");
  return await res.json();
}

async function fetchNFLGameResult(gameId) {
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/ScoresByWeek/2025REG/1?key=${SPORTSDATA_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const games = await res.json();
  return games.find((g) => g.GameKey === gameId) || null;
}

// === PREDICTION BUILDERS ===

// === WEATHER PREDICTIONS ===
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

  return predictions.slice(0, 5);
}

// === ROBLOX PREDICTIONS ===
function buildRobloxPredictions(assets) {
  const predictions = [];

  for (const a of assets) {
    const current = a.recentAveragePrice;
    const target = current + (Math.random() < 0.5 ? -Math.floor(current * 0.1) : Math.floor(current * 0.1));

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

  return predictions.slice(0, 5);
}

// === NFL PREDICTIONS ===
function buildNFLPredictions(events) {
  const predictions = [];

  for (const ev of events.slice(0, 5)) {
    const line = 35 + Math.floor(Math.random() * 15); // random O/U line between 35–50

    predictions.push({
      source: "sports",
      Name: `Will ${ev.HomeTeam} vs ${ev.AwayTeam} total score be over/under ${line}?`,
      Description: `Kickoff: ${ev.Date} (Home: ${ev.HomeTeam}, Away: ${ev.AwayTeam})`,
      Answer1: `Over ${line}`,
      Answer2: `Under ${line}`,
      TimeHours: 48,
      meta: { eventId: ev.GameKey, market: `O/U ${line}`, league: "NFL", line }
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
        const raining = (weather.weather || []).some((w) =>
          /rain|shower/i.test(w.main || w.description || "")
        );
        if (p.Name.includes("rain")) result = raining ? "Yes" : "No";
        else if (p.Name.includes("drop below"))
          result = weather.main.temp < 10 ? "Yes" : "No";
      }

      if (p.source === "roblox") {
        // Simple re-check against target
        const asset = await fetchMovingLimiteds();
        const match = asset.find((a) => a.assetId === p.meta.assetId);
        if (match) {
          const recent = match.recentAveragePrice ?? 0;
          result = recent >= p.meta.target ? "Yes" : "No";
        }
      }

      if (p.source === "sports") {
        const ev = await fetchNFLGameResult(p.meta.eventId);
        if (p.meta.league === "NFL" && ev) {
          const home = parseInt(ev.HomeScore);
          const away = parseInt(ev.AwayScore);
          if (!isNaN(home) && !isNaN(away)) {
            if (p.meta.market === "O/U 40") {
              result = home + away > 40 ? "Yes" : "No";
            } else {
              if (home > away) result = ev.HomeTeam;
              else if (away > home) result = ev.AwayTeam;
              else result = "Draw";
            }
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

// === BUILDER ===
async function buildPredictions() {
  const predictions = [];

  // Weather
  const weatherCities = (process.env.WEATHER_CITY || "Los Angeles,London,Tokyo")
    .split(",")
    .map((c) => c.trim());
  const chosenCities = [];
  for (let i = 0; i < 5; i++) {
    const city = weatherCities[Math.floor(Math.random() * weatherCities.length)];
    const data = await fetchWeather(city);
    if (data) chosenCities.push({ city, data });
  }
  predictions.push(...buildWeatherPredictions(chosenCities));

  // Roblox
  try {
    const movers = await fetchMovingLimiteds();
    predictions.push(...buildRobloxPredictions(movers));
  } catch (err) {
    console.warn("Roblox build failed:", err.message);
  }

  // NFL
  try {
    const nflEvents = await fetchNFLEvents();
    predictions.push(...buildNFLPredictions(nflEvents));
  } catch (err) {
    console.warn("NFL fetch failed:", err.message);
  }

  // Attach expiry
  const now = Date.now();
  activePredictions = predictions.map((p, i) => ({
    id: i + 1,
    ...p,
    created: now,
    expires: now + p.TimeHours * 60 * 60 * 1000
  }));
  saveActive(activePredictions);
}

// === REFRESH LOOP ===
async function refreshPredictions() {
  await resolvePredictions();
  await buildPredictions();
}

setInterval(refreshPredictions, 5 * 60 * 1000);
await buildPredictions();

// === ROUTES ===
app.get("/predictions", (req, res) => {
  res.json({
    ok: true,
    active: loadActive().slice(0, 15),
    resolved: loadResolved(20)
  });
});

app.listen(PORT, () => {
  console.log(`Prediction server running on port ${PORT}`);
});
