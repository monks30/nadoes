// Nadoes Lads daily tracker. Runs once a day on GitHub Actions.
// Records, for every player on every fantasy roster, their NFL injury status,
// logs each change, adds up injury days per team, keeps a weekly snapshot,
// and freezes the status of players in each new waiver / free-agent / trade move.
// Also saves this week's player projections, scored with the league's own settings,
// and locks a pre-kickoff copy each Sunday so the page can compare projected v actual.
// Writes data/nadoes-history.json and data/nadoes-projections.json.
// Needs Node 20+ (built-in fetch). No packages.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const LEAGUE = process.env.LEAGUE_ID || "1391256159565930496";
const BASE = process.env.SLEEPER_BASE || "https://api.sleeper.app/v1";
const FILE = process.env.HISTORY_FILE || "data/nadoes-history.json";
const PROJ_FILE = process.env.PROJ_FILE || "data/nadoes-projections.json";
const COM_BASE = process.env.SLEEPER_COM_BASE || "https://api.sleeper.com";
const PROJ_MIN = 150;     // a projection set needs at least this many players to count as complete
const NOW = process.env.FAKE_NOW ? Number(process.env.FAKE_NOW) : Date.now();
const DAY = 86400000;
const SNAP_DAYS = 3;      // a move is frozen only if first seen within this many days
const LOG_CAP = 5000;     // keep the change log from growing without limit
const TIMEOUT_MS = 60000; // give up on a Sleeper call after 60 seconds

// Everything from Sleeper is treated as untrusted. IDs must look like IDs before
// they are used as keys (blocks "__proto__" and similar), and text is stripped of
// characters that could turn into HTML on the page, then length-capped.
const ID = /^[A-Za-z0-9_]{1,40}$/;
const BLOCKED = new Set(["__proto__", "constructor", "prototype"]);
const okId = v => { const k = String(v); return ID.test(k) && !BLOCKED.has(k); };
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>&"'`\\]/g, "").slice(0, n);

async function getUrl(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url.replace(/\?.*/, "")}`);
  return res.json();
}
const get = path => getUrl(BASE + path);

// ---- projections: score Sleeper's projected stats with the league's scoring settings ----
// Points-allowed and yards-allowed come as a single number in projections, but leagues
// score them in bands (e.g. 14-20 points allowed = 4), so map the number to its band.
function band(sc, prefix, v) {
  if (!Number.isFinite(v)) return 0;
  const x = Math.round(v);
  for (const [k, pts] of Object.entries(sc)) {
    if (!k.startsWith(prefix + "_")) continue;
    const r = k.slice(prefix.length + 1);
    let lo, hi;
    if (/^\d+p$/.test(r)) { lo = Number(r.slice(0, -1)); hi = Infinity; }
    else if (/^\d+_\d+$/.test(r)) { [lo, hi] = r.split("_").map(Number); }
    else if (/^\d+$/.test(r)) { lo = hi = Number(r); }
    else continue;
    if (x >= lo && x <= hi) return Number(pts) || 0;
  }
  return 0;
}
function scoreStats(st, sc) {
  let pts = 0, hasPA = false, hasYA = false;
  for (const [k, raw] of Object.entries(st)) {
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    if (k.startsWith("pts_allow_")) hasPA = true;
    if (k.startsWith("yds_allow_")) hasYA = true;
    if (Object.prototype.hasOwnProperty.call(sc, k)) pts += v * (Number(sc[k]) || 0);
  }
  if (!hasPA && st.pts_allow != null) pts += band(sc, "pts_allow", Number(st.pts_allow));
  if (!hasYA && st.yds_allow != null) pts += band(sc, "yds_allow", Number(st.yds_allow));
  if (pts <= 0 && Number(st.pts_ppr) > 0) pts = Number(st.pts_ppr);   // last resort
  return pts;
}
function normProj(raw) {   // both feeds -> { player_id: stats }
  const out = {};
  if (Array.isArray(raw)) { for (const e of raw) if (e && okId(e.player_id) && e.stats && typeof e.stats === "object") out[e.player_id] = e.stats; }
  else if (raw && typeof raw === "object") { for (const [pid, st] of Object.entries(raw)) if (okId(pid) && st && typeof st === "object") out[pid] = st; }
  return out;
}
async function getProjections(season, week, sc) {
  const pos = ["QB", "RB", "WR", "TE", "K", "DEF"].map(p => `position[]=${p}`).join("&");
  const feeds = [
    ["v1", () => get(`/projections/nfl/regular/${season}/${week}`)],
    ["app", () => getUrl(`${COM_BASE}/projections/nfl/${season}/${week}?season_type=regular&${pos}`)],
  ];
  for (const [src, fetchIt] of feeds) {
    try {
      const pts = {}; let n = 0;
      for (const [pid, st] of Object.entries(normProj(await fetchIt()))) {
        const v = scoreStats(st, sc);
        if (v > 0.05) { pts[pid] = Math.round(v * 100) / 100; if (/^\d+$/.test(pid)) n++; }
      }
      if (n >= PROJ_MIN) return { src, pts, n };
      console.log(`Projections from ${src} look incomplete (${n} players); not used.`);
    } catch (e) { console.log(`Projections from ${src} failed: ${e.message}`); }
  }
  return null;
}

// Same grouping the page uses.
function norm(s) {
  s = String(s || "");
  if (/^(IR|PUP|NFI)/i.test(s)) return "IR";
  if (/^out/i.test(s)) return "Out";
  if (/^doubt/i.test(s)) return "Doubtful";
  if (/^quest/i.test(s)) return "Questionable";
  return "";
}

function load() {
  if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf8"));
  return null;
}

async function main() {
  const state = await get("/state/nfl");
  if (!["regular", "post"].includes(state.season_type)) {
    console.log(`Off-season (${state.season_type}); nothing to record.`);
    return;
  }
  const week = Number(state.week) || 0;

  const league = await get(`/league/${LEAGUE}`);
  const rosters = await get(`/league/${LEAGUE}/rosters`);
  const players = await get("/players/nfl");                 // ~5MB, once a day
  const matchups = week ? await get(`/league/${LEAGUE}/matchups/${week}`).catch(() => []) : [];
  // Refuse to record anything from a broken or partial response. Without this, a
  // Sleeper outage that returned an empty player file would log every injured
  // player as "recovered" and corrupt the history.
  if (!Array.isArray(rosters) || rosters.length === 0) throw new Error("Rosters missing; nothing written.");
  if (!players || typeof players !== "object" || Object.keys(players).length < 1000)
    throw new Error("Player file looks incomplete; nothing written.");
  const txRounds = await Promise.all(
    Array.from({ length: 18 }, (_, i) => get(`/league/${LEAGUE}/transactions/${i + 1}`).catch(() => []))
  );

  let h = load();
  const seeding = !h || h.season !== String(league.season);
  if (seeding) {
    h = { v: 1, league: LEAGUE, season: String(league.season), since: NOW, lastRun: null,
          trackedDays: 0, rostered: {}, current: {}, log: [], days: {}, playerOut: {}, weekly: {}, moves: {}, names: {} };
  }

  // Whole days since the last counted run. A missed run still counts its days (up to 7);
  // an extra run on the same day (a manual run, a re-run) counts 0, so no day is counted twice.
  const elapsed = h.lastRun ? Math.min(7, Math.max(0, Math.round((NOW - h.lastRun) / DAY))) : 1;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const status = pid => { const p = own(players, pid) ? players[pid] : null;
    const start = p ? Date.parse(p.injury_start_date || "") : NaN;
    return p ? { s: norm(p.injury_status), part: clean(p.injury_body_part, 40), start: (start > 0 && start < NOW) ? start : null } : { s: "", part: "", start: null }; };
  const remember = pid => { const p = own(players, pid) ? players[pid] : null;
    if (p && !own(h.names, pid)) h.names[pid] = [clean(p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim(), 60), clean(p.position, 6)]; };

  // 1. Every rostered player: current status, change log, injury days.
  const rostered = {};
  for (const r of rosters) {
    const rid = Number(r.roster_id);
    if (!Number.isInteger(rid) || rid < 1 || rid > 64) continue;
    for (const pid of (Array.isArray(r.players) ? r.players : [])) if (okId(pid)) rostered[pid] = rid;
  }

  for (const [pid, rid] of Object.entries(rostered)) {
    const { s, part, start } = status(pid);
    const prev = h.current[pid];
    if (!prev) {
      if (s) {
        // Healthy and on a roster at the last run, injured now: a new injury.
        // Picked up already injured: start tracking, but it is not a change.
        if (!seeding && h.rostered && (pid in h.rostered)) h.log.push([NOW, pid, rid, "", s, part]);
        // Sleeper's own injury start date, when given, is better than "first seen today".
        h.current[pid] = { s, p: part, rid, since: start || NOW }; remember(pid);
      }
    } else if (prev.s !== s) {
      h.log.push([NOW, pid, rid, prev.s, s, part]);
      remember(pid);
      if (s) h.current[pid] = { s, p: part, rid, since: NOW }; else delete h.current[pid];
    } else {
      prev.rid = rid; prev.p = part || prev.p;
    }
    if (s) {
      const d = (h.days[rid] = h.days[rid] || { IR: 0, Out: 0, Doubtful: 0, Questionable: 0 });
      d[s] += elapsed;
      if (s === "IR" || s === "Out") {
        const po = (h.playerOut[pid] = h.playerOut[pid] || { d: 0, rid });
        po.d += elapsed; po.rid = rid;
      }
    }
  }
  // Injured players who have left every roster: close them quietly (no longer ours to count).
  for (const pid of Object.keys(h.current)) if (!(pid in rostered)) delete h.current[pid];
  // First run seeds today's statuses without logging them as changes.
  if (seeding) h.log = [];
  if (h.log.length > LOG_CAP) h.log = h.log.slice(-LOG_CAP);
  h.trackedDays += elapsed;
  h.rostered = rostered;

  // 2. Weekly snapshot per team. Skipped on Mondays (UTC) so Sunday's in-game injuries
  //    don't get counted against lineups that were already set.
  if (week && new Date(NOW).getUTCDay() !== 1) {
    const wk = (h.weekly[week] = {});
    for (const r of rosters) {
      const rid = Number(r.roster_id);
      if (!Number.isInteger(rid) || rid < 1 || rid > 64) continue;
      const c = { IR: 0, Out: 0, Doubtful: 0, Questionable: 0, hurt: [] };
      for (const pid of (Array.isArray(r.players) ? r.players : [])) { if (!okId(pid)) continue; const { s } = status(pid); if (s) c[s]++; }
      const row = (Array.isArray(matchups) ? matchups : []).find(m => Number(m.roster_id) === rid);
      for (const pid of (row && Array.isArray(row.starters) ? row.starters : [])) {
        if (!okId(pid)) continue;
        const { s } = status(pid);
        if (s === "IR" || s === "Out" || s === "Doubtful") { c.hurt.push(pid); remember(pid); }
      }
      wk[rid] = c;
    }
  }

  // 3. Freeze the status of players in each new completed move.
  let frozen = 0;
  for (const round of txRounds) for (const x of (round || [])) {
    if (x.status !== "complete") continue;
    const t = Number(x.status_updated || x.created || 0);
    const adds = (x.adds && typeof x.adds === "object") ? x.adds : {}, drops = (x.drops && typeof x.drops === "object") ? x.drops : {};
    const tid = String(x.transaction_id || "");
    if (!okId(tid) || own(h.moves, tid) || NOW - t > SNAP_DAYS * DAY) continue;
    const st = {};
    for (const pid of [...Object.keys(adds), ...Object.keys(drops)]) { if (!okId(pid)) continue; st[pid] = status(pid).s; remember(pid); }
    h.moves[tid] = { at: NOW, st };
    frozen++;
  }

  // Only move the clock on when a day was counted, so same-day extra runs don't eat into tomorrow's.
  if (elapsed > 0) h.lastRun = NOW;
  mkdirSync(FILE.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  writeFileSync(FILE, JSON.stringify(h));

  // 4. Projections. Never fatal: if both feeds are down or blank, the last good copy stays.
  if (week) {
    let P = existsSync(PROJ_FILE) ? JSON.parse(readFileSync(PROJ_FILE, "utf8")) : null;
    if (!P || P.season !== String(league.season)) P = { v: 1, season: String(league.season), weeks: {}, locked: {} };
    const dow = new Date(NOW).getUTCDay();          // 0 = Sunday, 1 = Monday (UTC)
    // Missed the Sunday run? Lock Saturday's copy on Monday, before anything is refreshed.
    if (dow === 1 && !P.locked[week] && P.weeks[week]) P.locked[week] = { at: P.weeks[week].at, pts: P.weeks[week].pts };
    // No refresh on Mondays: games are under way and feeds change mid-game.
    if (dow !== 1) {
      const got = await getProjections(String(league.season), week, league.scoring_settings || {});
      if (got) { P.weeks[week] = { at: NOW, src: got.src, pts: got.pts }; console.log(`Projections saved: ${got.n} players from ${got.src}.`); }
    }
    // Sunday 16:00 UTC is before the early games: lock this copy for projected-v-actual.
    if (dow === 0 && !P.locked[week] && P.weeks[week]) P.locked[week] = { at: P.weeks[week].at, pts: P.weeks[week].pts };
    for (const w of Object.keys(P.weeks)) if (Number(w) < week) delete P.weeks[w];
    mkdirSync(PROJ_FILE.split("/").slice(0, -1).join("/") || ".", { recursive: true });
    writeFileSync(PROJ_FILE, JSON.stringify(P));
  }
  const injured = Object.keys(h.current).length;
  console.log(`Week ${week}: ${injured} rostered players injured, ${h.log.length} changes logged, ${frozen} new moves frozen.`);
}

main().catch(e => { console.error(e); process.exit(1); });
