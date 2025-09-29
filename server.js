// server.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
const SPORTS_API_KEY = process.env.SPORTS_API_KEY || "1"; // demo key

// Default leagues
const FOOTBALL_LEAGUE_ID = "4328"; // EPL
const F1_LEAGUE_ID = "4370"; // Formula 1

// === HELPERS ===

// ROBLOX ECONOMY
async function fetchRobloxResale(assetId) {
  const url = `https://economy.roblox.com/v1/assets/${assetId}/resale-data`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Roblox economy fetch failed");
  return await res.json();
}

async function fetchRobloxItem(assetId) {
  const url = `https://catalog.roblox.com/v1/assets?assetIds=${assetId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Roblox catalog fetch failed");
  const data = await res.json();
  return data.data?.[0]?.name || `Asset ${assetId}`;
}

// WEATHER
async function fetchWeather(city) {
  if (!OPENWEATHER_KEY) return null;
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
    city
  )}&appid=${OPENWEATHER_KEY}&units=metric`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.json();
}

// SPORTS
async function fetchSportsEvents(leagueId) {
  const url = `https://www.thesportsdb.com/api/v1/json/${SPORTS_API_KEY}/eventsnextleague.php?id=${leagueId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("SportsDB fetch failed");
  return (await res.json()).events || [];
}

// === TEMPLATES ===

// Roblox
function buildRobloxPredictions(assetName, data) {
  const recent =
    data.recentAveragePrice ?? data.averagePrice ?? data.lowestPrice ?? 0;
  const templates = [
    () => ({
      source: "roblox_economy",
      Name: `Will ${assetName} exceed ${Math.ceil(recent * 1.1)} R$ in 12 hours?`,
      Description: `Current average: ${recent} R$.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 12,
    }),
    () => ({
      source: "roblox_economy",
      Name: `Will ${assetName} drop below ${Math.floor(recent * 0.9)} R$ today?`,
      Description: `Current average: ${recent} R$.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 24,
    }),
    () => ({
      source: "roblox_economy",
      Name: `Will ${assetName} gain at least 50 R$ in value within 24 hours?`,
      Description: `Current average: ${recent} R$.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 24,
    }),
  ];

  return [templates[Math.floor(Math.random() * templates.length)]()];
}

// Weather
function buildWeatherPredictions(city, weather) {
  const temp = Math.round(weather.main.temp);
  const desc = weather.weather[0].description;
  const templates = [
    () => ({
      source: "weather",
      Name: `Will it rain in ${city} in the next 24 hours?`,
      Description: `Currently: ${desc}, ${temp}°C.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 24,
    }),
    () => ({
      source: "weather",
      Name: `Will the temperature in ${city} rise above ${temp + 3}°C today?`,
      Description: `Currently ${temp}°C with ${desc}.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 24,
    }),
    () => ({
      source: "weather",
      Name: `Will ${city} stay dry and sunny today?`,
      Description: `Currently ${desc}, ${temp}°C.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 24,
    }),
  ];

  return [templates[Math.floor(Math.random() * templates.length)]()];
}

// Football predictions
function buildFootballPredictions(events) {
  const predictions = [];
  const templates = [
    (ev) => ({
      source: "football",
      Name: `Will ${ev.strHomeTeam} beat ${ev.strAwayTeam}?`,
      Description: `${ev.strHomeTeam} vs ${ev.strAwayTeam}, ${ev.dateEvent}.`,
      Answer1: ev.strHomeTeam,
      Answer2: ev.strAwayTeam,
      TimeHours: 48,
    }),
    (ev) => ({
      source: "football",
      Name: `Will ${ev.strHomeTeam} vs ${ev.strAwayTeam} end in a draw?`,
      Description: `Match date: ${ev.dateEvent}.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 48,
    }),
    (ev) => ({
      source: "football",
      Name: `Will there be over 2.5 goals in ${ev.strHomeTeam} vs ${ev.strAwayTeam}?`,
      Description: `Upcoming match on ${ev.dateEvent}.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 48,
    }),
    (ev) => ({
      source: "football",
      Name: `Will ${ev.strHomeTeam} score first against ${ev.strAwayTeam}?`,
      Description: `Kickoff: ${ev.dateEvent}.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 48,
    }),
  ];

  for (const ev of events.slice(0, 5)) {
    const randomTemplate =
      templates[Math.floor(Math.random() * templates.length)];
    predictions.push(randomTemplate(ev));
  }

  return predictions;
}

// Formula 1 predictions
function buildF1Predictions(events) {
  const predictions = [];
  const templates = [
    (ev) => ({
      source: "f1",
      Name: `Will ${ev.strEvent} be won by a Mercedes driver?`,
      Description: `${ev.strEvent} on ${ev.dateEvent}.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 72,
    }),
    (ev) => ({
      source: "f1",
      Name: `Will there be a Ferrari driver on the podium at ${ev.strEvent}?`,
      Description: `Race date: ${ev.dateEvent}.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 72,
    }),
    (ev) => ({
      source: "f1",
      Name: `Will ${ev.strEvent} have a safety car deployment?`,
      Description: `${ev.strEvent} on ${ev.dateEvent}.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 72,
    }),
    (ev) => ({
      source: "f1",
      Name: `Will Red Bull win ${ev.strEvent}?`,
      Description: `Race date: ${ev.dateEvent}.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 72,
    }),
  ];

  for (const ev of events.slice(0, 3)) {
    const randomTemplate =
      templates[Math.floor(Math.random() * templates.length)];
    predictions.push(randomTemplate(ev));
  }

  return predictions;
}

// === MASTER BUILDER ===
async function buildPredictions() {
  const predictions = [];

  // 1) Roblox
  const assetIds = process.env.ASSET_IDS
    ? process.env.ASSET_IDS.split(",")
    : ["125880153"];
  for (const assetId of assetIds) {
    try {
      const [resale, name] = await Promise.all([
        fetchRobloxResale(assetId),
        fetchRobloxItem(assetId),
      ]);
      predictions.push(...buildRobloxPredictions(name, resale));
    } catch (err) {
      console.warn("Roblox fetch failed", assetId, err.message);
    }
  }

  // 2) Weather
  const weatherCity = process.env.WEATHER_CITY || "London";
  const weather = await fetchWeather(weatherCity);
  if (weather) {
    predictions.push(...buildWeatherPredictions(weatherCity, weather));
  }

  // 3) Football
  try {
    const events = await fetchSportsEvents(FOOTBALL_LEAGUE_ID);
    predictions.push(...buildFootballPredictions(events));
  } catch (err) {
    console.warn("Football fetch failed:", err.message);
  }

  // 4) Formula 1
  try {
    const events = await fetchSportsEvents(F1_LEAGUE_ID);
    predictions.push(...buildF1Predictions(events));
  } catch (err) {
    console.warn("F1 fetch failed:", err.message);
  }

  return predictions;
}

// === ROUTES ===
app.get("/predictions", async (req, res) => {
  try {
    const preds = await buildPredictions();
    res.json({ ok: true, predictions: preds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Prediction proxy listening on port ${PORT}`);
});
