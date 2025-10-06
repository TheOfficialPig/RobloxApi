import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// SportsRadar trial base URLs (adjust if you have premium endpoints)
const LEAGUE_ENDPOINTS = {
  NFL: `https://api.sportradar.us/nfl/official/trial/v7/en/games`,
  NBA: `https://api.sportradar.us/nba/trial/v8/en/games`,
  NHL: `https://api.sportradar.us/nhl/trial/v7/en/games`,
  MLB: `https://api.sportradar.us/mlb/trial/v7/en/games`,
};

const API_KEY = process.env.SPORTRADAR_KEY;

// 🗓️ Helper: build date range (today + 14 days)
function getDateRange() {
  const today = new Date();
  const end = new Date();
  end.setDate(today.getDate() + 14);

  const format = d => d.toISOString().split("T")[0];
  return { start: format(today), end: format(end) };
}

// 🧠 Get games for all leagues within date range
async function getUpcomingGames() {
  const { start, end } = getDateRange();
  const allMatches = [];

  for (const [league, baseUrl] of Object.entries(LEAGUE_ENDPOINTS)) {
    try {
      const url = `${baseUrl}/${start}/${end}/schedule.json?api_key=${API_KEY}`;
      const res = await fetch(url);

      if (!res.ok) {
        console.error(`❌ ${league} error: ${res.status}`);
        continue;
      }

      const data = await res.json();
      if (!data.games) continue;

      for (const g of data.games) {
        allMatches.push({
          MatchID: g.id,
          League: league,
          Scheduled: g.scheduled,
          Status: g.status,
          Venue: g.venue?.name || "Unknown",
          HomeTeam: {
            id: g.home?.id,
            name: g.home?.name,
          },
          AwayTeam: {
            id: g.away?.id,
            name: g.away?.name,
          },
        });
      }
    } catch (err) {
      console.error(`⚠️ ${league} fetch failed:`, err.message);
    }
  }

  return allMatches;
}

// 🧩 Route: Get next 14 days of matches
app.get("/matches", async (req, res) => {
  const matches = await getUpcomingGames();
  res.json(matches);
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
