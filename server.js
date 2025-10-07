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
const CACHE_TTL = 20 * 60 * 1000; // 20 minutes
const DAYS_AHEAD = 14;
const DAYS_BACK_COMPLETED = 2;

let cache = {}; // { leagueId: { data, lastFetch } }

function computeWinChance(decimalOdds) {
  if (!decimalOdds || decimalOdds <= 1) return 0.5;
  return 1 / decimalOdds;
}

function computeMultiplier(decimalOdds) {
  if (!decimalOdds) return 1.1;
  return Math.max(1.1, Math.min(3.5, decimalOdds * 0.97));
}

async function fetchMatches(league) {
  const now = Date.now();
  const cached = cache[league.id];
  if (cached && now - cached.lastFetch < CACHE_TTL) {
    console.log(`♻️ Using cached ${league.id.toUpperCase()} (${cached.data.length} games)`);
    return cached.data;
  }

  try {
    // Fetch upcoming/live games
    const oddsUrl = `${BASE_URL}/${league.api}/odds/?apiKey=${API_KEY}&regions=us&markets=h2h&oddsFormat=decimal`;
    const oddsRes = await fetch(oddsUrl);
    const oddsData = oddsRes.ok ? await oddsRes.json() : [];

    // Fetch recently completed games
    const scoresUrl = `${BASE_URL}/${league.api}/scores/?apiKey=${API_KEY}&daysFrom=${DAYS_BACK_COMPLETED}`;
    const scoresRes = await fetch(scoresUrl);
    const scoreData = scoresRes.ok ? await scoresRes.json() : [];

    // Build match list
    const matches = oddsData
      .filter(game => {
        const start = new Date(game.commence_time);
        const diff = (start - now) / (1000 * 60 * 60 * 24);
        return diff >= -0.5 && diff <= DAYS_AHEAD;
      })
      .map(game => {
        const home = game.home_team || "Home";
        const away = game.away_team || "Away";
        const outcomes = game.bookmakers?.[0]?.markets?.[0]?.outcomes || [];

        const homeOdds = outcomes.find(o => o.name === home)?.price ?? 2.0;
        const awayOdds = outcomes.find(o => o.name === away)?.price ?? 2.0;

        const homeChance = computeWinChance(homeOdds);
        const awayChance = computeWinChance(awayOdds);
        const total = homeChance + awayChance;

        const start = new Date(game.commence_time);
        const status =
          game.completed ? "completed" :
          start <= new Date() ? "live" : "scheduled";

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
          Winner: null, // filled later if completed
        };
      });

    // Merge completed game data (ensure Winner filled)
    for (const score of scoreData) {
      const existing = matches.find(m => m.MatchID === score.id);
      const home = score.home_team || "Home";
      const away = score.away_team || "Away";

      let winner = null;
      if (score.completed && score.scores?.length >= 2) {
        const [s1, s2] = score.scores;
        if (s1.score > s2.score) winner = s1.name;
        else if (s2.score > s1.score) winner = s2.name;
      }

      const gameObj = {
        MatchID: score.id,
        League: league.id.toUpperCase(),
        Scheduled: score.commence_time,
        Status: score.completed ? "completed" : "scheduled",
        Venue: score.venue || "TBD",
        HomeTeam: { name: home, odds: 2.0, winChance: 0.5, multiplier: 1.1 },
        AwayTeam: { name: away, odds: 2.0, winChance: 0.5, multiplier: 1.1 },
        Winner: winner,
      };

      if (existing) {
        existing.Status = "completed";
        existing.Winner = winner;
      } else if (score.completed) {
        matches.push(gameObj);
      }
    }

    console.log(`✅ ${league.id.toUpperCase()} fetched ${matches.length} games`);
    cache[league.id] = { data: matches, lastFetch: now };
    return matches;
  } catch (err) {
    console.error(`❌ ${league.id.toUpperCase()} fetch error:`, err);
    return cache[league.id]?.data || [];
  }
}

// Routes
app.get("/getMatches/:league", async (req, res) => {
  const league = LEAGUES.find(l => l.id === req.params.league.toLowerCase());
  if (!league) return res.status(400).json({ error: "Invalid league" });
  const matches = await fetchMatches(league);
  res.json({ matches });
});

app.get("/getAllMatches", async (req, res) => {
  const all = {};
  for (const league of LEAGUES) {
    all[league.id] = await fetchMatches(league);
  }
  res.json(all);
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
