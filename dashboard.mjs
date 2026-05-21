#!/usr/bin/env node
/**
 * dashboard.mjs — Career-Ops web dashboard
 *
 * Usage:  node dashboard.mjs
 * Open:   http://localhost:3001
 *
 * ── Adding a new command ─────────────────────────────────────────
 * Append an entry to the COMMANDS array. Types:
 *   stream   — runs a shell command, streams stdout/stderr to the terminal panel
 *   table    — parses applications.md and renders a score-sorted table
 *   liveness — extracts URLs from reports/ and runs the liveness checker
 */

import { createServer } from 'http';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const PORT = 3001;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ── Commands — add new entries here ──────────────────────────────
export const COMMANDS = [
  // Scanning
  {
    id: 'scan',
    label: 'Run Scan',
    icon: '🔍',
    group: 'Scanning',
    description: 'Scan all enabled portals for new postings',
    type: 'stream',
    shell: 'node scan.mjs',
  },
  {
    id: 'scan-dry',
    label: 'Dry-Run Scan',
    icon: '🧪',
    group: 'Scanning',
    description: 'Preview scan without writing to pipeline',
    type: 'stream',
    shell: 'node scan.mjs --dry-run',
  },
  {
    id: 'pipeline',
    label: 'Run Pipeline',
    icon: '⚡',
    group: 'Scanning',
    description: 'Evaluate pending URLs in pipeline.md via Claude CLI',
    type: 'stream',
    shell: 'claude -p "/career-ops pipeline"',
  },
  // Review
  {
    id: 'table',
    label: 'Score Table',
    icon: '📊',
    group: 'Review',
    description: 'All evaluated jobs sorted by match score',
    type: 'table',
  },
  {
    id: 'stats',
    label: 'Statistics',
    icon: '🗂️',
    group: 'Review',
    description: 'Pipeline stats, score distribution, and open application ages',
    type: 'stats',
  },
  {
    id: 'liveness',
    label: 'Liveness Check',
    icon: '❤️',
    group: 'Review',
    description: 'Verify job postings in reports/ are still active',
    type: 'liveness',
  },
  {
    id: 'patterns',
    label: 'Analyze Patterns',
    icon: '📈',
    group: 'Review',
    description: 'Rejection and success patterns across applications',
    type: 'patterns',
  },
  {
    id: 'followup',
    label: 'Follow-up Cadence',
    icon: '📅',
    group: 'Review',
    description: 'Which applications are due for follow-up',
    type: 'followup',
  },
  // Maintenance
  {
    id: 'merge',
    label: 'Merge Tracker',
    icon: '🔀',
    group: 'Maintenance',
    description: 'Merge batch TSV additions into applications.md',
    type: 'stream',
    shell: 'node merge-tracker.mjs',
  },
  {
    id: 'verify',
    label: 'Verify Pipeline',
    icon: '✅',
    group: 'Maintenance',
    description: 'Run pipeline integrity health checks',
    type: 'stream',
    shell: 'node verify-pipeline.mjs',
  },
  {
    id: 'dedup',
    label: 'Dedup Tracker',
    icon: '🧹',
    group: 'Maintenance',
    description: 'Remove duplicate entries from applications.md',
    type: 'stream',
    shell: 'node dedup-tracker.mjs',
  },
  {
    id: 'update',
    label: 'Check Updates',
    icon: '🔄',
    group: 'Maintenance',
    description: 'Check for career-ops system updates',
    type: 'stream',
    shell: 'node update-system.mjs check',
  },
];

// ── Data helpers ──────────────────────────────────────────────────

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[mGKHFJsuhl]/g, '').replace(/\r/g, ''); // eslint-disable-line no-control-regex
}

function parseApplications() {
  const file = path.join(ROOT, 'data', 'applications.md');
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 7 || cols[0] === '#' || /^-+$/.test(cols[0])) continue;
    const score = parseFloat(cols[4]);
    if (isNaN(score)) continue;
    const reportMatch = (cols[7] ?? '').match(/\[(\d+)\]\(([^)]+)\)/);
    rows.push({
      num: cols[0],
      date: cols[1],
      company: cols[2],
      role: cols[3],
      scoreStr: cols[4],
      score,
      status: cols[5],
      pdf: cols[6],
      reportNum: reportMatch?.[1] ?? '',
      reportPath: reportMatch?.[2] ?? '',
      notes: cols[8] ?? '',
    });
  }
  return rows.sort((a, b) => b.score - a.score);
}

function computeStats() {
  const apps = parseApplications();
  const logFile = path.join(ROOT, 'data', 'activity-log.md');
  const activityMap = {};
  if (existsSync(logFile)) {
    for (const line of readFileSync(logFile, 'utf-8').split('\n')) {
      if (!line.startsWith('|')) continue;
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 4 || cols[0] === '#' || /^-+$/.test(cols[0])) continue;
      const n = cols[1];
      if (!activityMap[n]) activityMap[n] = [];
      activityMap[n].push({ date: cols[2], event: cols[3], notes: cols[4] || '' });
    }
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const activeSet  = new Set(['applied', 'responded', 'interview']);
  const closedSet  = new Set(['rejected', 'discarded', 'offer']);
  const byStage    = { Applied: 0, Responded: 0, Interview: 0, Offer: 0, Rejected: 0, Discarded: 0 };
  const scores     = { high: 0, mid: 0, low: 0 };
  let appliedCount = 0, activeCount = 0, closedCount = 0;
  const openApps = [], appliedDates = [];

  for (const app of apps) {
    const sl = (app.status || '').toLowerCase();
    if (app.score >= 4.0) scores.high++; else if (app.score >= 3.0) scores.mid++; else scores.low++;

    const cap = app.status.charAt(0).toUpperCase() + app.status.slice(1).toLowerCase();
    if (byStage.hasOwnProperty(cap)) byStage[cap]++;

    if (activeSet.has(sl) || closedSet.has(sl)) appliedCount++;
    if (activeSet.has(sl)) activeCount++;
    if (closedSet.has(sl)) closedCount++;

    const entries = activityMap[app.num] || [];
    const appliedEntry = entries.find(e => e.event.toLowerCase() === 'applied');
    const appliedDate  = appliedEntry ? appliedEntry.date : null;
    if (appliedDate) appliedDates.push(new Date(appliedDate));

    if (activeSet.has(sl)) {
      const ref = appliedDate || app.date;
      const ageDays = Math.floor((today - new Date(ref)) / 86400000);
      openApps.push({ num: app.num, company: app.company, role: app.role, status: app.status, appliedDate: ref, ageDays });
    }
  }

  openApps.sort((a, b) => b.ageDays - a.ageDays);
  appliedDates.sort((a, b) => a - b);

  let weeklyRate = null, weeklyRateSince = null;
  if (appliedDates.length > 0) {
    const weeks = Math.max(1, (today - appliedDates[0]) / (7 * 86400000));
    weeklyRate = (appliedCount / weeks).toFixed(1);
    weeklyRateSince = appliedDates[0].toISOString().slice(0, 10);
  }

  return {
    totals: { evaluated: apps.length, applied: appliedCount, active: activeCount, closed: closedCount },
    byStage, scores, weeklyRate, weeklyRateSince, openApps,
  };
}

function getApplicationInfo(appNum) {
  const file = path.join(ROOT, 'data', 'applications.md');
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (!cols.length || cols[0] === '#' || /^-+$/.test(cols[0])) continue;
    if (parseInt(cols[0]) === parseInt(appNum)) {
      return { num: cols[0], date: cols[1], company: cols[2], role: cols[3], score: cols[4], status: cols[5] };
    }
  }
  return null;
}

function getActivityLog(appNum) {
  const file = path.join(ROOT, 'data', 'activity-log.md');
  if (!existsSync(file)) return [];
  const entries = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 4 || cols[0] === '#' || /^-+$/.test(cols[0])) continue;
    if (parseInt(cols[1]) === parseInt(appNum)) {
      entries.push({ seq: cols[0], app: cols[1], date: cols[2], event: cols[3], notes: cols[4] || '' });
    }
  }
  return entries;
}

function appendToActivityLog({ app, event, date, notes }) {
  const file = path.join(ROOT, 'data', 'activity-log.md');
  if (!existsSync(file)) {
    writeFileSync(file, '# Activity Log\n\n| # | App | Date | Event | Notes |\n|---|-----|------|-------|-------|\n', 'utf-8');
  }
  const content = readFileSync(file, 'utf-8');
  let maxSeq = 0;
  for (const line of content.split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map(c => c.trim()).filter(Boolean);
    const n = parseInt(parts[0]);
    if (!isNaN(n) && n > maxSeq) maxSeq = n;
  }
  const safeNotes = (notes || '').replace(/\|/g, '/');
  writeFileSync(file, content.trimEnd() + '\n| ' + (maxSeq + 1) + ' | ' + app + ' | ' + date + ' | ' + event + ' | ' + safeNotes + ' |\n', 'utf-8');
}

function updateApplicationStatus(appNum, newStatus) {
  const file = path.join(ROOT, 'data', 'applications.md');
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf-8').split('\n');
  const updated = lines.map(line => {
    if (!line.startsWith('|')) return line;
    const parts = line.split('|');
    const cols = parts.map(c => c.trim()).filter(Boolean);
    if (!cols.length || cols[0] === '#' || /^-+$/.test(cols[0])) return line;
    if (parseInt(cols[0]) !== parseInt(appNum)) return line;
    // Column layout: | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
    // parts[0]='' parts[1]=# parts[2]=Date parts[3]=Company parts[4]=Role parts[5]=Score parts[6]=Status
    parts[6] = ' ' + newStatus + ' ';
    return parts.join('|');
  });
  writeFileSync(file, updated.join('\n'), 'utf-8');
}

function getReportUrls() {
  const dir = path.join(ROOT, 'reports');
  if (!existsSync(dir)) return [];
  const urls = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
    try {
      const m = readFileSync(path.join(dir, f), 'utf-8').match(/\*\*URL:\*\*\s*(https?:\/\/[^\s\n]+)/);
      if (m) urls.push(m[1]);
    } catch { /* skip */ }
  }
  return [...new Set(urls)];
}

function getUrlMap() {
  const dir = path.join(ROOT, 'reports');
  if (!existsSync(dir)) return [];
  const apps = parseApplications();
  const byReportNum = {};
  for (const a of apps) {
    if (a.reportNum) byReportNum[a.reportNum] = a;
  }
  const map = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
    try {
      const content = readFileSync(path.join(dir, f), 'utf-8');
      const urlM = content.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s\n]+)/);
      if (!urlM) continue;
      const numM = f.match(/^(\d+)-/);
      if (!numM) continue;
      const app = byReportNum[numM[1]];
      if (!app) continue;
      map.push({ url: urlM[1], appNum: app.num, company: app.company, role: app.role, status: app.status });
    } catch { /* skip */ }
  }
  return map;
}

// ── SSE helpers ───────────────────────────────────────────────────

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': '*',
};

function sseWrite(res, chunk) {
  for (const line of stripAnsi(chunk.toString()).split('\n')) {
    if (line.trim()) res.write('data: ' + line + '\n\n');
  }
}

function sseDone(res) {
  res.write('event: done\ndata: {}\n\n');
  res.end();
}

// ── Active process tracking ───────────────────────────────────────

let activeChild = null;
let activeLabel = null;

function setActive(child, label) {
  activeChild = child;
  activeLabel = label;
  child.on('close', () => { if (activeChild === child) { activeChild = null; activeLabel = null; } });
}

function runStream(shell, req, res, label) {
  res.writeHead(200, SSE_HEADERS);
  const child = spawn(shell, { shell: true, cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  setActive(child, label || shell);
  child.stdout.on('data', d => sseWrite(res, d));
  child.stderr.on('data', d => sseWrite(res, d));
  child.on('close', () => sseDone(res));
  req.on('close', () => { /* keep alive — browser disconnect does not kill the process */ });
}

function parsePipelineEntries(text) {
  const entries = new Map();
  for (const line of text.split('\n')) {
    const pendingM = line.match(/^- \[ \]\s*(https?:\/\/\S+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*$/);
    if (pendingM) { entries.set(pendingM[1], { status: 'pending', company: pendingM[2], title: pendingM[3] }); continue; }
    const doneM = line.match(/^- \[x\]\s*(?:#\d+\s*\|\s*)?(https?:\/\/\S+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([\d.]+\/5)/);
    if (doneM) { entries.set(doneM[1], { status: 'done', company: doneM[2], title: doneM[3], score: doneM[4] }); continue; }
    const doneSimpleM = line.match(/^- \[x\]\s*(?:#\d+\s*\|\s*)?(https?:\/\/\S+)/);
    if (doneSimpleM) { entries.set(doneSimpleM[1], { status: 'done' }); }
  }
  return entries;
}

function runPipelineStream(shell, req, res) {
  res.writeHead(200, SSE_HEADERS);
  const pipelineFile = path.join(ROOT, 'data', 'pipeline.md');

  let initialEntries = new Map();
  let knownDone = new Set();

  try {
    initialEntries = parsePipelineEntries(readFileSync(pipelineFile, 'utf-8'));
    initialEntries.forEach((v, url) => { if (v.status === 'done') knownDone.add(url); });
  } catch {}

  const pending = [...initialEntries.entries()].filter(([, v]) => v.status === 'pending');
  const total = pending.length;
  let processed = 0;

  sseWrite(res, `Pipeline starting — ${total} pending URL${total !== 1 ? 's' : ''} to evaluate\n`);
  pending.forEach(([url, v]) => sseWrite(res, `  · ${v.company || ''} — ${v.title || url}\n`));
  sseWrite(res, '\n');

  const watcher = setInterval(() => {
    try {
      const entries = parsePipelineEntries(readFileSync(pipelineFile, 'utf-8'));
      entries.forEach((v, url) => {
        if (v.status === 'done' && !knownDone.has(url) && initialEntries.has(url)) {
          knownDone.add(url);
          processed++;
          const info = initialEntries.get(url);
          const scoreStr = v.score ? ` → ${v.score}` : '';
          sseWrite(res, `[${processed}/${total}] ${info.company || ''} — ${info.title || url}${scoreStr}\n`);
        }
      });
    } catch {}
  }, 2000);

  const child = spawn(shell, { shell: true, cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  setActive(child, 'Run Pipeline');
  child.stdout.on('data', d => sseWrite(res, d));
  child.stderr.on('data', d => sseWrite(res, d));
  child.on('close', () => {
    clearInterval(watcher);
    sseWrite(res, `\nPipeline complete — ${processed}/${total} processed\n`);
    sseDone(res);
  });
  req.on('close', () => { /* keep alive */ });
}

// ── HTTP server ───────────────────────────────────────────────────

createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/') {
    const html = readFileSync(path.join(ROOT, 'dashboard.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (pathname === '/commands') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(COMMANDS));
    return;
  }

  if (pathname === '/proc-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ running: activeChild !== null, label: activeLabel }));
    return;
  }

  if (req.method === 'POST' && pathname === '/restart-server') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    if (activeChild) { try { activeChild.kill('SIGTERM'); } catch {} }
    setTimeout(() => {
      spawn('node', ['dashboard.mjs'], {
        detached: true, stdio: 'ignore', cwd: ROOT,
      }).unref();
      process.exit(0);
    }, 300);
    return;
  }

  if (req.method === 'POST' && pathname === '/kill') {
    if (activeChild) {
      try { activeChild.kill('SIGTERM'); } catch {}
      activeChild = null; activeLabel = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ killed: true }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ killed: false, reason: 'nothing running' }));
    }
    return;
  }

  if (pathname === '/pipeline-count') {
    const file = path.join(ROOT, 'data', 'pipeline.md');
    let count = 0;
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (/^- \[ \]/.test(line)) count++;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count }));
    return;
  }

  if (pathname === '/table-data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(parseApplications()));
    return;
  }

  if (pathname === '/report') {
    const qp = new URL(req.url, 'http://localhost').searchParams.get('path');
    if (!qp) { res.writeHead(400); res.end('Missing path'); return; }
    const abs = path.resolve(ROOT, qp);
    if (!abs.startsWith(path.join(ROOT, 'reports'))) { res.writeHead(403); res.end('Forbidden'); return; }
    if (!existsSync(abs)) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: readFileSync(abs, 'utf-8') }));
    return;
  }

  if (pathname === '/stats-data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(computeStats()));
    return;
  }

  if (pathname === '/activity' && req.method === 'GET') {
    const appNum = new URL(req.url, 'http://localhost').searchParams.get('app');
    if (!appNum) { res.writeHead(400); res.end('Missing app'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ baseline: getApplicationInfo(appNum), entries: getActivityLog(appNum) }));
    return;
  }

  if (pathname === '/activity' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { app, event, date, notes } = JSON.parse(body);
        if (!app || !event || !date) { res.writeHead(400); res.end('Missing fields'); return; }
        appendToActivityLog({ app: String(app), event, date, notes: notes || '' });
        updateApplicationStatus(app, event);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/followup-data') {
    const child = spawn('node followup-cadence.mjs', {
      shell: true, cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', () => {
      try {
        const data = JSON.parse(out);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to parse output from followup-cadence.mjs' }));
      }
    });
    return;
  }

  if (pathname === '/patterns-data') {
    const child = spawn('node analyze-patterns.mjs', {
      shell: true, cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', () => {
      try {
        const data = JSON.parse(out);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to parse output from analyze-patterns.mjs' }));
      }
    });
    return;
  }

  if (pathname === '/url-map') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getUrlMap()));
    return;
  }

  if (req.method === 'POST' && pathname === '/liveness-action') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { appNum, action } = JSON.parse(body);
        if (!appNum || action !== 'discard') { res.writeHead(400); res.end('Bad request'); return; }
        updateApplicationStatus(appNum, 'Discarded');
        appendToActivityLog({ app: String(appNum), event: 'Discarded', date: new Date().toISOString().slice(0, 10), notes: 'Job posting confirmed expired by liveness check' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/run/liveness') {
    const urls = getReportUrls();
    res.writeHead(200, SSE_HEADERS);
    if (!urls.length) {
      sseWrite(res, 'No URLs found in reports/\n');
      sseDone(res);
      return;
    }
    const tmp = path.join(ROOT, '.liveness-urls.tmp');
    writeFileSync(tmp, urls.join('\n'));
    sseWrite(res, `Checking ${urls.length} URL(s) from reports/...\n\n`);
    const child = spawn('node check-liveness.mjs --file ' + tmp, {
      shell: true, cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    setActive(child, 'Liveness Check');
    child.stdout.on('data', d => sseWrite(res, d));
    child.stderr.on('data', d => sseWrite(res, d));
    child.on('close', () => { try { unlinkSync(tmp); } catch {} sseDone(res); });
    return;
  }

  const m = pathname.match(/^\/run\/(.+)$/);
  if (m) {
    const cmd = COMMANDS.find(c => c.id === m[1] && c.type === 'stream');
    if (!cmd) { res.writeHead(404); res.end(); return; }
    if (cmd.id === 'pipeline') {
      runPipelineStream(cmd.shell, req, res);
    } else {
      runStream(cmd.shell, req, res, cmd.label);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log('Career-Ops dashboard → http://localhost:' + PORT);
});
