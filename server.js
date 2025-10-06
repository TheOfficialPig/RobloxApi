import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const SPORTSRADAR_API_KEY = "YOUR_SPORTSRADAR_API_KEY"; // Keep private, never expose in Roblox
const PORT = process.env.PORT || 3000;

// Example: NFL Regular Season 2025 schedule
const SPORTS_URL = `https://api.sportradar.us/nfl/official/trial/v7/en/games/2025/REG/schedule.json?api_key=${SPORTSRADAR_API_KEY}`;

async function getCleanedMatches() {
  try {
    const res = await fetch(SPORTS_URL);
    const json = await res.json();

    const matches = json.weeks.flatMap(week =>
      week.games.map(game => ({
        MatchID: game.id,
        League: "NFL",
        Team1: game.home.name,
        Team2: game.away.name,
        StartTime: game.scheduled,
        Team1Stats: {
          Wins: game.home.record?.win || 0,
          Losses: game.home.record?.loss || 0,
          AvgPoints: Math.floor(Math.random() * 30) + 10, // placeholder
        },
        Team2Stats: {
          Wins: game.away.record?.win || 0,
          Losses: game.away.record?.loss || 0,
          AvgPoints: Math.floor(Math.random() * 30) + 10, // placeholder
        },
      }))
    );

    return matches;
  } catch (err) {
    console.error("Error fetching SportsRadar data:", err);
    return [];
  }
}

// Roblox fetches from here
app.get("/getMatches/nfl", async (req, res) => {
  const data = await getCleanedMatches();
  res.json(data);
});

app.listen(PORT, () => console.log(`✅ SportsStack Relay running on port ${PORT}`));
