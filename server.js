// server.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();


const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ODDS_API_KEY || "f547eaaf9d81defdd53c829deee7fd41";

const LEAGUES = [
  { id: "nfl", api: "americanfootball_nfl" },
  { id: "nba", api: "basketball_nba" },
  { id: "mlb", api: "baseball_mlb" },
  { id: "nhl", api: "icehockey_nhl" },
];

const BASE_URL = "https://api.the-odds-api.com/v4/sports";
const DAYS_AHEAD = 14;

function dateWithinRange(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const diff = (date - now) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= DAYS_AHEAD;
}

function computeWinChance(odds) {
  if (!odds) return 0.5;
  return 1 / (odds / 100 + 1);
}

function computeMultiplier(winChance) {
  const multiplier = (1 / winChance) * 0.97; // small edge
  return Math.max(1.1, Math.min(3.5, multiplier));
}

async function fetchMatches(league) {
  try {
    const url = `${BASE_URL}/${league.api}/odds/?apiKey=${API_KEY}&regions=us&markets=h2h&oddsFormat=decimal`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`❌ ${league.id.toUpperCase()} error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const now = new Date();

    const matches = data
      .filter(m => m.commence_time && dateWithinRange(m.commence_time))
      .map(game => {
        const home = game.home_team || "Home";
        const away = game.away_team || "Away";
        const odds = game.bookmakers?.[0]?.markets?.[0]?.outcomes || [];

        const homeOdds = odds.find(o => o.name === home)?.price ?? 2.0;
        const awayOdds = odds.find(o => o.name === away)?.price ?? 2.0;

        const homeChance = computeWinChance(homeOdds);
        const awayChance = computeWinChance(awayOdds);

        return {
          MatchID: game.id,
          League: league.id.toUpperCase(),
          Scheduled: game.commence_time,
          Status: game.completed ? "completed" : "scheduled",
          Venue: game.venue || "TBD",
          HomeTeam: {
            name: home,
            odds: homeOdds,
            winChance: homeChance,
            multiplier: computeMultiplier(homeChance),
          },
          AwayTeam: {
            name: away,
            odds: awayOdds,
            winChance: awayChance,
            multiplier: computeMultiplier(awayChance),
          },
          Winner: game.completed ? game.scores?.find(s => s.winner)?.name ?? null : null,
        };
      });

    console.log(`✅ ${league.id.toUpperCase()} pulled ${matches.length} games`);
    return matches;
  } catch (err) {
    console.error(`❌ ${league.id.toUpperCase()} fetch error:`, err);
    return [];
  }
}

// Route for Roblox
app.get("/getMatches/:league", async (req, res) => {
  const league = LEAGUES.find(l => l.id === req.params.league.toLowerCase());
  if (!league) return res.status(400).json({ error: "Invalid league" });

  const matches = await fetchMatches(league);
  res.json({ matches });
});

// Poll all
app.get("/getAllMatches", async (req, res) => {
  const results = {};
  for (const league of LEAGUES) {
    results[league.id] = await fetchMatches(league);
  }
  res.json(results);
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
