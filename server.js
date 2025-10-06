// server.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SPORTRADAR_API_KEY;

const LEAGUES = [
  { id: "nfl", path: "nfl/official/trial/v7/en" },
  { id: "nba", path: "nba/trial/v8/en" },
  { id: "mlb", path: "mlb/trial/v7/en" },
  { id: "nhl", path: "nhl/trial/v7/en" },
];

const ODDS_PATH = "oddscomparison/trial/v1/en";
const daysAhead = 14;

// --- Helper: check if game is within next 14 days ---
function within14Days(dateStr) {
  const now = new Date();
  const gameDate = new Date(dateStr);
  const diff = (gameDate - now) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= daysAhead;
}

// --- Safe fetch wrapper ---
async function safeFetch(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

app.get("/matches", async (req, res) => {
  const allMatches = [];

  for (const league of LEAGUES) {
    try {
      const scheduleUrl = `https://api.sportradar.us/${league.path}/games/2025/REG/schedule.json?api_key=${API_KEY}`;
      const schedule = await safeFetch(scheduleUrl);

      if (!schedule) {
        console.log(`❌ ${league.id.toUpperCase()} error: schedule not available`);
        continue;
      }

      const games = schedule.games || schedule.weeks?.flatMap(w => w.games) || [];
      const filtered = games.filter(g => within14Days(g.scheduled));

      console.log(`✅ ${league.id.toUpperCase()}: Found ${filtered.length} games in next 14 days`);

      for (const game of filtered) {
        const homeTeam = game.home || game.home_team || {};
        const awayTeam = game.away || game.away_team || {};

        // --- Team stats ---
        const [homeStats, awayStats] = await Promise.all([
          safeFetch(`https://api.sportradar.us/${league.path}/teams/${homeTeam.id}/profile.json?api_key=${API_KEY}`),
          safeFetch(`https://api.sportradar.us/${league.path}/teams/${awayTeam.id}/profile.json?api_key=${API_KEY}`),
        ]);

        if (!homeStats)
          console.log(`⚠️ Missing stats for ${homeTeam.name} (${league.id.toUpperCase()})`);
        if (!awayStats)
          console.log(`⚠️ Missing stats for ${awayTeam.name} (${league.id.toUpperCase()})`);

        // --- Win % fallback ---
        const homeWinPct =
          homeStats?.record?.overall?.win_pct ??
          (homeStats?.statistics?.wins /
            (homeStats?.statistics?.wins + homeStats?.statistics?.losses)) ??
          0.5;
        const awayWinPct =
          awayStats?.record?.overall?.win_pct ??
          (awayStats?.statistics?.wins /
            (awayStats?.statistics?.wins + awayStats?.statistics?.losses)) ??
          0.5;

        // --- Odds (if available) ---
        const oddsUrl = `https://api.sportradar.us/${ODDS_PATH}/${league.id}/events/${game.id}/odds.json?api_key=${API_KEY}`;
        const oddsData = await safeFetch(oddsUrl);

        let odds = null;
        if (oddsData?.bookmakers?.length) {
          const firstBook = oddsData.bookmakers[0];
          const homeOdds = firstBook.markets?.[0]?.outcomes?.find(o => o.name === homeTeam.name);
          const awayOdds = firstBook.markets?.[0]?.outcomes?.find(o => o.name === awayTeam.name);
          odds = {
            bookmaker: firstBook.name,
            home: homeOdds?.odds_decimal ?? null,
            away: awayOdds?.odds_decimal ?? null,
          };
        }

        // --- Win chance and multipliers ---
        const total = homeWinPct + awayWinPct || 1;
        const homeChance = homeWinPct / total;
        const awayChance = awayWinPct / total;

        const homeMultiplier = odds?.home ?? (1 / homeChance) * 0.97;
        const awayMultiplier = odds?.away ?? (1 / awayChance) * 0.97;

        allMatches.push({
          MatchID: game.id,
          League: league.id.toUpperCase(),
          Scheduled: game.scheduled,
          Venue: game.venue?.name ?? "TBD",
          Status: game.status ?? "scheduled",
          Odds: odds,
          HomeTeam: {
            id: homeTeam.id,
            name: homeTeam.name,
            wins: homeStats?.statistics?.wins ?? 0,
            losses: homeStats?.statistics?.losses ?? 0,
            winPct: homeWinPct,
            avgPoints: homeStats?.statistics?.points_per_game ?? null,
            passingYards: homeStats?.statistics?.passing_yards_per_game ?? null,
            rushingYards: homeStats?.statistics?.rushing_yards_per_game ?? null,
            winChance: homeChance,
            multiplier: homeMultiplier,
          },
          AwayTeam: {
            id: awayTeam.id,
            name: awayTeam.name,
            wins: awayStats?.statistics?.wins ?? 0,
            losses: awayStats?.statistics?.losses ?? 0,
            winPct: awayWinPct,
            avgPoints: awayStats?.statistics?.points_per_game ?? null,
            passingYards: awayStats?.statistics?.passing_yards_per_game ?? null,
            rushingYards: awayStats?.statistics?.rushing_yards_per_game ?? null,
            winChance: awayChance,
            multiplier: awayMultiplier,
          },
        });
      }
    } catch (err) {
      console.log(`❌ ${league.id.toUpperCase()} error: ${err.message}`);
    }
  }

  res.json(allMatches);
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
