const express = require("express");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;

/* ===========================
   ROBLOX MOVING LIMITEDS
=========================== */
async function fetchMovingLimiteds() {
  try {
    const url = "https://catalog.roblox.com/v1/search/items/details?Category=Collectibles&SortType=Updated";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Catalog search failed: ${res.status}`);
    const data = await res.json();

    const items = data.data || [];
    const now = Date.now();
    const cutoff = now - 12 * 60 * 60 * 1000; // last 12 hours

    const predictions = [];

    for (const item of items) {
      const resaleUrl = `https://economy.roblox.com/v1/assets/${item.id}/resale-data`;
      try {
        const resaleRes = await fetch(resaleUrl);
        if (!resaleRes.ok) continue;
        const resaleData = await resaleRes.json();

        if (!resaleData || !resaleData.priceDataPoints) continue;

        const recent = resaleData.priceDataPoints.filter(p => new Date(p.date).getTime() > cutoff);
        if (recent.length < 2) continue;

        const first = recent[0].value;
        const last = recent[recent.length - 1].value;
        const change = ((last - first) / first) * 100;

        if (Math.abs(change) >= 5) {
          predictions.push({
            id: item.id,
            name: item.name,
            description: item.description,
            type: "Roblox Limited",
            question: `Will the price of ${item.name} continue to move in the next 12h?`,
            change: change.toFixed(2) + "%"
          });
        }
      } catch (err) {
        console.error(`Failed resale fetch for ${item.id}:`, err.message);
      }
    }

    return predictions;
  } catch (err) {
    console.error("fetchMovingLimiteds error:", err.message);
    return [];
  }
}

/* ===========================
   WEATHER PREDICTIONS
=========================== */
async function fetchWeatherPredictions() {
  try {
    const cities = (process.env.WEATHER_CITY || "Los Angeles,London,Tokyo").split(",");
    const key = process.env.OPENWEATHER_KEY;
    const predictions = [];

    for (const city of cities) {
      const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${key}&units=metric`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();

      const temp = data.main.temp;
      const condition = data.weather[0].description;

      predictions.push({
        type: "Weather",
        question: `Will it rain in ${city} in the next 24h?`,
        description: `${condition}, ${temp}°C now.`
      });

      predictions.push({
        type: "Weather",
        question: `Will the temperature in ${city} drop below 10°C in the next 24h?`,
        description: `Currently ${temp}°C.`
      });
    }

    return predictions;
  } catch (err) {
    console.error("Weather fetch failed:", err.message);
    return [];
  }
}

/* ===========================
   NFL PLAYER & TEAM PROPS
=========================== */
async function fetchNFLPlayerProps() {
  try {
    const season = process.env.NFL_SEASON || "2024REG";
    const week = process.env.NFL_WEEK || "4";
    const url = `https://api.sportsdata.io/v3/nfl/projections/json/PlayerGameProjectionStatsByWeek/${season}/${week}?key=${process.env.SPORTSDATA_KEY}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`SportsData.io error: ${res.status}`);
    const data = await res.json();

    const predictions = [];

    data.forEach(player => {
      if (player.Position === "QB" && player.PassingYards) {
        predictions.push({
          type: "NFL Player Prop",
          question: `Will ${player.Name} throw over ${Math.round(player.PassingYards)} yards this week?`,
          team: player.Team
        });
      }
      if (player.Position === "RB" && player.RushingYards) {
        predictions.push({
          type: "NFL Player Prop",
          question: `Will ${player.Name} rush over ${Math.round(player.RushingYards)} yards this week?`,
          team: player.Team
        });
      }
      if ((player.Position === "WR" || player.Position === "TE") && player.Receptions) {
        predictions.push({
          type: "NFL Player Prop",
          question: `Will ${player.Name} catch over ${Math.round(player.Receptions)} passes this week?`,
          team: player.Team
        });
      }
    });

    return predictions.slice(0, 20); // limit props
  } catch (err) {
    console.error("NFL player props fetch failed:", err.message);
    return [];
  }
}

/* ===========================
   MAIN ENDPOINT
=========================== */
app.get("/predictions", async (req, res) => {
  const allPredictions = [];

  const [roblox, weather, nflProps] = await Promise.all([
    fetchMovingLimiteds(),
    fetchWeatherPredictions(),
    fetchNFLPlayerProps()
  ]);

  allPredictions.push(...roblox, ...weather, ...nflProps);

  res.json({
    ok: true,
    count: allPredictions.length,
    predictions: allPredictions
  });
});

/* ===========================
   START SERVER
=========================== */
app.listen(PORT, () => {
  console.log(`Prediction server running on port ${PORT}`);
});
