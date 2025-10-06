import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ODDS_API_KEY; // f547eaaf9d81defdd53c829deee7fd41

const LEAGUES = [
  { id: "americanfootball_nfl", name: "NFL" },
  { id: "basketball_nba", name: "NBA" },
  { id: "icehockey_nhl", name: "NHL" },
  { id: "baseball_mlb", name: "MLB" }
];

// Get dates for filtering (today + 14 days)
const today = new Date();
const endDate = new Date();
endDate.setDate(today.getDate() + 14);

function isWithinNext14Days(dateStr) {
  const d = new Date(dateStr);
  return d >= today && d <= endDate;
}

app.get("/matches", async (req, res) => {
  try {
    const allMatches = [];

    for (const league of LEAGUES) {
      try {
        const url = `https://api.the-odds-api.com/v4/sports/${league.id}/odds/?regions=us&markets=h2h&dateFormat=iso&apiKey=${API_KEY}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const games = await response.json();
        for (const g of games) {
          if (!isWithinNext14Days(g.commence_time)) continue;

          const home = g.home_team;
          const away = g.away_team;
          const bookmakers = g.bookmakers || [];
          const odds = bookmakers[0]?.markets[0]?.outcomes || [];

          const homeOdds = odds.find(o => o.name === home)?.price ?? 2.0;
          const awayOdds = odds.find(o => o.name === away)?.price ?? 2.0;

          const totalOdds = homeOdds + awayOdds;
          const homeChance = totalOdds ? awayOdds / totalOdds : 0.5;
          const awayChance = totalOdds ? homeOdds / totalOdds : 0.5;

          allMatches.push({
            MatchID: g.id,
            League: league.name,
            Scheduled: g.commence_time,
            Status: "scheduled",
            Venue: g.venue ?? "TBD",
            HomeTeam: {
              name: home,
              winChance: homeChance,
              multiplier: (1 / homeChance) * 0.97
            },
            AwayTeam: {
              name: away,
              winChance: awayChance,
              multiplier: (1 / awayChance) * 0.97
            }
          });
        }

        // Pull completed games to resolve stacks
        const scoreUrl = `https://api.the-odds-api.com/v4/sports/${league.id}/scores/?daysFrom=3&apiKey=${API_KEY}`;
        const scoreRes = await fetch(scoreUrl);
        if (scoreRes.ok) {
          const scoreData = await scoreRes.json();
          for (const s of scoreData) {
            if (!s.completed) continue;
            allMatches.push({
              MatchID: s.id,
              League: league.name,
              Status: "final",
              Scores: s.scores,
              Winner:
                s.scores?.find(sc => sc.score === Math.max(...s.scores.map(x => x.score)))?.name ??
                null
            });
          }
        }
      } catch (e) {
        console.warn(`❌ ${league.name} error: ${e.message}`);
      }
    }

    res.json(allMatches);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch matches" });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
