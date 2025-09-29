// server.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const SPORTS_API_KEY = process.env.SPORTS_API_KEY || "1"; // SportsDB demo key
const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
const ASSET_IDS = process.env.ASSET_IDS ? process.env.ASSET_IDS.split(",") : ["125013769"];

// === HELPERS ===

// Roblox resale + name
async function fetchRobloxAsset(assetId) {
  const [resale, details] = await Promise.all([
    fetch(`https://economy.roblox.com/v1/assets/${assetId}/resale-data`).then(r => r.json()),
    fetch(`https://api.roblox.com/marketplace/productinfo?assetId=${assetId}`).then(r => r.json())
  ]);
  return { resale, name: details.Name || `Asset ${assetId}` };
}

// Weather (single city)
async function fetchWeather(city) {
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
    city
  )}&appid=${OPENWEATHER_KEY}&units=metric`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.json();
}

// Sports events
async function fetchSportsEvents(leagueId) {
  const url = `https://www.thesportsdb.com/api/v1/json/${SPORTS_API_KEY}/eventsnextleague.php?id=${leagueId}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return (await res.json()).events || [];
}

// === PREDICTION TEMPLATES ===

function buildRobloxPredictions(assets) {
  const templates = [
    (a, recent) => ({
      source: "roblox",
      Name: `Will ${a.name} exceed ${Math.ceil(recent * 1.1)} R$ in 12 hours?`,
      Description: `Current average: ${recent} R$.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 12
    }),
    (a, recent) => ({
      source: "roblox",
      Name: `Will ${a.name} drop below ${Math.floor(recent * 0.9)} R$ today?`,
      Description: `Recent average: ${recent} R$.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 24
    }),
    (a, recent) => ({
      source: "roblox",
      Name: `Will ${a.name}'s price stay between ${Math.floor(recent * 0.95)} and ${Math.ceil(recent * 1.05)} R$?`,
      Description: `Stable range prediction.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 24
    })
  ];

  const preds = [];
  for (const a of assets) {
    const recent = a.resale.recentAveragePrice ?? a.resale.averagePrice ?? 100;
    const randomTemplate = templates[Math.floor(Math.random() * templates.length)];
    preds.push(randomTemplate(a, recent));
  }
  return preds;
}

function buildWeatherPredictions(weather, city) {
  const templates = [
    (w) => ({
      source: "weather",
      Name: `Will it rain in ${city} in the next 24 hours?`,
      Description: `Current: ${w.weather[0].description}, ${Math.round(w.main.temp)}°C.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 24
    }),
    (w) => ({
      source: "weather",
      Name: `Will the temperature in ${city} exceed ${Math.round(w.main.temp + 3)}°C today?`,
      Description: `Now: ${Math.round(w.main.temp)}°C.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 24
    }),
    (w) => ({
      source: "weather",
      Name: `Will the temperature in ${city} drop below ${Math.round(w.main.temp - 3)}°C today?`,
      Description: `Now: ${Math.round(w.main.temp)}°C.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 24
    })
  ];
  return [templates[Math.floor(Math.random() * templates.length)](weather)];
}

function buildSportsPredictions(events, type = "football") {
  const templates = {
    football: [
      (ev) => ({
        source: "sports",
        Name: `Will ${ev.strHomeTeam} beat ${ev.strAwayTeam}?`,
        Description: `${ev.strHomeTeam} vs ${ev.strAwayTeam}, ${ev.dateEvent}.`,
        Answer1: ev.strHomeTeam,
        Answer2: ev.strAwayTeam,
        TimeHours: 48
      }),
      (ev) => ({
        source: "sports",
        Name: `Will ${ev.strHomeTeam} vs ${ev.strAwayTeam} go over 45 total points?`,
        Description: `Game date: ${ev.dateEvent}.`,
        Answer1: "Yes",
        Answer2: "No",
        TimeHours: 48
      }),
      (ev) => ({
        source: "sports",
        Name: `Will ${ev.strHomeTeam} vs ${ev.strAwayTeam} end in a 1-score game?`,
        Description: `Match date: ${ev.dateEvent}.`,
        Answer1: "Yes",
        Answer2: "No",
        TimeHours: 48
      })
    ],
    f1: [
      (ev) => ({
        source: "sports",
        Name: `Will ${ev.strEvent} be won by a Ferrari driver?`,
        Description: `Upcoming F1 race on ${ev.dateEvent}.`,
        Answer1: "Yes",
        Answer2: "No",
        TimeHours: 72
      }),
      (ev) => ({
        source: "sports",
        Name: `Will there be a safety car in ${ev.strEvent}?`,
        Description: `Scheduled: ${ev.dateEvent}.`,
        Answer1: "Yes",
        Answer2: "No",
        TimeHours: 72
      })
    ]
  };

  return events.slice(0, 5).map(ev => {
    const t = templates[type][Math.floor(Math.random() * templates[type].length)];
    return t(ev);
  });
}

// Shuffle array helper
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// === MAIN BUILDER ===
async function buildPredictions() {
  let predictions = [];

  // Roblox
  try {
    const assets = await Promise.all(ASSET_IDS.map(id => fetchRobloxAsset(id)));
    predictions.push(...buildRobloxPredictions(assets).slice(0, 5));
  } catch (err) {
    console.warn("Roblox fetch failed:", err.message);
  }

  // Weather (random city)
  if (OPENWEATHER_KEY) {
    const cities = (process.env.WEATHER_CITY || "London").split(",");
    const city = cities[Math.floor(Math.random() * cities.length)].trim();
    try {
      const weather = await fetchWeather(city);
      if (weather) predictions.push(...buildWeatherPredictions(weather, city));
    } catch (err) {
      console.warn("Weather fetch failed:", err.message);
    }
  }

  // Sports (NFL + F1)
  try {
    const nfl = await fetchSportsEvents("4391"); // NFL
    const f1 = await fetchSportsEvents("4370"); // F1
    predictions.push(...buildSportsPredictions(nfl, "football").slice(0, 5));
    predictions.push(...buildSportsPredictions(f1, "f1").slice(0, 5));
  } catch (err) {
    console.warn("Sports fetch failed:", err.message);
  }

  // Shuffle and limit: 5 from each type
  const roblox = predictions.filter(p => p.source === "roblox").slice(0, 5);
  const weather = predictions.filter(p => p.source === "weather").slice(0, 5);
  const sports = predictions.filter(p => p.source === "sports").slice(0, 5);

  return shuffle([...roblox, ...weather, ...sports]);
}

// === ROUTE ===
app.get("/predictions", async (req, res) => {
  try {
    const preds = await buildPredictions();
    res.json({ ok: true, predictions: preds });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Prediction proxy listening on port ${PORT}`);
});
