// server.js
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SPORTRADAR_KEY;
const ROBLOX_ENDPOINT = process.env.ROBLOX_ENDPOINT || "";
const SHARED_SECRET = process.env.SHARED_SECRET || "change_this_to_a_strong_secret";

const LEAGUE_URLS = {
  mlb: `https://api.sportradar.us/mlb/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`,
  nfl: `https://api.sportradar.us/nfl/official/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`,
  nba: `https://api.sportradar.us/nba/trial/v8/en/games/2025/REG/schedule.json?api_key=${API_KEY}`,
  nhl: `https://api.sportradar.us/nhl/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`
};

// Fetch helper
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt}`);
  }
  return res.json();
}

// Clean MLB data
function cleanMlbMatches(data) {
  const games = data.games || (data.week && data.week.games) || [];
  const matches = [];

  for (const g of games) {
    const home = g.home || g.home_team || {};
    const away = g.away || g.away_team || {};

    matches.push({
      MatchID: g.id || `${g.scheduled}-${home.id || "H"}-${away.id || "A"}`,
      League: "MLB",
      Scheduled: g.scheduled || g.start_time || null,
      Status: g.status || "scheduled",
      Venue: g.venue?.name || g.venue_name || null,
      HomeTeam: {
        id: home.id || home.abbreviation || null,
        name: home.name || home.full_name || null,
        abbreviation: home.abbreviation || null
      },
      AwayTeam: {
        id: away.id || away.abbreviation || null,
        name: away.name || away.full_name || null,
        abbreviation: away.abbreviation || null
      }
    });
  }

  return matches;
}

async function fetchLeagueData(league) {
  const url = LEAGUE_URLS[league];
  if (!url) return [];

  try {
    const data = await fetchJson(url);
    if (league === "mlb") return cleanMlbMatches(data);
    if (league === "nba" && data.games) {
      return data.games.map(g => ({
        MatchID: g.id,
        League: "NBA",
        Scheduled: g.scheduled || null,
        Status: g.status || "scheduled",
        HomeTeam: { name: g.home?.name, abbreviation: g.home?.alias },
        AwayTeam: { name: g.away?.name, abbreviation: g.away?.alias },
        Venue: g.venue?.name || null
      }));
    }
    if (league === "nfl" && data.weeks) {
      const games = data.weeks.flatMap(w => w.games || []);
      return games.map(g => ({
        MatchID: g.id,
        League: "NFL",
        Scheduled: g.scheduled || null,
        Status: g.status || "scheduled",
        HomeTeam: { name: g.home?.name, abbreviation: g.home?.alias },
        AwayTeam: { name: g.away?.name, abbreviation: g.away?.alias },
        Venue: g.venue?.name || null
      }));
    }
    if (league === "nhl" && data.games) {
      return data.games.map(g => ({
        MatchID: g.id,
        League: "NHL",
        Scheduled: g.scheduled || null,
        Status: g.status || "scheduled",
        HomeTeam: { name: g.home?.name, abbreviation: g.home?.alias },
        AwayTeam: { name: g.away?.name, abbreviation: g.away?.alias },
        Venue: g.venue?.name || null
      }));
    }
    return [];
  } catch (err) {
    console.error("fetchLeagueData error:", err.message);
    return [];
  }
}

// Only keep next 14 days and minimal info
function filterAndTrimMatches(matches) {
  const now = new Date();
  const twoWeeks = new Date(now);
  twoWeeks.setDate(now.getDate() + 14);

  return matches
    .filter(m => {
      const date = new Date(m.Scheduled || 0);
      return date >= now && date <= twoWeeks;
    })
    .map(m => ({
      MatchID: m.MatchID,
      League: m.League,
      Scheduled: m.Scheduled,
      Status: m.Status,
      HomeTeam: { name: m.HomeTeam?.name, abbreviation: m.HomeTeam?.abbreviation },
      AwayTeam: { name: m.AwayTeam?.name, abbreviation: m.AwayTeam?.abbreviation },
      Venue: m.Venue || null
    }));
}

// HMAC helper
function hmacSign(payload) {
  return crypto.createHmac("sha256", SHARED_SECRET)
    .update(JSON.stringify(payload))
    .digest("hex");
}

// Roblox poll endpoint
app.get("/getMatches/:league", async (req, res) => {
  const league = (req.params.league || "").toLowerCase();
  if (!LEAGUE_URLS[league]) return res.status(404).json({ error: "League not supported." });

  const allMatches = await fetchLeagueData(league);
  const matches = filterAndTrimMatches(allMatches);
  const signature = hmacSign(matches);

  res.set("X-PAYLOAD-SIGN", signature);
  res.json({
    source: "sports-relay",
    league: league.toUpperCase(),
    generatedAt: new Date().toISOString(),
    matches
  });
});

// Optional push to Roblox webhook
app.post("/pushToRoblox/:league", async (req, res) => {
  if (!ROBLOX_ENDPOINT) return res.status(400).json({ error: "ROBLOX_ENDPOINT not configured" });
  const league = (req.params.league || "mlb").toLowerCase();

  const allMatches = await fetchLeagueData(league);
  const matches = filterAndTrimMatches(allMatches);

  const payload = { matches, league: league.toUpperCase(), ts: new Date().toISOString() };
  const sig = hmacSign(payload);

  try {
    const robloxRes = await fetch(ROBLOX_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYLOAD-SIGN": sig },
      body: JSON.stringify(payload)
    });
    const text = await robloxRes.text();
    return res.status(200).json({ ok: true, robloxStatus: robloxRes.status, robloxResponse: text });
  } catch (err) {
    console.error("Push to Roblox failed:", err);
    return res.status(500).json({ error: "Push failed", detail: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ SportsStack Relay running on port ${PORT}`));
