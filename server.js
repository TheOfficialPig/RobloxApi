// server.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const SPORTS_API_KEY = process.env.SPORTS_API_KEY || "1";
const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
const ASSET_IDS = process.env.ASSET_IDS ? process.env.ASSET_IDS.split(",") : ["125013769"];

// =============== STATE STORAGE ===============
let activePredictions = []; // live predictions waiting for resolution
let resolvedPredictions = []; // finished with results

// =============== HELPERS (same as before) ===============
async function fetchRobloxAsset(assetId) {
  const [resale, details] = await Promise.all([
    fetch(`https://economy.roblox.com/v1/assets/${assetId}/resale-data`).then(r => r.json()),
    fetch(`https://api.roblox.com/marketplace/productinfo?assetId=${assetId}`).then(r => r.json())
  ]);
  return { resale, name: details.Name || `Asset ${assetId}` };
}

async function fetchWeather(city) {
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
    city
  )}&appid=${OPENWEATHER_KEY}&units=metric`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.json();
}

async function fetchSportsEvents(leagueId) {
  const url = `https://www.thesportsdb.com/api/v1/json/${SPORTS_API_KEY}/eventsnextleague.php?id=${leagueId}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return (await res.json()).events || [];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// =============== BUILD NEW PREDICTIONS ===============
async function buildPredictions() {
  let predictions = [];

  // Roblox
  try {
    const assets = await Promise.all(ASSET_IDS.map(id => fetchRobloxAsset(id)));
    for (const a of assets) {
      const recent = a.resale.recentAveragePrice ?? a.resale.averagePrice ?? 100;
      const target = Math.ceil(recent * 1.1);
      predictions.push({
        source: "roblox",
        Name: `Will ${a.name} exceed ${target} R$ in 12 hours?`,
        Answer1: "Yes",
        Answer2: "No",
        created: Date.now(),
        expires: Date.now() + 12 * 60 * 60 * 1000,
        meta: { assetId: a.id, target, recent }
      });
    }
  } catch (err) {
    console.warn("Roblox fetch failed:", err.message);
  }

  // Weather
  if (OPENWEATHER_KEY) {
    const cities = (process.env.WEATHER_CITY || "London").split(",");
    const city = cities[Math.floor(Math.random() * cities.length)].trim();
    try {
      const weather = await fetchWeather(city);
      if (weather) {
        const willRain = (weather.weather || []).some(w =>
          /rain|shower/i.test(w.main || w.description || "")
        );
        predictions.push({
          source: "weather",
          Name: `Will it rain in ${city} in the next 6 hours?`,
          Answer1: "Yes",
          Answer2: "No",
          created: Date.now(),
          expires: Date.now() + 6 * 60 * 60 * 1000,
          meta: { city, willRainNow: willRain }
        });
      }
    } catch (err) {
      console.warn("Weather fetch failed:", err.message);
    }
  }

  // Sports (NFL + F1)
  try {
    const nfl = await fetchSportsEvents("4391"); // NFL
    const f1 = await fetchSportsEvents("4370"); // F1
    for (const ev of nfl.slice(0, 3)) {
      predictions.push({
        source: "sports",
        Name: `Will ${ev.strHomeTeam} beat ${ev.strAwayTeam}?`,
        Answer1: ev.strHomeTeam,
        Answer2: ev.strAwayTeam,
        created: Date.now(),
        expires: Date.now() + 48 * 60 * 60 * 1000,
        meta: { eventId: ev.idEvent }
      });
    }
    for (const ev of f1.slice(0, 2)) {
      predictions.push({
        source: "sports",
        Name: `Will there be a safety car in ${ev.strEvent}?`,
        Answer1: "Yes",
        Answer2: "No",
        created: Date.now(),
        expires: Date.now() + 72 * 60 * 60 * 1000,
        meta: { eventId: ev.idEvent }
      });
    }
  } catch (err) {
    console.warn("Sports fetch failed:", err.message);
  }

  return shuffle(predictions).slice(0, 15); // max 15 (5 per category idea)
}

// =============== RESOLVE EXPIRED PREDICTIONS ===============
async function resolvePredictions() {
  const now = Date.now();
  const stillActive = [];
  for (const p of activePredictions) {
    if (now < p.expires) {
      stillActive.push(p);
    } else {
      // expired → resolve using latest API data
      let result = "No Result";
      try {
        if (p.source === "weather") {
          const weather = await fetchWeather(p.meta.city);
          const raining = (weather.weather || []).some(w =>
            /rain|shower/i.test(w.main || w.description || "")
          );
          result = raining ? "Yes" : "No";
        }
        if (p.source === "roblox") {
          const asset = await fetchRobloxAsset(p.meta.assetId);
          const recent = asset.resale.recentAveragePrice ?? 0;
          result = recent >= p.meta.target ? "Yes" : "No";
        }
        if (p.source === "sports") {
          // sports results would require results API
          // stub here → mark unresolved
          result = "Pending sports result";
        }
      } catch (err) {
        console.warn("Resolve error", err.message);
      }
      resolvedPredictions.push({ ...p, result });
    }
  }
  activePredictions = stillActive;
}

// =============== BACKGROUND JOB ===============
// Every 5 minutes → refresh predictions + resolve old ones
setInterval(async () => {
  await resolvePredictions();
  if (activePredictions.length < 15) {
    const newPreds = await buildPredictions();
    activePredictions.push(...newPreds);
  }
}, 5 * 60 * 1000);

// =============== ROUTES ===============
app.get("/predictions", (req, res) => {
  res.json({ ok: true, active: activePredictions, resolved: resolvedPredictions });
});

app.listen(PORT, () => {
  console.log(`Prediction proxy listening on port ${PORT}`);
});
