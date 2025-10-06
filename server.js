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
const ROBLOX_ENDPOINT = process.env.ROBLOX_ENDPOINT || ""; // e.g. https://your-roblox-cloudfunction.example/receive
const SHARED_SECRET = process.env.SHARED_SECRET || "change_this_to_a_strong_secret";

// MLB schedule/trial URL (adjust season/year as needed)
const LEAGUE_URLS = {
  mlb: `https://api.sportradar.us/mlb/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`,
  nfl: `https://api.sportradar.us/nfl/official/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`,
  nba: `https://api.sportradar.us/nba/trial/v8/en/games/2025/REG/schedule.json?api_key=${API_KEY}`,
  nhl: `https://api.sportradar.us/nhl/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`
};

// Fetch generic URL and return JSON
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt}`);
  }
  return res.json();
}

// Clean and expand MLB matches using common SportsRadar fields.
// Note: API shapes differ by provider/version — adapt mapping if your JSON differs.
function cleanMlbMatches(data) {
  const matches = [];

  // SportsRadar MLB schedule commonly has "games"
  const games = data.games || (data.week && data.week.games) || [];
  for (const g of games) {
    const home = g.home || g.home_team || {};
    const away = g.away || g.away_team || {};

    // try to include every useful field if present
    const match = {
      MatchID: g.id || g.game_pk || `${g.scheduled}-${home.id || 'H'}-${away.id || 'A'}`,
      League: "MLB",
      Season: g.season || null,
      SeasonType: g.season_type || null,
      Scheduled: g.scheduled || g.start_time || null,
      Status: g.status || null, // e.g., scheduled, closed, final, inprogress
      Venue: (g.venue && { id: g.venue.id, name: g.venue.name, city: g.venue.city }) || (g.venue_name && { name: g.venue_name }) || null,
      HomeTeam: {
        id: home.id || home.abbreviation || null,
        name: home.name || home.full_name || home.display_name || null,
        abbreviation: home.abbreviation || null,
        market: home.market || null,
        // placeholder numeric stats - keep null if API doesn't supply
        wins: home.wins ?? null,
        losses: home.losses ?? null,
        avg_points: home.avg_points ?? null
      },
      AwayTeam: {
        id: away.id || away.abbreviation || null,
        name: away.name || away.full_name || away.display_name || null,
        abbreviation: away.abbreviation || null,
        market: away.market || null,
        wins: away.wins ?? null,
        losses: away.losses ?? null,
        avg_points: away.avg_points ?? null
      },
      Broadcast: g.broadcasts || g.networks || null,
      ProbablePitchers: g.probables || g.probable_pitchers || null,
      Linescore: g.linescore || g.boxscore || null,
      Odds: g.odds || null, // only present if API returns betting lines
      Metadata: {
        reference: g.reference || null,
        home_prob: g.home_prob ?? null,
        away_prob: g.away_prob ?? null,
        // preserve raw object for future fields
        raw: g
      }
    };

    matches.push(match);
  }

  return matches;
}

async function fetchLeagueData(league) {
  const url = LEAGUE_URLS[league];
  if (!url) return [];

  try {
    const data = await fetchJson(url);
    if (league === "mlb") return cleanMlbMatches(data);
    // fallback for other leagues (simple mapping)
    if (league === "nba" && data.games) {
      return data.games.map(g => ({
        MatchID: g.id,
        League: "NBA",
        Scheduled: g.scheduled || null,
        HomeTeam: { id: g.home.id, name: g.home.name },
        AwayTeam: { id: g.away.id, name: g.away.name },
        Linescore: g.linescore || null,
        Metadata: { raw: g }
      }));
    }
    return [];
  } catch (err) {
    console.error("fetchLeagueData error:", err.message);
    return [];
  }
}

// HMAC helper to sign payload for Roblox verification
function hmacSign(payload) {
  return crypto.createHmac("sha256", SHARED_SECRET).update(JSON.stringify(payload)).digest("hex");
}

// GET endpoint for Roblox to poll latest MLB matches
app.get("/getMatches/:league", async (req, res) => {
  const league = (req.params.league || "").toLowerCase();
  if (!LEAGUE_URLS[league]) return res.status(404).json({ error: "League not supported." });

  const matches = await fetchLeagueData(league);
  // include signature header for optional verification
  const signature = hmacSign(matches);

  res.set("X-PAYLOAD-SIGN", signature);
  res.json({ source: "sports-relay", league: league.toUpperCase(), generatedAt: new Date().toISOString(), matches });
});

// Optional: push current matches to a configured Roblox endpoint (webhook)
// Use env ROBLOX_ENDPOINT to enable
app.post("/pushToRoblox/:league", async (req, res) => {
  if (!ROBLOX_ENDPOINT) return res.status(400).json({ error: "ROBLOX_ENDPOINT not configured" });
  const league = (req.params.league || "mlb").toLowerCase();
  const matches = await fetchLeagueData(league);
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
