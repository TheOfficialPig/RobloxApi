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
const CACHE_TTL = 20 * 60 * 3000; // 20 minutes
let cache = {}; // { leagueId: { data, lastFetch } }
const DAYS_AHEAD = 14; // Upcoming window
const DAYS_BACK_COMPLETED = 2; // Recently completed window

// --- Helpers ---
function computeWinChance(decimalOdds) {
  if (!decimalOdds || decimalOdds <= 1) return 0.5;
  return 1 / decimalOdds;
}

function computeMultiplier(decimalOdds) {
  if (!decimalOdds) return 1.1;
  return Math.max(1.1, Math.min(3.5, decimalOdds * 0.97));
}

async function fetchMatches(league) {
  const cached = cache[league.id];
  const now = Date.now();
  if (cached && now - cached.lastFetch < CACHE_TTL) {
    console.log(`♻️ Using cached ${league.id.toUpperCase()} (${cached.data.length} games)`);
    return cached.data;
  }

  try {
    const url = `${BASE_URL}/${league.api}/odds/?apiKey=${API_KEY}&regions=us&markets=h2h&oddsFormat=decimal`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`❌ ${league.id.toUpperCase()} error: ${res.status}`);
      return cached?.data || [];
    }

    const data = await res.json();
    const matches = data
      .filter(game => {
        const start = new Date(game.commence_time);
        const diffAhead = (start - now) / (1000 * 60 * 60 * 24); // days ahead
        const diffBack = (now - start) / (1000 * 60 * 60 * 24);  // days back

        const isLive = !game.completed && start <= now;
        const isUpcoming = diffAhead >= 0 && diffAhead <= DAYS_AHEAD;
        const isRecentCompleted = game.completed && diffBack <= DAYS_BACK_COMPLETED;

        return isLive || isUpcoming || isRecentCompleted;
      })
      .map(game => {
        const home = game.home_team || "Home";
        const away = game.away_team || "Away";
        const odds = game.bookmakers?.[0]?.markets?.[0]?.outcomes || [];

        const homeOdds = odds.find(o => o.name === home)?.price ?? 2.0;
        const awayOdds = odds.find(o => o.name === away)?.price ?? 2.0;

        const homeChance = computeWinChance(homeOdds);
        const awayChance = computeWinChance(awayOdds);
        const total = homeChance + awayChance;

        // Determine status
        const start = new Date(game.commence_time);
        const status = game.completed
          ? "completed"
          : start <= new Date()
            ? "live"
            : "scheduled";

        return {
          MatchID: game.id,
          League: league.id.toUpperCase(),
          Scheduled: game.commence_time,
          Status: status,
          Venue: game.venue || "TBD",
          HomeTeam: {
            name: home,
            odds: homeOdds,
            winChance: homeChance / total,
            multiplier: computeMultiplier(homeOdds),
          },
          AwayTeam: {
            name: away,
            odds: awayOdds,
            winChance: awayChance / total,
            multiplier: computeMultiplier(awayOdds),
          },
          Winner: game.completed ? game.scores?.find(s => s.winner)?.name ?? null : null,
        };
      });

    console.log(`✅ ${league.id.toUpperCase()} fetched ${matches.length} games`);
    cache[league.id] = { data: matches, lastFetch: now };
    return matches;
  } catch (err) {
    console.error(`❌ ${league.id.toUpperCase()} fetch error:`, err);
    return cached?.data || [];
  }
}


// --- Routes ---
app.get("/getMatches/:league", async (req, res) => {
  const league = LEAGUES.find(l => l.id === req.params.league.toLowerCase());
  if (!league) return res.status(400).json({ error: "Invalid league" });

  const matches = await fetchMatches(league);
  res.json({ matches });
});

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
