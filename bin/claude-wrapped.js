#!/usr/bin/env node
/**
 * claude-code-wrapped — Your year (or month) with Claude Code, Spotify-Wrapped style.
 *
 * Parses the local Claude Code transcripts (~/.claude/projects/*.jsonl) and produces:
 *   1. A terminal summary
 *   2. A beautiful self-contained HTML report (dark, animated, shareable PNG card)
 *
 * 100% local. Zero dependencies. Nothing ever leaves your machine.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// ─── Pricing (USD per 1M tokens — API list prices; edit to match your plan) ───
// cacheWrite = 1.25 × input, cacheRead = 0.1 × input (Anthropic standard ratios)
const PRICING = [
  { match: /fable|mythos/, label: 'Fable 5',    in: 20,   out: 100 },
  { match: /opus/,         label: 'Opus',       in: 15,   out: 75 },
  { match: /sonnet/,       label: 'Sonnet',     in: 3,    out: 15 },
  { match: /haiku/,        label: 'Haiku',      in: 1,    out: 5 },
];
const FALLBACK_PRICE = { label: 'Other', in: 3, out: 15 };

function priceFor(model) {
  return PRICING.find(p => p.match.test(model || '')) || FALLBACK_PRICE;
}

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };

if (has('--help') || has('-h')) {
  console.log(`
  claude-code-wrapped — your Claude Code usage, Wrapped 🎁

  Usage: claude-wrapped [options]

  Options:
    --demo           Generate a report with sample data (try it without Claude Code)
    --since <date>   Only include activity since YYYY-MM-DD
    --dir <path>     Custom transcripts dir (default: ~/.claude/projects)
    --out <file>     Output HTML path (default: ./claude-wrapped.html)
    --json           Print raw stats as JSON instead of generating HTML
    --no-open        Don't auto-open the report in the browser
    -h, --help       Show this help
`);
  process.exit(0);
}

// ─── Transcript parsing ───────────────────────────────────────────────────────
function* jsonlEntries(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* tolerate partial lines */ }
  }
}

function decodeProjectDir(name) {
  // "-Users-vic98lg-Documents-Proyectos-tools" → "tools" (last meaningful segment)
  const parts = name.replace(/^-/, '').split('-').filter(Boolean);
  return parts.slice(-2).join('-').length <= 24 && parts.length > 1
    ? parts[parts.length - 1] || name
    : parts[parts.length - 1] || name;
}

function newStats() {
  return {
    generatedAt: new Date().toISOString(),
    firstTs: null, lastTs: null,
    sessions: 0,
    userPrompts: 0, assistantMsgs: 0, toolResults: 0, toolErrors: 0,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    models: {},        // label → {msgs, input, output, cacheWrite, cacheRead, cost}
    tools: {},         // name → count
    projects: {},      // name → {sessions, msgs, tokens}
    files: {},         // basename → count (Edit/Write)
    bashCmds: {},      // first word → count
    heatmap: Array.from({ length: 7 }, () => Array(24).fill(0)), // [dow][hour]
    days: {},          // YYYY-MM-DD → msg count
    sessionsMeta: [],  // {id, project, msgs, activeMin}
    agentSpawns: 0,
    cost: 0, cacheSavings: 0,
  };
}

function collect(dir, since) {
  const stats = newStats();
  let projDirs = [];
  try { projDirs = fs.readdirSync(dir).filter(d => !d.startsWith('.')); } catch {
    return null;
  }

  for (const pd of projDirs) {
    const full = path.join(dir, pd);
    let files = [];
    try { files = fs.readdirSync(full).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    const decodedName = decodeProjectDir(pd);

    for (const f of files) {
      const sessionTimestamps = [];
      let sessionMsgs = 0;
      let sessionCounted = false;
      let projName = null;

      for (const e of jsonlEntries(path.join(full, f))) {
        if (!e || typeof e !== 'object') continue;
        const ts = e.timestamp ? new Date(e.timestamp) : null;
        if (since && ts && ts < since) continue;
        if (e.type !== 'user' && e.type !== 'assistant') continue;

        if (!sessionCounted) {
          sessionCounted = true;
          // Prefer the real cwd over the lossy dash-encoded dir name
          projName = (e.cwd && path.basename(e.cwd)) || decodedName;
          stats.sessions++;
          stats.projects[projName] = stats.projects[projName] || { sessions: 0, msgs: 0, tokens: 0 };
          stats.projects[projName].sessions++;
        }

        if (ts && !isNaN(ts)) {
          sessionTimestamps.push(ts);
          if (!stats.firstTs || ts < stats.firstTs) stats.firstTs = ts;
          if (!stats.lastTs || ts > stats.lastTs) stats.lastTs = ts;
          stats.heatmap[(ts.getDay() + 6) % 7][ts.getHours()]++; // Monday-first
          const day = ts.toISOString().slice(0, 10);
          stats.days[day] = (stats.days[day] || 0) + 1;
        }

        const msg = e.message || {};
        const content = Array.isArray(msg.content) ? msg.content : [];

        if (e.type === 'user') {
          const hasToolResult = content.some(c => c && c.type === 'tool_result');
          if (hasToolResult) {
            stats.toolResults++;
            for (const c of content) if (c && c.type === 'tool_result' && c.is_error) stats.toolErrors++;
          } else {
            stats.userPrompts++;
            sessionMsgs++;
            stats.projects[projName].msgs++;
          }
        } else { // assistant
          stats.assistantMsgs++;
          sessionMsgs++;
          const u = msg.usage;
          if (u) {
            const inn = u.input_tokens || 0, out = u.output_tokens || 0;
            const cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
            stats.tokens.input += inn; stats.tokens.output += out;
            stats.tokens.cacheWrite += cw; stats.tokens.cacheRead += cr;
            const p = priceFor(msg.model);
            const m = stats.models[p.label] = stats.models[p.label] ||
              { msgs: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
            m.msgs++; m.input += inn; m.output += out; m.cacheWrite += cw; m.cacheRead += cr;
            const cost = (inn * p.in + out * p.out + cw * p.in * 1.25 + cr * p.in * 0.1) / 1e6;
            m.cost += cost;
            stats.cost += cost;
            stats.cacheSavings += (cr * p.in * 0.9) / 1e6; // what cacheRead would have cost as fresh input
            stats.projects[projName].tokens += inn + out + cw + cr;
          }
          for (const c of content) {
            if (!c || c.type !== 'tool_use') continue;
            stats.tools[c.name] = (stats.tools[c.name] || 0) + 1;
            if (c.name === 'Agent' || c.name === 'Task') stats.agentSpawns++;
            const input = c.input || {};
            if ((c.name === 'Edit' || c.name === 'Write' || c.name === 'MultiEdit') && input.file_path) {
              const base = path.basename(String(input.file_path));
              stats.files[base] = (stats.files[base] || 0) + 1;
            }
            if (c.name === 'Bash' && typeof input.command === 'string') {
              const first = input.command.trim().split(/\s+/)[0];
              if (first && first.length < 30) stats.bashCmds[first] = (stats.bashCmds[first] || 0) + 1;
            }
          }
        }
      }

      if (sessionTimestamps.length > 1) {
        sessionTimestamps.sort((a, b) => a - b);
        // Active time: sum of gaps ≤ 15 min (ignores overnight resumes)
        let activeMs = 0;
        for (let i = 1; i < sessionTimestamps.length; i++) {
          const gap = sessionTimestamps[i] - sessionTimestamps[i - 1];
          if (gap <= 15 * 60 * 1000) activeMs += gap;
        }
        stats.sessionsMeta.push({ project: projName, msgs: sessionMsgs, activeMin: Math.round(activeMs / 60000) });
      }
    }
  }

  return stats.sessions ? stats : null;
}

// ─── Derived insights ─────────────────────────────────────────────────────────
function derive(s) {
  const dayKeys = Object.keys(s.days).sort();
  // Longest streak of consecutive days
  let streak = 0, best = 0, prev = null;
  for (const d of dayKeys) {
    const t = new Date(d + 'T00:00:00Z').getTime();
    streak = (prev !== null && t - prev === 86400000) ? streak + 1 : 1;
    best = Math.max(best, streak);
    prev = t;
  }
  const busiest = dayKeys.reduce((a, d) => (s.days[d] > (s.days[a] || 0) ? d : a), dayKeys[0]);

  let total = 0, night = 0, weekend = 0;
  s.heatmap.forEach((row, dow) => row.forEach((n, h) => {
    total += n;
    if (h >= 22 || h < 6) night += n;
    if (dow >= 5) weekend += n;
  }));

  const topOf = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  const longest = s.sessionsMeta.slice().sort((a, b) => b.activeMin - a.activeMin)[0] || null;
  const chattiest = s.sessionsMeta.slice().sort((a, b) => b.msgs - a.msgs)[0] || null;

  const totalTokens = s.tokens.input + s.tokens.output + s.tokens.cacheWrite + s.tokens.cacheRead;
  const cacheRatio = totalTokens ? s.tokens.cacheRead / totalTokens : 0;
  const writes = (s.tools.Edit || 0) + (s.tools.Write || 0) + (s.tools.MultiEdit || 0);

  const badges = [];
  if (total && night / total > 0.25) badges.push(['🦉', 'Night Owl', 'Over 25% of your activity happens between 10pm and 6am']);
  if (total && weekend / total > 0.25) badges.push(['🏖️', 'Weekend Warrior', 'More than a quarter of your coding happens on weekends']);
  if (best >= 7) badges.push(['🔥', 'On Fire', `A ${best}-day streak of coding with Claude`]);
  if (cacheRatio > 0.8) badges.push(['⚡', 'Cache Master', `${Math.round(cacheRatio * 100)}% of your tokens came from cache`]);
  if (writes > 300) badges.push(['🚢', 'Serial Shipper', `${writes.toLocaleString()} file edits and counting`]);
  if (Object.keys(s.projects).length >= 4) badges.push(['🎪', 'Multitasker', `Active in ${Object.keys(s.projects).length} different projects`]);
  if (longest && longest.activeMin >= 180) badges.push(['🏃', 'Marathoner', `A single ${Math.round(longest.activeMin / 60 * 10) / 10}h focused session`]);
  if (s.agentSpawns >= 20) badges.push(['🤖', 'Agent Orchestrator', `Spawned ${s.agentSpawns} subagents`]);
  if (!badges.length) badges.push(['🌱', 'Getting Started', 'Your Claude Code journey has just begun']);

  return {
    streak: best,
    busiestDay: busiest ? { day: busiest, msgs: s.days[busiest] } : null,
    nightPct: total ? Math.round((night / total) * 100) : 0,
    weekendPct: total ? Math.round((weekend / total) * 100) : 0,
    daysActive: dayKeys.length,
    topTools: topOf(s.tools, 8),
    topProjects: topOf(Object.fromEntries(Object.entries(s.projects).map(([k, v]) => [k, v.tokens])), 6),
    topFiles: topOf(s.files, 6),
    topBash: topOf(s.bashCmds, 6),
    longestSession: longest,
    chattiestSession: chattiest,
    totalTokens, cacheRatio, badges,
  };
}

// ─── Demo data ────────────────────────────────────────────────────────────────
function demoStats() {
  const s = newStats();
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));
  s.sessions = 87; s.userPrompts = 1243; s.assistantMsgs = 3921; s.toolResults = 6480; s.toolErrors = 214;
  s.tokens = { input: 18_400_000, output: 6_200_000, cacheWrite: 22_000_000, cacheRead: 310_000_000 };
  s.models = {
    'Fable 5': { msgs: 900, input: 6e6, output: 2.5e6, cacheWrite: 9e6, cacheRead: 1.4e8, cost: 642 },
    'Sonnet': { msgs: 2400, input: 9e6, output: 3e6, cacheWrite: 10e6, cacheRead: 1.3e8, cost: 148 },
    'Haiku': { msgs: 621, input: 3.4e6, output: 0.7e6, cacheWrite: 3e6, cacheRead: 4e7, cost: 15 },
  };
  s.tools = { Bash: 2210, Edit: 1876, Read: 1690, Write: 512, Grep: 488, WebSearch: 96, Agent: 44, Glob: 210 };
  s.projects = {
    'side-project': { sessions: 31, msgs: 480, tokens: 1.4e8 },
    'api-server': { sessions: 22, msgs: 350, tokens: 9e7 },
    'dotfiles': { sessions: 12, msgs: 130, tokens: 3e7 },
    'blog': { sessions: 10, msgs: 160, tokens: 5e7 },
    'ml-experiments': { sessions: 8, msgs: 90, tokens: 2.6e7 },
    'game-jam': { sessions: 4, msgs: 33, tokens: 2e7 },
  };
  s.files = { 'index.ts': 214, 'app.py': 178, 'main.rs': 122, 'schema.sql': 84, 'utils.ts': 71, 'README.md': 64 };
  s.bashCmds = { git: 820, npm: 415, python: 260, cargo: 190, docker: 130, pytest: 96 };
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
    s.heatmap[d][h] = (h > 8 && h < 20) ? rnd(0, d < 5 ? 90 : 40) : (h >= 22 || h < 2) ? rnd(0, 35) : rnd(0, 6);
  }
  const start = Date.now() - 200 * 86400000;
  for (let i = 0; i < 200; i++) {
    if (Math.random() < 0.55) s.days[new Date(start + i * 86400000).toISOString().slice(0, 10)] = rnd(5, 120);
  }
  const dk = Object.keys(s.days).sort();
  s.firstTs = new Date(dk[0]); s.lastTs = new Date();
  s.sessionsMeta = Array.from({ length: 40 }, () => ({ project: 'side-project', msgs: rnd(4, 90), activeMin: rnd(10, 290) }));
  s.agentSpawns = 44; s.cost = 805; s.cacheSavings = 4980;
  return s;
}

// ─── Terminal report ──────────────────────────────────────────────────────────
const C = { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', mag: '\x1b[35m', cyan: '\x1b[36m', grn: '\x1b[32m', yel: '\x1b[33m' };
const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);

function printTerminal(s, d) {
  const line = C.dim + '─'.repeat(46) + C.r;
  console.log(`\n${C.b}${C.mag}  🎁 Claude Code Wrapped${C.r}`);
  console.log(`  ${C.dim}${s.firstTs?.toISOString().slice(0, 10)} → ${s.lastTs?.toISOString().slice(0, 10)}${C.r}`);
  console.log(line);
  console.log(`  ${C.cyan}${C.b}${fmt(d.totalTokens)}${C.r} tokens across ${C.b}${s.sessions}${C.r} sessions on ${C.b}${d.daysActive}${C.r} days`);
  console.log(`  ${C.b}${s.userPrompts.toLocaleString()}${C.r} prompts · ${C.b}${s.assistantMsgs.toLocaleString()}${C.r} responses · streak ${C.b}${d.streak}${C.r} days`);
  console.log(`  est. cost ${C.yel}${C.b}$${s.cost.toFixed(0)}${C.r} · cache saved you ${C.grn}${C.b}$${s.cacheSavings.toFixed(0)}${C.r} (${Math.round(d.cacheRatio * 100)}% cached)`);
  console.log(line);
  console.log(`  ${C.b}Top tools:${C.r}    ` + d.topTools.slice(0, 5).map(([n, c]) => `${n} ${C.dim}${fmt(c)}${C.r}`).join('  '));
  console.log(`  ${C.b}Top projects:${C.r} ` + d.topProjects.slice(0, 3).map(([n]) => n).join(', '));
  console.log(`  ${C.b}Badges:${C.r}       ` + d.badges.map(b => `${b[0]} ${b[1]}`).join('  ·  '));
  console.log(line + '\n');
}

// ─── HTML report ──────────────────────────────────────────────────────────────
function buildHTML(s, d) {
  const payload = JSON.stringify({
    range: [s.firstTs, s.lastTs],
    sessions: s.sessions, prompts: s.userPrompts, responses: s.assistantMsgs,
    toolResults: s.toolResults, toolErrors: s.toolErrors, agentSpawns: s.agentSpawns,
    tokens: s.tokens, models: s.models, cost: s.cost, savings: s.cacheSavings,
    heatmap: s.heatmap, derived: d,
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Claude Code Wrapped</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#0b0e14;--card:#12161f;--border:#1e2531;--text:#e8ecf3;--muted:#8b93a5;
    --g1:#c084fc;--g2:#60a5fa;--g3:#34d399;--grad:linear-gradient(120deg,#c084fc,#60a5fa 50%,#34d399)}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;
    line-height:1.5;padding:40px 20px 80px;overflow-x:hidden}
  .wrap{max-width:960px;margin:0 auto}
  .bg-glow{position:fixed;width:600px;height:600px;border-radius:50%;filter:blur(140px);opacity:.14;pointer-events:none;z-index:0}
  .glow1{background:#c084fc;top:-200px;left:-150px}.glow2{background:#34d399;bottom:-250px;right:-150px}
  section{position:relative;z-index:1}

  header{text-align:center;padding:60px 0 50px}
  .eyebrow{font-size:.8rem;letter-spacing:.25em;text-transform:uppercase;color:var(--muted)}
  h1{font-size:clamp(2.6rem,7vw,4.4rem);font-weight:800;margin:10px 0 6px;
    background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
  .range{color:var(--muted);font-size:.95rem}
  .hero-token{font-size:clamp(3rem,9vw,5.5rem);font-weight:800;margin-top:34px;font-variant-numeric:tabular-nums}
  .hero-sub{color:var(--muted);margin-top:2px}

  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:40px 0}
  .card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:22px;
    animation:up .6s ease both}
  .card .n{font-size:1.9rem;font-weight:700;font-variant-numeric:tabular-nums}
  .card .l{font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-top:4px}
  .card.money .n{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
  @keyframes up{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}

  h2{font-size:1.15rem;margin:52px 0 18px;display:flex;align-items:center;gap:10px}
  h2::after{content:'';flex:1;height:1px;background:var(--border)}

  .bars{display:flex;flex-direction:column;gap:9px}
  .bar-row{display:grid;grid-template-columns:130px 1fr 64px;gap:12px;align-items:center;font-size:.86rem}
  .bar-row .name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
  .bar-track{background:var(--border);border-radius:6px;height:12px;overflow:hidden}
  .bar-fill{height:100%;border-radius:6px;background:var(--grad);width:0;transition:width 1s cubic-bezier(.2,.7,.3,1)}
  .bar-row .v{color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}

  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:640px){.two-col{grid-template-columns:1fr}}
  .list{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px 22px}
  .list h3{font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}
  .list ol{list-style:none;counter-reset:x}
  .list li{counter-increment:x;display:flex;justify-content:space-between;padding:5px 0;font-size:.9rem;border-bottom:1px dashed var(--border)}
  .list li:last-child{border:none}
  .list li::before{content:counter(x) '.';color:var(--muted);margin-right:10px}
  .list li .k{flex:1;font-family:ui-monospace,Menlo,monospace;font-size:.84rem}
  .list li .c{color:var(--muted);font-variant-numeric:tabular-nums}

  .heat{display:grid;grid-template-columns:34px repeat(24,1fr);gap:3px;font-size:.62rem;color:var(--muted)}
  .heat .cell{aspect-ratio:1;border-radius:3px;background:var(--border)}
  .heat .lbl{display:flex;align-items:center}
  .heat .hr{text-align:center;grid-column:span 2}

  .badges{display:flex;flex-wrap:wrap;gap:12px}
  .badge{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 18px;
    display:flex;gap:12px;align-items:center;max-width:300px}
  .badge .e{font-size:1.7rem}
  .badge b{display:block;font-size:.92rem}
  .badge span{font-size:.76rem;color:var(--muted)}

  .share{text-align:center;margin-top:60px}
  .share button{background:var(--grad);border:none;color:#0b0e14;font-weight:700;font-size:.95rem;
    padding:13px 30px;border-radius:12px;cursor:pointer;transition:transform .15s}
  .share button:hover{transform:translateY(-2px)}
  .share canvas{display:none}
  footer{text-align:center;color:var(--muted);font-size:.78rem;margin-top:70px}
  footer a{color:var(--g2);text-decoration:none}
</style>
</head>
<body>
<div class="bg-glow glow1"></div><div class="bg-glow glow2"></div>
<div class="wrap">

<header>
  <div class="eyebrow">Your dev life, unwrapped</div>
  <h1>Claude Code Wrapped</h1>
  <div class="range" id="range"></div>
  <div class="hero-token" id="hero-tokens">0</div>
  <div class="hero-sub">total tokens processed</div>
</header>

<section><div class="grid" id="stat-grid"></div></section>

<section><h2>🤖 Models</h2><div class="bars" id="model-bars"></div></section>

<section><h2>🛠️ Favorite tools</h2><div class="bars" id="tool-bars"></div></section>

<section><h2>📁 Top projects <span style="font-size:.7rem;color:var(--muted);font-weight:400">by tokens</span></h2>
  <div class="bars" id="proj-bars"></div></section>

<section><h2>🔍 The details</h2>
  <div class="two-col">
    <div class="list"><h3>Most edited files</h3><ol id="file-list"></ol></div>
    <div class="list"><h3>Top shell commands</h3><ol id="bash-list"></ol></div>
  </div>
</section>

<section><h2>🗓️ When you code</h2><div class="heat" id="heat"></div></section>

<section><h2>🏆 Badges earned</h2><div class="badges" id="badges"></div></section>

<div class="share">
  <button id="btn-share">📸 Download share card</button>
  <canvas id="share-canvas" width="1080" height="1350"></canvas>
</div>

<footer>
  Generated locally by <a href="https://github.com/vic98lg/claude-code-wrapped">claude-code-wrapped</a>
  — nothing left your machine. Costs are estimates at API list prices.
</footer>
</div>

<script>
const DATA = ${payload};
const $ = id => document.getElementById(id);
const fmt = n => n>=1e9?(n/1e9).toFixed(1)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(Math.round(n));
const D = DATA.derived;

$('range').textContent = (DATA.range[0]||'').slice(0,10) + '  →  ' + (DATA.range[1]||'').slice(0,10);

// Animated hero counter
(function(){
  const el = $('hero-tokens'), target = D.totalTokens, t0 = performance.now();
  (function tick(t){
    const k = Math.min(1,(t-t0)/1600), e = 1-Math.pow(1-k,3);
    el.textContent = fmt(target*e);
    if(k<1) requestAnimationFrame(tick); else el.textContent = fmt(target);
  })(t0);
})();

// Stat cards
const cards = [
  [DATA.sessions.toLocaleString(),'sessions'],
  [D.daysActive,'days active'],
  [D.streak + 'd','longest streak'],
  [DATA.prompts.toLocaleString(),'prompts sent'],
  [fmt(DATA.tokens.output),'tokens written by claude'],
  [Math.round(D.cacheRatio*100)+'%','served from cache'],
  ['$'+Math.round(DATA.cost).toLocaleString(),'estimated cost','money'],
  ['$'+Math.round(DATA.savings).toLocaleString(),'saved by caching','money'],
];
$('stat-grid').innerHTML = cards.map(([n,l,cls],i) =>
  \`<div class="card \${cls||''}" style="animation-delay:\${i*70}ms"><div class="n">\${n}</div><div class="l">\${l}</div></div>\`).join('');

// Bars helper
function bars(el, entries, fmtV){
  const max = Math.max(...entries.map(e=>e[1]), 1);
  el.innerHTML = entries.map(([n,v]) => \`
    <div class="bar-row"><span class="name">\${n}</span>
    <div class="bar-track"><div class="bar-fill" data-w="\${(v/max*100).toFixed(1)}"></div></div>
    <span class="v">\${fmtV(v)}</span></div>\`).join('');
  requestAnimationFrame(()=>requestAnimationFrame(()=>
    el.querySelectorAll('.bar-fill').forEach(b=>b.style.width=b.dataset.w+'%')));
}
bars($('model-bars'), Object.entries(DATA.models).map(([k,v])=>[k, v.input+v.output+v.cacheWrite+v.cacheRead]).sort((a,b)=>b[1]-a[1]), fmt);
bars($('tool-bars'), D.topTools, fmt);
bars($('proj-bars'), D.topProjects, fmt);

// Lists
$('file-list').innerHTML = D.topFiles.map(([k,c])=>\`<li><span class="k">\${k}</span><span class="c">\${c}</span></li>\`).join('') || '<li>—</li>';
$('bash-list').innerHTML = D.topBash.map(([k,c])=>\`<li><span class="k">\${k}</span><span class="c">\${c}</span></li>\`).join('') || '<li>—</li>';

// Heatmap
(function(){
  const days=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const max = Math.max(...DATA.heatmap.flat(), 1);
  let html = '<div></div>';
  for(let h=0;h<24;h+=2) html += \`<div class="hr">\${h}h</div>\`;
  DATA.heatmap.forEach((row,d)=>{
    html += \`<div class="lbl">\${days[d]}</div>\`;
    row.forEach(v=>{
      const a = v ? .15 + .85*(v/max) : 0;
      html += \`<div class="cell" style="\${v?\`background:rgba(96,165,250,\${a.toFixed(2)})\`:''}" title="\${v}"></div>\`;
    });
  });
  $('heat').innerHTML = html;
})();

// Badges
$('badges').innerHTML = D.badges.map(([e,t,s])=>
  \`<div class="badge"><span class="e">\${e}</span><div><b>\${t}</b><span>\${s}</span></div></div>\`).join('');

// Share card (canvas → PNG)
$('btn-share').addEventListener('click', ()=>{
  const c = $('share-canvas'), x = c.getContext('2d'), W=1080, H=1350;
  const g = x.createLinearGradient(0,0,W,H);
  g.addColorStop(0,'#151028'); g.addColorStop(1,'#0b1a18');
  x.fillStyle=g; x.fillRect(0,0,W,H);
  const g2 = x.createLinearGradient(0,0,W,0);
  g2.addColorStop(0,'#c084fc'); g2.addColorStop(.5,'#60a5fa'); g2.addColorStop(1,'#34d399');

  x.textAlign='center'; x.fillStyle='#8b93a5';
  x.font='600 30px -apple-system,Segoe UI,sans-serif';
  x.fillText('C L A U D E   C O D E', W/2, 140);
  x.fillStyle=g2; x.font='800 96px -apple-system,Segoe UI,sans-serif';
  x.fillText('Wrapped', W/2, 250);
  x.fillStyle='#e8ecf3'; x.font='800 150px -apple-system,Segoe UI,sans-serif';
  x.fillText(fmt(D.totalTokens), W/2, 470);
  x.fillStyle='#8b93a5'; x.font='400 34px -apple-system,Segoe UI,sans-serif';
  x.fillText('tokens processed', W/2, 525);

  const rows = [
    [DATA.sessions.toLocaleString()+' sessions', D.daysActive+' active days'],
    [DATA.prompts.toLocaleString()+' prompts', D.streak+'-day streak'],
    ['$'+Math.round(DATA.cost)+' est. cost', '$'+Math.round(DATA.savings)+' cache savings'],
  ];
  x.font='700 44px -apple-system,Segoe UI,sans-serif';
  rows.forEach((r,i)=>{
    const y = 660 + i*120;
    x.fillStyle='#e8ecf3'; x.textAlign='center';
    x.fillText(r[0], W/4+40, y); x.fillText(r[1], 3*W/4-40, y);
  });

  x.font='400 40px -apple-system,Segoe UI,sans-serif';
  const bl = D.badges.slice(0,3).map(b=>b[0]+' '+b[1]).join('    ');
  x.fillStyle='#c084fc'; x.fillText(bl, W/2, 1120);

  x.fillStyle='#8b93a5'; x.font='400 28px -apple-system,Segoe UI,sans-serif';
  x.fillText('github.com/vic98lg/claude-code-wrapped', W/2, 1280);

  c.toBlob(b=>{
    const a=document.createElement('a');
    a.href=URL.createObjectURL(b); a.download='claude-code-wrapped.png'; a.click();
  });
});
</script>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const since = val('--since') ? new Date(val('--since') + 'T00:00:00') : null;
  const dir = val('--dir') || path.join(os.homedir(), '.claude', 'projects');

  let stats;
  if (has('--demo')) {
    stats = demoStats();
  } else {
    stats = collect(dir, since);
    if (!stats) {
      console.error(`\n  No Claude Code transcripts found in ${dir}`);
      console.error('  Try --demo to see a sample report, or --dir <path> if yours live elsewhere.\n');
      process.exit(1);
    }
  }

  const d = derive(stats);

  if (has('--json')) {
    console.log(JSON.stringify({ ...stats, derived: d }, null, 2));
    return;
  }

  printTerminal(stats, d);

  const out = path.resolve(val('--out') || 'claude-wrapped.html');
  fs.writeFileSync(out, buildHTML(stats, d));
  console.log(`  Report: ${out}\n`);

  if (!has('--no-open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(opener, [out], () => {});
  }
}

main();
