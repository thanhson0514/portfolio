// Vercel serverless function: GET /api/valorant
// Pulls the Valorant overview for one Riot ID from the HenrikDev API
// (tracker.gg blocks scraping) and returns a compact summary for the page.
// Requires env var HENRIK_API_KEY (free key: https://docs.henrikdev.xyz).

const NAME = process.env.VALORANT_NAME || "WiK1ngST";
const TAG = process.env.VALORANT_TAG || "6848";
const API = "https://api.henrikdev.xyz/valorant";
const TIERS = "https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04";
const MEDIA = "https://media.valorant-api.com";

async function henrik(path) {
  const r = await fetch(API + path, { headers: { Authorization: process.env.HENRIK_API_KEY || "" } });
  if (!r.ok) throw new Error(`HenrikDev ${r.status} on ${path}`);
  const body = await r.json();
  return body.data;
}

const enc = encodeURIComponent;
const tierIcon = (id) => (id ? `${TIERS}/${id}/largeicon.png` : null);
const round1 = (n) => Math.round(n * 10) / 10;

function summarizeMatches(matches) {
  // Only count the current season (season of the most recent match).
  const seasonId = matches[0]?.meta?.season?.id;
  const season = matches.filter((m) => !seasonId || m.meta?.season?.id === seasonId);

  let wins = 0, kills = 0, deaths = 0, assists = 0, head = 0, shots = 0, dmg = 0, score = 0, rounds = 0;
  const agents = {};
  const recent = [];

  for (const m of season) {
    const s = m.stats || {};
    const team = String(s.team || "").toLowerCase();
    const ours = m.teams?.[team] ?? 0;
    const theirs = m.teams?.[team === "red" ? "blue" : "red"] ?? 0;
    const won = ours > theirs;
    const draw = ours === theirs;
    const r = ours + theirs || 1;

    wins += won ? 1 : 0;
    kills += s.kills || 0;
    deaths += s.deaths || 0;
    assists += s.assists || 0;
    head += s.shots?.head || 0;
    shots += (s.shots?.head || 0) + (s.shots?.body || 0) + (s.shots?.leg || 0);
    dmg += s.damage?.made || 0;
    score += s.score || 0;
    rounds += r;

    const ag = s.character || {};
    const a = (agents[ag.name] ||= { name: ag.name, icon: ag.id ? `${MEDIA}/agents/${ag.id}/displayicon.png` : null, matches: 0, wins: 0, kills: 0, deaths: 0 });
    a.matches++;
    a.wins += won ? 1 : 0;
    a.kills += s.kills || 0;
    a.deaths += s.deaths || 0;

    if (recent.length < 8) {
      recent.push({
        map: m.meta?.map?.name,
        agent: ag.name,
        agentIcon: a.icon,
        kills: s.kills, deaths: s.deaths, assists: s.assists,
        result: draw ? "D" : won ? "W" : "L",
        score: `${ours}-${theirs}`,
        acs: Math.round((s.score || 0) / r),
        startedAt: m.meta?.started_at,
      });
    }
  }

  const n = season.length;
  return {
    season: matches[0]?.meta?.season?.short || null,
    matches: n,
    wins,
    losses: n - wins,
    winRate: n ? round1((wins / n) * 100) : 0,
    kd: round1(kills / Math.max(1, deaths)),
    kills, deaths, assists,
    hsPct: shots ? round1((head / shots) * 100) : 0,
    adr: rounds ? Math.round(dmg / rounds) : 0,
    acs: rounds ? Math.round(score / rounds) : 0,
    topAgents: Object.values(agents)
      .sort((a, b) => b.matches - a.matches)
      .slice(0, 3)
      .map((a) => ({ ...a, winRate: Math.round((a.wins / a.matches) * 100), kd: round1(a.kills / Math.max(1, a.deaths)) })),
    recent,
  };
}

async function buildOverview() {
  const account = await henrik(`/v1/account/${enc(NAME)}/${enc(TAG)}`);
  const region = account.region || "ap";

  const [mmr, stored] = await Promise.all([
    henrik(`/v3/mmr/${region}/pc/${enc(NAME)}/${enc(TAG)}`).catch(() => null),
    henrik(`/v1/stored-matches/${region}/${enc(NAME)}/${enc(TAG)}?mode=competitive&size=40`).catch(() => []),
  ]);

  const cur = mmr?.current || {};
  const peak = mmr?.peak || {};

  return {
    account: {
      name: account.name,
      tag: account.tag,
      region,
      level: account.account_level,
      card: account.card?.wide || account.card?.small || null,
    },
    rank: {
      tier: cur.tier?.id ?? 0,
      name: cur.tier?.name || "Unrated",
      rr: cur.rr ?? 0,
      lastChange: cur.last_change ?? null,
      elo: cur.elo ?? null,
      icon: tierIcon(cur.tier?.id),
      peakName: peak.tier?.name || null,
      peakSeason: peak.season?.short || null,
      peakIcon: tierIcon(peak.tier?.id),
    },
    stats: summarizeMatches(Array.isArray(stored) ? stored : []),
    updatedAt: new Date().toISOString(),
  };
}

module.exports = async (req, res) => {
  if (!process.env.HENRIK_API_KEY) {
    res.status(500).json({ error: "HENRIK_API_KEY is not set" });
    return;
  }
  try {
    const data = await buildOverview();
    // Fresh for 5 min at Vercel's edge, then served stale while it refreshes.
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
    res.status(200).json(data);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e.message || e) });
  }
};

module.exports.summarizeMatches = summarizeMatches;
