// server.js
import express from "express";
import fetch from "node-fetch"; // or global fetch in Node 18+
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Example config via environment variables
const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY; // weather API
const SPORTS_API_KEY = process.env.SPORTS_API_KEY;   // optional sports API
// Roblox economy endpoints are public -- no key needed

// Helper: get resale data for an asset
async function fetchRobloxResale(assetId) {
  const url = `https://economy.roblox.com/v1/assets/${assetId}/resale-data`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Roblox economy fetch failed");
  return await res.json();
}

// Example: get weather forecast for a city (OpenWeatherMap)
async function fetchWeather(city) {
  if (!OPENWEATHER_KEY) return null;
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${OPENWEATHER_KEY}&units=metric`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.json();
}

// Example: build predictions array
async function buildPredictions() {
  const predictions = [];

  // 1) Roblox economy example: monitor 1+ asset IDs (put any asset IDs you care about)
  const assetIds = process.env.ASSET_IDS ? process.env.ASSET_IDS.split(",") : ["12345678"];
  for (const assetId of assetIds) {
    try {
      const data = await fetchRobloxResale(assetId);
      // data contains minimum, maximum, recentAveragePrice, etc.
      const recent = data.recentAveragePrice or data.averagePrice or data.lowestPrice or 0;
      // Create a prediction: will resale price exceed recent * 1.1 within 12 hours
      const target = Math.ceil((data.recentAveragePrice || data.averagePrice || 100) * 1.10);
      predictions.push({
        source: "roblox_economy",
        assetId,
        Name: `Will asset ${assetId} exceed ${target} R$ in 12 hours?`,
        Description: `Current average: ${data.recentAveragePrice || data.averagePrice || "N/A"} R$.`,
        Answer1: "Yes",
        Answer2: "No",
        TimeHours: 12,
        meta: { target, recent: data.recentAveragePrice || data.averagePrice }
      });
    } catch (err) {
      console.warn("asset fetch failed", assetId, err.message);
    }
  }

  // 2) Weather example
  const weatherCity = process.env.WEATHER_CITY || "London";
  const weather = await fetchWeather(weatherCity);
  if (weather) {
    const willRain = (weather.weather || []).some(w => /rain|shower/i.test(w.main || w.description || ""));
    predictions.push({
      source: "weather",
      Name: `Will it rain in ${weatherCity} in the next 24 hours?`,
      Description: `Current: ${weather.weather[0].description}, ${Math.round(weather.main.temp)}°C.`,
      Answer1: "Yes",
      Answer2: "No",
      TimeHours: 24,
      meta: { willRain }
    });
  }

  // 3) Sports (example stub) — replace with a real sports API if you have one
  // predictions.push({ ... });

  return predictions;
}

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
