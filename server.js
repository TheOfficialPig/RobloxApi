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
const SPORTS_API_KEY = process.env.SPORTS_API_KEY || "1";

let activePredictions = loadActive();
let resolvedPredictions = loadResolved(20);

// === RAP HISTORY CACHE ===
// { assetId: [ {time, rap} ] }
let rapHistory = {};

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

// Roblox asset fetch (resale + catalog info)
async function fetchRobloxAsset(assetId) {
  try {
    const [resaleRes, assetRes] = await Promise.all([
      fetch(`https://economy.roblox.com/v1/assets/${assetId}/resale-data`),
      fetch(`https://catalog.roblox.com/v1/assets/${assetId}`)
    ]);
    if (!resaleRes.ok || !assetRes.ok) return null;

    const resale = await resaleRes.json();
    const info = (await assetRes.json()).data?.[0] || {};
    if (!resale || !info) return null;

    // Track RAP history
    const now = Date.now();
    rapHistory[info.id] = rapHistory[info.id] || [];
    rapHistory[info.id].push({ time: now, rap: resale.recentAveragePrice });
    // Keep only 24h history
    rapHistory[info.id] = rapHistory[info.id].filter(
      (r) => now - r.time < 24 * 60 * 60 * 1000
    );

    return { resale, info };
  } catch (err) {
    console.warn("Roblox fetch fail", assetId, err.message);
    return null;
  }
}

// Check if RAP moved ≥ 5% in last 12h
function hasBigMove(assetId) {
  const history = rapHistory[assetId];
  if (!history || history.length < 2) return false;

  const now = Date.now();
  const twelveHrsAgo = now - 12 * 60 * 60 * 1000;

  const oldPoint = history.find((h) => h.time >= twelveHrsAgo);
  const latest = history[history.length - 1];

  if (!oldPoint || !latest || !oldPoint.rap || !latest.rap) return false;

  const change = ((latest.rap - oldPoint.rap) / oldPoint.rap) * 100;
  return Math.abs(change) >= 5;
}

// Fetch Roblox Limiteds from catalog, then filter movers
async function fetchMovingLimiteds(limit = 30) {
  try {
    const searchUrl = `https://catalog.roblox.com/v1/search/items/details?Category=3&Subcategory=2&limit=${limit}`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) throw new Error(`Catalog search failed: ${searchRes.status}`);

    const items = (await searchRes.json()).data || [];
    const assets = await Promise.all(items.map((it) => fetchRobloxAsset(it.id)));

    return assets.filter((a) => a && hasBigMove(a.info.id));
  } catch (err) {
    console.warn("fetchMovingLimiteds error:", err.message);
    return [];
  }
}

// Sports
async function fetchSportsEvents(leagueId) {
  const url = `https://www.thesportsdb.com/api/v1/json/${SPORTS_API_KEY}/eventsnextleague.php?id=${leagueId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("SportsDB fetch failed");
  return (await res.json()).events || [];
}

async function fetchSportsResult(eventId) {
  const url = `https://www.thesportsdb.com/api/v1/json/${SPORTS_API_KEY}/lookupevent.php?id=${eventId}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.events ? data.events[0] : null;
}

// === PREDICTION BUILDERS ===
// Weather
function buildWeatherPredictions(weatherCities) {
  const predictions = [];
  const templates = [
    (city, w) => ({
      source: "weather",
      Name: `Will it rain in ${city} in the next 24 hours?`,
      Description: `${w.weather[0].description}, ${Math.round(w.main.temp)}°C now.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 24,
      meta: { city }
    }),
    (city, w) => ({
      source: "weather",
      Name: `Will the temperature in ${city} drop below 10°C in the next 24h?`,
      Description: `Currently ${Math.round(w.main.temp)}°C.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 24,
      meta: { city }
    })
  ];

  for (const city of weatherCities) {
    const choice = templates[Math.floor(Math.random() * templates.length)];
    predictions.push(choice(city.city, city.data));
  }

  return predictions.slice(0, 5);
}

// Roblox
function buildRobloxPredictions(assets) {
  const predictions = [];
  const templates = [
    (a) => {
      const target = Math.ceil((a.resale.recentAveragePrice || 100) * 1.1);
      return {
        source: "roblox",
        Name: `Will ${a.info.name} exceed ${target} R$ in 12 hours?`,
        Description: `Current average: ${a.resale.recentAveragePrice} R$.`,
        Answer1: "Yes",
        Answer2: "No",
        TimeHours: 12,
        meta: { target, assetId: a.info.id }
      };
    },
    (a) => ({
      source: "roblox",
      Name: `Will ${a.info.name}'s price drop below ${a.resale.lowestPrice} R$ soon?`,
      Description: `Lowest current: ${a.resale.lowestPrice} R$.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 12,
      meta: { target: a.resale.lowestPrice, assetId: a.info.id }
    })
  ];

  for (const asset of assets) {
    const choice = templates[Math.floor(Math.random() * templates.length)];
    predictions.push(choice(asset));
  }

  return predictions.slice(0, 5);
}

// NFL
function buildNFLPredictions(events) {
  const predictions = [];
  const templates = [
    (ev) => ({
      source: "sports",
      Name: `Will ${ev.strHomeTeam} beat ${ev.strAwayTeam}?`,
      Description: `${ev.strHomeTeam} vs ${ev.strAwayTeam} on ${ev.dateEvent}`,
      Answer1: ev.strHomeTeam,
      Answer2: ev.strAwayTeam,
      TimeHours: 48,
      meta: { eventId: ev.idEvent, league: "NFL" }
    }),
    (ev) => ({
      source: "sports",
      Name: `Will ${ev.strHomeTeam} vs ${ev.strAwayTeam} have more than 40 total points?`,
      Description: `Kickoff: ${ev.dateEvent}`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 48,
      meta: { eventId: ev.idEvent, market: "O/U 40", league: "NFL" }
    })
  ];

  for (const ev of events.slice(0, 5)) {
    const choice = templates[Math.floor(Math.random() * templates.length)];
    predictions.push(choice(ev));
  }

  return predictions;
}

// F1
function buildF1Predictions(events) {
  const predictions = [];
  const templates = [
    (ev) => ({
      source: "sports",
      Name: `Will ${ev.strEvent} winner be from Mercedes?`,
      Description: `Race: ${ev.strEvent} on ${ev.dateEvent}`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 72,
      meta: { eventId: ev.idEvent, league: "F1" }
    }),
    (ev) => ({
      source: "sports",
      Name: `Will there be a safety car in ${ev.strEvent}?`,
      Description: `Upcoming race ${ev.dateEvent}`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 72,
      meta: { eventId: ev.idEvent, league: "F1" }
    })
  ];

  for (const ev of events.slice(0, 5)) {
    const choice = templates[Math.floor(Math.random() * templates.length)];
    predictions.push(choice(ev));
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
        const asset = await fetchRobloxAsset(p.meta.assetId);
        const recent = asset.resale.recentAveragePrice ?? 0;
        result = recent >= p.meta.target ? "Yes" : "No";
      }

      if (p.source === "sports") {
        const ev = await fetchSportsResult(p.meta.eventId);
        if (p.meta.league === "NFL" && ev) {
          const home = parseInt(ev.intHomeScore);
          const away = parseInt(ev.intAwayScore);
          if (!isNaN(home) && !isNaN(away)) {
            if (p.meta.market === "O/U 40") {
              result = home + away > 40 ? "Yes" : "No";
            } else {
              if (home > away) result = ev.strHomeTeam;
              else if (away > home) result = ev.strAwayTeam;
              else result = "Draw";
            }
          }
        }
        if (p.meta.league === "F1" && ev) {
          result = ev.strResult || "No race result yet";
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

  // Roblox movers
  try {
    const movers = await fetchMovingLimiteds(50); // fetch 50, filter movers
    predictions.push(...buildRobloxPredictions(movers));
  } catch (err) {
    console.warn("Roblox movers fetch failed:", err.message);
  }

  // NFL
  try {
    const nflEvents = await fetchSportsEvents("4391");
    predictions.push(...buildNFLPredictions(nflEvents));
  } catch (err) {
    console.warn("NFL fetch failed:", err.message);
  }

  // F1
  try {
    const f1Events = await fetchSportsEvents("4370");
    predictions.push(...buildF1Predictions(f1Events));
  } catch (err) {
    console.warn("F1 fetch failed:", err.message);
  }

  // Attach expiry
  const now = Date.now();
  activePredictions = predictions.map((p) => ({
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
