import { readFile } from "node:fs/promises"
import { renderDashboard } from "./windows-dashboard-renderer.js"
import type { DashboardSnapshot } from "./windows-dashboard-snapshot.js"

const POLL_INTERVAL_MS = 500

export function buildDashboardProcessCommand(snapshotPath: string): string {
  const scriptPath = new URL("./windows-dashboard-process-entry.js", import.meta.url).pathname.replace(/^\//, "")
  return `node "${scriptPath}" "${snapshotPath}"`
}

export function buildDashboardProcessInlineCommand(snapshotPath: string): string {
  // Inline Node.js script that polls the snapshot file and renders the dashboard.
  // This avoids needing a separate entry point file in the built output.
  const script = `
const fs = require('fs');
const POLL = 500;
const SPINNERS = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const A = { reset:'\\x1b[0m', bold:'\\x1b[1m', dim:'\\x1b[2m', cyan:'\\x1b[36m', green:'\\x1b[32m', red:'\\x1b[31m', yellow:'\\x1b[33m', blue:'\\x1b[34m', white:'\\x1b[37m', gray:'\\x1b[90m', brightWhite:'\\x1b[97m' };
let lastVersion = -1;
let frame = 0;
let lastSnapshot = null;

function statusMarker(s, f) {
  if (s === 'running') return A.cyan + SPINNERS[f % SPINNERS.length] + A.reset;
  if (s === 'completed') return A.green + '✓' + A.reset;
  if (s === 'failed') return A.red + '✗' + A.reset;
  return A.yellow + '■' + A.reset;
}
function statusColor(s) {
  if (s === 'running') return A.white;
  if (s === 'completed') return A.green;
  if (s === 'failed') return A.red;
  return A.yellow;
}
function sep() { return A.gray + '─'.repeat(40) + A.reset; }

function render(snap, f) {
  const lines = ['', '  ' + A.bold + A.cyan + snap.title + A.reset, '  ' + A.gray + 'Session: ' + A.white + snap.sessionId + A.reset, '', sep()];
  if (!snap.jobs || snap.jobs.length === 0) {
    lines.push('', '  ' + A.dim + 'No delegated jobs yet. Waiting for work...' + A.reset, '');
  } else {
    lines.push('', '  ' + A.bold + 'Delegated Jobs' + A.reset, '');
    for (const j of snap.jobs) {
      const lbl = j.label ? ' ' + A.gray + '(' + j.label + ')' + A.reset : '';
      lines.push('  ' + statusMarker(j.status, f) + ' ' + statusColor(j.status) + j.id + A.reset + ' ' + A.dim + '[' + j.backend + ']' + A.reset + ' -> ' + A.bold + A.brightWhite + '[window ' + j.windowIndex + ']' + A.reset + lbl);
    }
    lines.push('');
  }
  lines.push(sep(), '');
  if (snap.navigation) for (const h of snap.navigation) lines.push('  ' + A.gray + h + A.reset);
  lines.push('');
  process.stdout.write('\\x1b[2J\\x1b[H' + lines.join('\\n'));
}

function tick() {
  frame++;
  try {
    const raw = fs.readFileSync(process.argv[2] || '', 'utf8');
    const snap = JSON.parse(raw);
    lastSnapshot = snap;
    const hasRunning = snap.jobs && snap.jobs.some(j => j.status === 'running');
    if (snap.version !== lastVersion || hasRunning) {
      render(snap, frame);
      lastVersion = snap.version;
    }
  } catch {
    if (lastSnapshot) { render(lastSnapshot, frame); }
    else { process.stdout.write('\\x1b[2J\\x1b[H\\n  ' + A.dim + 'Waiting for dashboard data...' + A.reset + '\\n'); }
  }
}

tick();
setInterval(tick, POLL);
`.trim().replace(/\n/g, " ")

  return `node -e "${script.replace(/"/g, '\\"')}" "${snapshotPath}"`
}

export async function runDashboardProcessLoop(snapshotPath: string): Promise<never> {
  let lastVersion = -1
  let frame = 0
  let lastSnapshot: DashboardSnapshot | undefined

  async function tick(): Promise<void> {
    frame++
    try {
      const raw = await readFile(snapshotPath, "utf8")
      const snapshot: DashboardSnapshot = JSON.parse(raw)
      lastSnapshot = snapshot
      const hasRunning = snapshot.jobs.some((job) => job.status === "running")
      if (snapshot.version !== lastVersion || hasRunning) {
        process.stdout.write(`\x1b[2J\x1b[H${renderDashboard(snapshot, frame)}`)
        lastVersion = snapshot.version
      }
    } catch {
      if (lastSnapshot) {
        process.stdout.write(`\x1b[2J\x1b[H${renderDashboard(lastSnapshot, frame)}`)
      } else {
        process.stdout.write("\x1b[2J\x1b[H\n  \x1b[2mWaiting for dashboard data...\x1b[0m\n")
      }
    }
  }

  await tick()
  return new Promise(() => {
    setInterval(tick, POLL_INTERVAL_MS)
  })
}
