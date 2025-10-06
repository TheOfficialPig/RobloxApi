// server.js
// SportsRelay — schedule + enriched team stats + winChance + multiplier
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SPORTRADAR_KEY; // from .env on Render
const SHARED_SECRET = process.env.SHARED_SECRET || "change_this_to_a_strong_secret";

// league schedule endpoints (adjust season/year if needed)
const LEAGUE_URLS = {
  nfl: `https://api.sportradar.us/nfl/official/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`,
  nba: `https://api.sportradar.us/nba/trial/v8/en/games/2025/REG/schedule.json?api_key=${API_KEY}`,
  nhl: `https://api.sportradar.us/nhl/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`,
  mlb: `https://api.sportradar.us/mlb/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`
};

// --- Utilities ---
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { timeout: 15000, ...opts });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url} ${body.slice(0, 200)}`);
  }
  return res.json();
}

function hmacSign(payload) {
  return crypto.createHmac("sha256", SHARED_SECRET).update(JSON.stringify(payload)).digest("hex");
}

function inNext14Days(dateStrOrTs) {
  if (!dateStrOrTs) return false;
  const d = new Date(dateStrOrTs);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  const later = new Date(now);
  later.setDate(now.getDate() + 14);
  return d >= now && d <= later;
}

function safeGet(obj, path, fallback = null) {
  try {
    return path.split(".").reduce((a, k) => (a ? a[k] : undefined), obj) ?? fallback;
  } catch {
    return fallback;
  }
}

// --- Team stats caching to reduce calls during runtime ---
const teamStatsCache = {}; // key: `${league}:${teamIdOrName}` -> stats obj

// --- Attempt to get team stats from a few Sportradar endpoints ---
// Note: exact endpoint shapes vary by league/product/version. This function
// tries a few likely endpoints and pulls common stats if present.
async function fetchTeamStats(league, teamId, teamName, sampleMatch) {
  const cacheKey = `${league}:${teamId || teamName}`;
  if (teamStatsCache[cacheKey]) return teamStatsCache[cacheKey];

  const stats = {
    teamId: teamId || null,
    name: teamName || null,
    wins: null,
    losses: null,
    winPct: null,
    avgPoints: null,
    passingYards: null,
    rushingYards: null,
    // additional fields possible...
  };

  // Helpers to attempt endpoints — many trial feeds have team pages or season stats.
  // We'll attempt several URL patterns; on failure we just return partial stats.
  const attempts = [];

  try {
    const year = (sampleMatch && sampleMatch.Scheduled) ? new Date(sampleMatch.Scheduled).getUTCFullYear() : (new Date()).getUTCFullYear();
    // 1) Team statistics endpoint (common pattern)
    if (teamId) {
      attempts.push(`https://api.sportradar.us/${league}/trial/v7/en/teams/${teamId}/statistics.json?api_key=${API_KEY}`);
      attempts.push(`https://api.sportradar.us/${league}/trial/v7/en/seasons/${year}/REG/teams/${teamId}/statistics.json?api_key=${API_KEY}`);
    }
    // 2) Standings/season stats (pull league-wide and find team by name)
    attempts.push(`https://api.sportradar.us/${league}/trial/v7/en/seasons/${year}/REG/standings.json?api_key=${API_KEY}`);
    // 3) Team profile (sometimes contains record)
    if (teamId) attempts.push(`https://api.sportradar.us/${league}/trial/v7/en/teams/${teamId}/profile.json?api_key=${API_KEY}`);
  } catch (err) {
    // fall through
  }

  for (const url of attempts) {
    try {
      const j = await fetchJson(url);
      // Try multiple shapes to extract wins/losses/avgPoints
      // common: j.team.season.stats or j.statistics or j.standings
      // 1) direct stats object
      const s1 = safeGet(j, "statistics") || safeGet(j, "team.statistics") || safeGet(j, "team.season.statistics") || safeGet(j, "team.season.stats");
      if (s1) {
        // generic attempts to map keys
        stats.wins = stats.wins ?? (s1.wins ?? s1.wins_regular_season ?? s1.wins_total ?? s1.wins_count);
        stats.losses = stats.losses ?? (s1.losses ?? s1.losses_regular_season ?? s1.losses_total ?? s1.losses_count);
        // avg points / points per game
        stats.avgPoints = stats.avgPoints ?? (s1.points_per_game || s1.points_avg || s1.pts_avg || s1.offense && s1.offense.points_per_game);
        // yards (may not exist for all leagues)
        stats.passingYards = stats.passingYards ?? (s1.passing_yards_per_game || s1.pass_yds_avg);
        stats.rushingYards = stats.rushingYards ?? (s1.rushing_yards_per_game || s1.rush_yds_avg);
      }
      // 2) standings object with team rows
      const rows = safeGet(j, "standings") || safeGet(j, "leaders") || safeGet(j, "groups") || safeGet(j, "conference");
      if (rows && Array.isArray(rows)) {
        // try to find team by name or id
        let found = null;
        for (const r of rows) {
          // some shapes: r.team, r.teams array, r.rows
          if (r.team && (r.team.id === teamId || `${r.team.name}`.toLowerCase().includes((teamName || "").toLowerCase()))) {
            found = r.team;
            break;
          }
          if (r.teams && Array.isArray(r.teams)) {
            for (const t of r.teams) {
              if (t.id === teamId || `${t.name}`.toLowerCase().includes((teamName || "").toLowerCase())) {
                found = t;
                break;
              }
            }
            if (found) break;
          }
          if (r.rows && Array.isArray(r.rows)) {
            for (const rr of r.rows) {
              if (rr.team && (rr.team.id === teamId || `${rr.team.name}`.toLowerCase().includes((teamName || "").toLowerCase()))) {
                found = rr;
                break;
              }
            }
            if (found) break;
          }
        }
        if (found) {
          stats.wins = stats.wins ?? (found.wins ?? safeGet(found, "record.wins") ?? safeGet(found, "standings.wins"));
          stats.losses = stats.losses ?? (found.losses ?? safeGet(found, "record.losses") ?? safeGet(found, "standings.losses"));
        }
      }

      // 3) profile shapes
      const profile = safeGet(j, "team") || safeGet(j, "profile") || j;
      if (profile) {
        stats.name = stats.name ?? (profile.name || profile.full_name || profile.display_name);
        // try typical keys
        stats.wins = stats.wins ?? (profile.wins ?? profile.season && profile.season.wins);
        stats.losses = stats.losses ?? (profile.losses ?? profile.season && profile.season.losses);
      }

      // If we got meaningful data break early
      if (stats.wins !== null || stats.avgPoints !== null) break;
    } catch (err) {
      // ignore and try next
      // console.warn("team stats attempt failed for", url, err.message);
    }
  }

  // compute derived fields
  if (stats.wins !== null && stats.losses !== null) {
    const total = stats.wins + stats.losses;
    stats.winPct = total > 0 ? (stats.wins / total) : null;
  } else stats.winPct = stats.winPct ?? null;

  // fallback defaults
  stats.wins = stats.wins ?? 0;
  stats.losses = stats.losses ?? 0;
  stats.avgPoints = stats.avgPoints ?? null;
  stats.passingYards = stats.passingYards ?? null;
  stats.rushingYards = stats.rushingYards ?? null;

  teamStatsCache[cacheKey] = stats;
  return stats;
}

// --- Win chance and multiplier calculation ---
// We'll compute a simple strength score from winPct and avgPoints (if available).
function calcStrength(homeStats, awayStats) {
  // use winPct (0..1) as primary; avgPoints normalized as secondary
  const hWin = (homeStats.winPct !== null && homeStats.winPct !== undefined) ? homeStats.winPct : 0.5;
  const aWin = (awayStats.winPct !== null && awayStats.winPct !== undefined) ? awayStats.winPct : 0.5;

  // normalized avgPoints: relative to sum of both if both available
  let hAvg = homeStats.avgPoints ?? null;
  let aAvg = awayStats.avgPoints ?? null;
  let hAvgScore = 0.5, aAvgScore = 0.5;
  if (hAvg !== null && aAvg !== null && (hAvg + aAvg) > 0) {
    hAvgScore = hAvg / (hAvg + aAvg);
    aAvgScore = aAvg / (hAvg + aAvg);
  } else if (hAvg !== null && aAvg === null) {
    hAvgScore = 0.6; aAvgScore = 0.4;
  } else if (aAvg !== null && hAvg === null) {
    aAvgScore = 0.6; hAvgScore = 0.4;
  }

  // weight winPct higher, avgPoints lower
  const hStrength = (hWin * 0.7) + (hAvgScore * 0.3);
  const aStrength = (aWin * 0.7) + (aAvgScore * 0.3);

  return { hStrength, aStrength };
}

// Convert strengths to probabilities and multipliers
function deriveProbabilitiesAndMultipliers(hStrength, aStrength) {
  // avoid zeros
  const eps = 1e-6;
  const total = hStrength + aStrength + eps;
  let pHome = hStrength / total;
  let pAway = aStrength / total;

  // clamp
  pHome = Math.min(Math.max(pHome, 0.01), 0.99);
  pAway = Math.min(Math.max(pAway, 0.01), 0.99);

  // multiplier formula: inverse of implied probability with a house margin
  // smaller probability -> larger multiplier. Add small house edge factor (0.95)
  const houseEdge = 0.97; // slightly reduce payouts
  const multHome = Math.max(1.05, Number(((houseEdge / pHome)).toFixed(2)));
  const multAway = Math.max(1.05, Number(((houseEdge / pAway)).toFixed(2)));

  return { pHome, pAway, multHome, multAway };
}

// --- Normalize schedule/game shapes into consistent match objects ---
function normalizeScheduledGame(league, raw) {
  // Try common fields for each schedule shape
  const home = raw.home || raw.home_team || raw.home_competitor || {};
  const away = raw.away || raw.away_team || raw.away_competitor || {};
  return {
    MatchID: raw.id || raw.game_pk || `${league}-${raw.scheduled || Date.now()}`,
    League: league.toUpperCase(),
    Scheduled: raw.scheduled || raw.start_time || raw.date || null,
    Status: raw.status || raw.game_status || "scheduled",
    Venue: (raw.venue && (raw.venue.name || raw.venue_id)) || raw.venue_name || null,
    HomeTeamRaw: {
      id: home.id || home.abbreviation || null,
      name: home.name || home.full_name || home.display_name || null
    },
    AwayTeamRaw: {
      id: away.id || away.abbreviation || null,
      name: away.name || away.full_name || away.display_name || null
    },
    Raw: raw
  };
}

// --- fetch schedule and enrich --- 
async function fetchLeagueMatchesEnriched(league) {
  const url = LEAGUE_URLS[league];
  if (!url) return [];

  try {
    const data = await fetchJson(url);
    let rawGames = [];

    // Many schedule shapes: try common keys
    if (Array.isArray(data.games)) rawGames = data.games;
    else if (Array.isArray(data.weeks)) rawGames = data.weeks.flatMap(w => w.games || []);
    else if (Array.isArray(data.schedules)) rawGames = data.schedules;
    else if (Array.isArray(data.matches)) rawGames = data.matches;
    else rawGames = [];

    // normalize
    const normalized = rawGames.map(r => normalizeScheduledGame(league, r));

    // filter only next 14 days
    const upcoming = normalized.filter(g => inNext14Days(g.Scheduled));

    // prepare enrichment: collect unique team ids/names for batch fetching
    const enrichPromises = [];
    for (const g of upcoming) {
      const homeId = g.HomeTeamRaw.id;
      const awayId = g.AwayTeamRaw.id;
      enrichPromises.push((async () => {
        const homeStats = await fetchTeamStats(league, homeId, g.HomeTeamRaw.name, g).catch(() => ({}));
        const awayStats = await fetchTeamStats(league, awayId, g.AwayTeamRaw.name, g).catch(() => ({}));

        const { hStrength, aStrength } = calcStrength(homeStats, awayStats);
        const { pHome, pAway, multHome, multAway } = deriveProbabilitiesAndMultipliers(hStrength, aStrength);

        return {
          MatchID: g.MatchID,
          League: g.League,
          Scheduled: g.Scheduled,
          Status: g.Status,
          Venue: g.Venue,
          HomeTeam: {
            id: homeStats.teamId ?? g.HomeTeamRaw.id,
            name: homeStats.name ?? g.HomeTeamRaw.name,
            wins: homeStats.wins,
            losses: homeStats.losses,
            winPct: homeStats.winPct,
            avgPoints: homeStats.avgPoints,
            passingYards: homeStats.passingYards,
            rushingYards: homeStats.rushingYards,
            winChance: Number(pHome.toFixed(3)),
            multiplier: multHome
          },
          AwayTeam: {
            id: awayStats.teamId ?? g.AwayTeamRaw.id,
            name: awayStats.name ?? g.AwayTeamRaw.name,
            wins: awayStats.wins,
            losses: awayStats.losses,
            winPct: awayStats.winPct,
            avgPoints: awayStats.avgPoints,
            passingYards: awayStats.passingYards,
            rushingYards: awayStats.rushingYards,
            winChance: Number(pAway.toFixed(3)),
            multiplier: multAway
          }
        };
      })());
    }

    const enriched = await Promise.all(enrichPromises);
    return enriched;
  } catch (err) {
    console.error("fetchLeagueMatchesEnriched error:", err.message);
    return [];
  }
}

// --- Route: get matches for a league (trimmed, enriched, next 14 days only) ---
app.get("/getMatches/:league", async (req, res) => {
  const league = (req.params.league || "").toLowerCase();
  if (!LEAGUE_URLS[league]) return res.status(404).json({ error: "League not supported." });

  try {
    const matches = await fetchLeagueMatchesEnriched(league);
    const signature = hmacSign(matches);
    res.set("X-PAYLOAD-SIGN", signature);
    return res.json({ source: "sports-relay", league: league.toUpperCase(), generatedAt: new Date().toISOString(), matches });
  } catch (err) {
    console.error("getMatches error:", err);
    return res.json({ source: "sports-relay", league: league.toUpperCase(), generatedAt: new Date().toISOString(), matches: [] });
  }
});

// Optional helper endpoint to get cached team stats (debug)
app.get("/debug/teamStats", (req, res) => {
  return res.json(teamStatsCache);
});

app.listen(PORT, () => console.log(`✅ SportsStack Relay (enriched) running on port ${PORT}`));
