import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const APPS_FILE = join(DATA_DIR, 'applications.md');
const ACTIVITY_FILE = join(DATA_DIR, 'activity-log.md');
const CSV_FILE = join(__dirname, 'import-data.csv');

// ── CSV parser: handles quoted multi-line fields ──────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += ch; i++; }
    } else {
      if (ch === '"') { inQuotes = true; i++; }
      else if (ch === ',') { row.push(field); field = ''; i++; }
      else if (ch === '\r' && text[i + 1] === '\n') {
        row.push(field); field = ''; rows.push(row); row = []; i += 2;
      } else if (ch === '\n') {
        row.push(field); field = ''; rows.push(row); row = []; i++;
      } else { field += ch; i++; }
    }
  }
  if (row.length > 0 || field) { row.push(field); rows.push(row); }
  return rows;
}

// ── Date: M/D/YY or M/D/YYYY → YYYY-MM-DD ────────────────────────────────────
function parseDate(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, mo, dy, yr] = m;
  if (yr.length === 2) yr = '20' + yr;
  return `${yr}-${mo.padStart(2, '0')}-${dy.padStart(2, '0')}`;
}

// ── Event type from action text ───────────────────────────────────────────────
function inferEvent(text) {
  const t = text.toLowerCase();
  if (/\bapplied\b/.test(t)) return 'Applied';
  if (/reject|no longer under consideration|moving forward with (another|other)|not an ideal fit|no proceeding|chosen to proceed with another|no further consideration|while we.?re impressed|going w\/ other|going with other|with other candidates|another candidate|not.*close.*fit|close enough fit|didn.t consider|no moving forward/.test(t)) return 'Rejected';
  if (/recruiting paused|needs changed|recruiting closed/.test(t)) return 'Discarded';
  if (/\binterview|panel\b/.test(t)) return 'Interview';
  if (/\boffer\b/.test(t)) return 'Offer';
  if (/recruiter|still active|application received|reached out|submitted answers|contacted for|call went well|call scheduled|meeting scheduled|talk with|setting up|in process/.test(t)) return 'Responded';
  return 'Responded';
}

// ── Determine final tracker status ───────────────────────────────────────────
function determineStatus(events, isActive) {
  if (!isActive) {
    return events.some(e => e.event === 'Discarded') ? 'Discarded' : 'Rejected';
  }
  const rank = { Applied: 1, Responded: 2, Interview: 3, Offer: 4 };
  let best = 'Applied';
  let bestRank = 0;
  for (const e of events) {
    const r = rank[e.event] || 0;
    if (r > bestRank) { bestRank = r; best = e.event; }
  }
  return best;
}

// ── Fuzzy matching helpers ────────────────────────────────────────────────────
function normalizeCompany(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function companyMatches(csvName, trackerName) {
  const a = normalizeCompany(csvName);
  const b = normalizeCompany(trackerName);
  return a && b && (b.includes(a) || a.includes(b) ||
    a.split(' ').some(w => w.length > 3 && b.includes(w)));
}

function wordOverlap(a, b) {
  const stop = new Set(['the', 'and', 'for', 'with', 'into', 'from']);
  const wa = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stop.has(w)));
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stop.has(w)));
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  const total = Math.max(wa.size, wb.size);
  return total === 0 ? 0 : common / total;
}

// ── Read applications.md ──────────────────────────────────────────────────────
function readApplications() {
  if (!existsSync(APPS_FILE)) return { headerLines: [], rows: [], maxNum: 0 };
  const lines = readFileSync(APPS_FILE, 'utf-8').split('\n');
  const rows = [];
  let maxNum = 0;
  let dataStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('|')) continue;
    if (/^\|[-| ]+\|$/.test(trimmed)) { dataStart = i + 1; continue; }
    if (trimmed.startsWith('| #') || trimmed.startsWith('|#')) continue;
    if (dataStart < 0) continue;
    const cols = trimmed.split('|').map(c => c.trim()).slice(1, -1);
    if (cols.length < 4) continue;
    const num = parseInt(cols[0]);
    if (!isNaN(num)) {
      maxNum = Math.max(maxNum, num);
      rows.push({ num, line: lines[i], cols });
    }
  }
  return { headerLines: lines.slice(0, dataStart), rows, maxNum };
}

// ── Read activity-log.md ──────────────────────────────────────────────────────
function readActivityLog() {
  if (!existsSync(ACTIVITY_FILE)) return { lines: [], existingKeys: new Set(), maxNum: 0 };
  const raw = readFileSync(ACTIVITY_FILE, 'utf-8');
  const fileLines = raw.split('\n');
  const existingKeys = new Set();
  let maxNum = 0;

  for (const line of fileLines) {
    if (!line.startsWith('|') || line.startsWith('| #') || /^\|[-| ]+\|$/.test(line.trim())) continue;
    const cols = line.split('|').map(c => c.trim()).slice(1, -1);
    if (cols.length < 3) continue;
    const num = parseInt(cols[0]);
    if (!isNaN(num)) maxNum = Math.max(maxNum, num);
    const appNum = cols[1];
    const date = cols[2];
    if (appNum && date) existingKeys.add(`${appNum}|${date}`);
  }
  // return raw content ending with newline
  const content = raw.endsWith('\n') ? raw : raw + '\n';
  return { content, existingKeys, maxNum };
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  console.log('Reading CSV…');
  const csvText = readFileSync(CSV_FILE, 'utf-8');
  const csvRows = parseCSV(csvText);
  const dataRows = csvRows.slice(1).filter(r => r[0] && r[0].trim());

  const apps = readApplications();
  const log = readActivityLog();

  let nextAppNum = apps.maxNum + 1;
  let nextLogNum = log.maxNum + 1;
  const { existingKeys } = log;

  const newAppLines = [];
  const newLogLines = [];
  const stats = { matched: 0, stubbed: 0, eventsAdded: 0, eventsSkipped: 0 };

  for (const csvRow of dataRows) {
    const company  = (csvRow[0] || '').trim();
    const position = (csvRow[1] || '').trim() || '(unknown)';
    const appliedRaw = (csvRow[2] || '').trim();
    const closedRaw  = (csvRow[4] || '').trim();
    const activeStr  = (csvRow[5] || '').trim().toLowerCase();
    const actionRaw  = (csvRow[6] || '').trim();
    const link       = (csvRow[7] || '').trim();

    const isActive = activeStr === 'yes';
    const appliedDate = parseDate(appliedRaw) || parseDate(closedRaw) || '????-??-??';

    // Parse action lines → events
    const events = [];
    for (const line of actionRaw.split('\n').map(l => l.trim()).filter(Boolean)) {
      const m = line.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4}):\s*(.+)$/);
      if (!m) continue;
      const date = parseDate(m[1]);
      const text = m[2].trim();
      if (date) events.push({ date, text, event: inferEvent(text) });
    }
    // Sort events chronologically
    events.sort((a, b) => a.date.localeCompare(b.date));

    const status = determineStatus(events, isActive);

    // Fuzzy match against existing tracker rows
    let matchedApp = null;
    let bestScore = 0;

    for (const app of apps.rows) {
      if (!companyMatches(company, app.cols[2] || '')) continue;
      const overlap = wordOverlap(position, app.cols[3] || '');
      if (overlap < 0.35) continue;
      // Prefer rows that already have activity log entries
      const hasActivity = [...existingKeys].some(k => k.startsWith(`${app.num}|`));
      const score = overlap + (hasActivity ? 0.5 : 0);
      if (score > bestScore) { bestScore = score; matchedApp = app; }
    }

    let appNum;
    if (matchedApp) {
      appNum = matchedApp.num;
      stats.matched++;
      console.log(`  MATCH  #${String(appNum).padStart(3,'0')} ${company} — ${position.substring(0, 55)}`);
      // Update status in-memory
      const parts = matchedApp.line.split('|');
      if (parts.length >= 7) {
        parts[6] = ` ${status} `;
        matchedApp.line = parts.join('|');
      }
    } else {
      appNum = nextAppNum++;
      stats.stubbed++;
      console.log(`  STUB   #${String(appNum).padStart(3,'0')} ${company} — ${position.substring(0, 55)}`);
      const cleanLink = link.replace(/\|/g, ' › ');
      newAppLines.push(`| ${appNum} | ${appliedDate} | ${company} | ${position} | 0.0/5 | ${status} | ❌ | — | ${cleanLink} |`);
    }

    // Append new activity log entries (skip duplicates)
    for (const ev of events) {
      const key = `${appNum}|${ev.date}`;
      if (existingKeys.has(key)) { stats.eventsSkipped++; continue; }
      existingKeys.add(key);
      newLogLines.push(`| ${nextLogNum++} | ${appNum} | ${ev.date} | ${ev.event} | ${ev.text} |`);
      stats.eventsAdded++;
    }
  }

  // Write applications.md
  const appsContent = [...apps.headerLines, ...apps.rows.map(r => r.line), ...newAppLines].join('\n') + '\n';
  writeFileSync(APPS_FILE, appsContent, 'utf-8');

  // Write activity-log.md
  let logContent;
  if (!existsSync(ACTIVITY_FILE) || !log.content?.trim()) {
    logContent = '# Activity Log\n\n| # | App | Date | Event | Notes |\n|---|-----|------|-------|-------|\n';
  } else {
    logContent = log.content;
  }
  if (newLogLines.length > 0) logContent += newLogLines.join('\n') + '\n';
  writeFileSync(ACTIVITY_FILE, logContent, 'utf-8');

  console.log('\n─── Import Complete ───────────────────────────────');
  console.log(`  Matched to existing:  ${stats.matched}`);
  console.log(`  Stubs created:        ${stats.stubbed}`);
  console.log(`  Events added:         ${stats.eventsAdded}`);
  console.log(`  Events skipped:       ${stats.eventsSkipped}  (already in log)`);
}

main();
