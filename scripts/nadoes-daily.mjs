// Nadoes Lads daily tracker. Runs once a day on GitHub Actions.
// Records, for every player on every fantasy roster, their NFL injury status,
// logs each change, adds up injury days per team, keeps a weekly snapshot,
// and freezes the status of players in each new waiver / free-agent / trade move.
// Writes data/nadoes-history.json. Needs Node 20+ (built-in fetch). No packages.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const LEAGUE = process.env.LEAGUE_ID || "1391256159565930496";
const BASE = process.env.SLEEPER_BASE || "https://api.sleeper.app/v1";
const FILE = process.env.HISTORY_FILE || "data/nadoes-history.json";
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

async function get(path) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.json();
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

  // Days since the last run, so a missed or late run still counts correctly.
  const elapsed = h.lastRun ? Math.min(7, Math.max(1, Math.round((NOW - h.lastRun) / DAY))) : 1;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const status = pid => { const p = own(players, pid) ? players[pid] : null;
    return p ? { s: norm(p.injury_status), part: clean(p.injury_body_part, 40) } : { s: "", part: "" }; };
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
    const { s, part } = status(pid);
    const prev = h.current[pid];
    if (!prev) {
      if (s) {
        // Healthy and on a roster at the last run, injured now: a new injury.
        // Picked up already injured: start tracking, but it is not a change.
        if (!seeding && h.rostered && (pid in h.rostered)) h.log.push([NOW, pid, rid, "", s, part]);
        h.current[pid] = { s, p: part, rid, since: NOW }; remember(pid);
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
      if (!Number.isInteger(rid) ||
