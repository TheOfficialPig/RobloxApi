import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SPORTRADAR_KEY;

// Base URLs per league (trial feeds)
const LEAGUE_URLS = {
  nfl: `https://api.sportradar.us/nfl/official/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`,
  nba: `https://api.sportradar.us/nba/trial/v8/en/games/2025/REG/schedule.json?api_key=${API_KEY}`,
  nhl: `https://api.sportradar.us/nhl/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`,
  mls: `https://api.sportradar.us/soccer/trial/v4/en/competitions/sr:competition:274/schedules.json?api_key=${API_KEY}`
};

async function fetchLeagueData(league, url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      console.error(`❌ ${league.toUpperCase()} Fetch Error: HTTP ${res.status}\n${text}`);
      return [];
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await res.text();
      console.error(`❌ ${league.toUpperCase()} invalid response type: ${contentType}\n${text.slice(0, 200)}`);
      return [];
    }

    const data = await res.json();
    return cleanMatches(league, data);
  } catch (err) {
    console.error(`⚠️ Failed to fetch ${league.toUpperCase()} data:`, err);
    return [];
  }
}

function cleanMatches(league, data) {
  let matches = [];

  // Each SportsRadar league has different schema
  if (league === "nfl" && data.weeks) {
    data.weeks.forEach(week => {
      week.games.forEach(game => {
        matches.push({
          MatchID: game.id,
          League: "NFL",
          Team1: game.home.name,
          Team2: game.away.name,
          StartTime: game.scheduled,
          Team1Stats: { Wins: 0, Losses: 0, AvgPoints: 0 },
          Team2Stats: { Wins: 0, Losses: 0, AvgPoints: 0 }
        });
      });
    });
  } else if (league === "nba" && data.games) {
    matches = data.games.map(game => ({
      MatchID: game.id,
      League: "NBA",
      Team1: game.home.name,
      Team2: game.away.name,
      StartTime: game.scheduled,
      Team1Stats: { Wins: 0, Losses: 0, AvgPoints: 0 },
      Team2Stats: { Wins: 0, Losses: 0, AvgPoints: 0 }
    }));
  } else if (league === "nhl" && data.games) {
    matches = data.games.map(game => ({
      MatchID: game.id,
      League: "NHL",
      Team1: game.home.name,
      Team2: game.away.name,
      StartTime: game.scheduled,
      Team1Stats: { Wins: 0, Losses: 0, AvgPoints: 0 },
      Team2Stats: { Wins: 0, Losses: 0, AvgPoints: 0 }
    }));
  } else if (league === "mls" && data.schedules) {
    matches = data.schedules.map(match => ({
      MatchID: match.id,
      League: "MLS",
      Team1: match.competitors?.find(t => t.qualifier === "home")?.name || "Home",
      Team2: match.competitors?.find(t => t.qualifier === "away")?.name || "Away",
      StartTime: match.scheduled,
      Team1Stats: { Wins: 0, Losses: 0, AvgPoints: 0 },
      Team2Stats: { Wins: 0, Losses: 0, AvgPoints: 0 }
    }));
  }

  return matches.slice(0, 10); // trim for safety
}

// Fetch route for each league
app.get("/getMatches/:league", async (req, res) => {
  const league = req.params.league.toLowerCase();
  if (!LEAGUE_URLS[league]) return res.status(404).json({ error: "League not supported." });

  const matches = await fetchLeagueData(league, LEAGUE_URLS[league]);

  if (matches.length === 0) {
    console.warn(`⚠️ Returning fallback for ${league}`);
    return res.json([
      {
        MatchID: `${league.toUpperCase()}-MOCK-001`,
        League: league.toUpperCase(),
        Team1: "Team A",
        Team2: "Team B",
        StartTime: new Date().toISOString(),
        Team1Stats: { Wins: 4, Losses: 2, AvgPoints: 27 },
        Team2Stats: { Wins: 3, Losses: 3, AvgPoints: 21 }
      }
    ]);
  }

  res.json(matches);
});

app.listen(PORT, () => console.log(`✅ SportsStack Relay running on port ${PORT}`));
