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

// 🗓️ Helper to check if a date is within the next 14 days
function isWithinNext14Days(dateStr) {
  const gameDate = new Date(dateStr);
  const now = new Date();
  const in14 = new Date();
  in14.setDate(now.getDate() + 14);
  return gameDate >= now && gameDate <= in14;
}

app.get("/matches", async (req, res) => {
  try {
    const allMatches = [];

    for (const league of LEAGUES) {
      const scheduleUrl = `https://api.sportradar.us/${league.path}/games/2025/REG/schedule.json?api_key=${API_KEY}`;
      const scheduleRes = await fetch(scheduleUrl);
      if (!scheduleRes.ok) continue;
      const schedule = await scheduleRes.json();

      if (!schedule.weeks && !schedule.games) continue;

      const games = schedule.games || schedule.weeks?.flatMap(w => w.games) || [];

      for (const game of games) {
        // ✅ Only keep games happening today or within 14 days
        if (!isWithinNext14Days(game.scheduled)) continue;

        const homeTeam = game.home || game.home_team || {};
        const awayTeam = game.away || game.away_team || {};

        const statsUrlHome = `https://api.sportradar.us/${league.path}/teams/${homeTeam.id}/profile.json?api_key=${API_KEY}`;
        const statsUrlAway = `https://api.sportradar.us/${league.path}/teams/${awayTeam.id}/profile.json?api_key=${API_KEY}`;
        const [homeStatsRes, awayStatsRes] = await Promise.all([
          fetch(statsUrlHome),
          fetch(statsUrlAway),
        ]);

        const homeStats = homeStatsRes.ok ? await homeStatsRes.json() : {};
        const awayStats = awayStatsRes.ok ? await awayStatsRes.json() : {};

        const oddsUrl = `https://api.sportradar.us/${league.path}/oddscomparison/2025/REG/schedule.json?api_key=${API_KEY}`;
        const oddsRes = await fetch(oddsUrl);
        const oddsData = oddsRes.ok ? await oddsRes.json() : {};
        const oddsGame = oddsData?.games?.find(g => g.id === game.id);

        const homeWinPct =
          homeStats.record?.overall?.win_pct ??
          homeStats.statistics?.wins / (homeStats.statistics?.wins + homeStats.statistics?.losses) ??
          0.5;
        const awayWinPct =
          awayStats.record?.overall?.win_pct ??
          awayStats.statistics?.wins / (awayStats.statistics?.wins + awayStats.statistics?.losses) ??
          0.5;

        const total = homeWinPct + awayWinPct;
        const homeChance = total ? homeWinPct / total : 0.5;
        const awayChance = total ? awayWinPct / total : 0.5;

        const homeMultiplier = (1 / homeChance) * 0.97;
        const awayMultiplier = (1 / awayChance) * 0.97;

        allMatches.push({
          MatchID: game.id,
          League: league.id.toUpperCase(),
          Scheduled: game.scheduled,
          Venue: game.venue?.name ?? "TBD",
          Status: game.status ?? "scheduled",
          HomeTeam: {
            id: homeTeam.id,
            name: homeTeam.name,
            wins: homeStats.statistics?.wins ?? 0,
            losses: homeStats.statistics?.losses ?? 0,
            winPct: homeWinPct,
            avgPoints: homeStats.statistics?.points_per_game ?? null,
            passingYards: homeStats.statistics?.passing_yards_per_game ?? null,
            rushingYards: homeStats.statistics?.rushing_yards_per_game ?? null,
            winChance: homeChance,
            multiplier: homeMultiplier,
          },
          AwayTeam: {
            id: awayTeam.id,
            name: awayTeam.name,
            wins: awayStats.statistics?.wins ?? 0,
            losses: awayStats.statistics?.losses ?? 0,
            winPct: awayWinPct,
            avgPoints: awayStats.statistics?.points_per_game ?? null,
            passingYards: awayStats.statistics?.passing_yards_per_game ?? null,
            rushingYards: awayStats.statistics?.rushing_yards_per_game ?? null,
            winChance: awayChance,
            multiplier: awayMultiplier,
          },
        });
      }
    }

    res.json(allMatches);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
