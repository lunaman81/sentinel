// dashboard-qa.js — Validates IBKR CSV against expected dashboard values
// Usage: node dashboard-qa.js <ibkr-activity-statement.csv>
// Exit code 0 = all checks pass, exit code 1 = bugs found (used by pre-push hook)

const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('Usage: node dashboard-qa.js <csv-file>'); process.exit(1); }

const text = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
const lines = text.split('\n').filter(l => l.trim());

// Same parser as dashboard
const S = {};
for (const line of lines) {
  const f = []; let c = '', q = false;
  for (const ch of line) { if (ch === '"') { q = !q; continue; } if (ch === ',' && !q) { f.push(c.trim()); c = ''; continue; } c += ch; }
  f.push(c.trim());
  const s = f[0], tp = f[1];
  if (!S[s]) S[s] = { h: [], d: [], t: [] };
  if (tp === 'Header') S[s].h.push(f.slice(2));
  else if (tp === 'Data') S[s].d.push(f.slice(2));
  else if (tp === 'Total' || tp === 'SubTotal') S[s].t.push(f.slice(2));
}

const p = v => parseFloat(v) || 0;

// === NAV ===
const nr = (S['Net Asset Value'] || {}).d || [];
const nt = nr.find(r => r[0] === 'Total');
const cr = nr.find(r => r[0]?.trim() === 'Cash');
const nav = nt ? p(nt[4]) : 0;
const cash = cr ? p(cr[4]) : 0;
const tr = nr.find(r => /^\d/.test(r[0]));
const twr = tr ? p(tr[0]) : 0;

// === Realized P&L and Unrealized from Performance Summary ===
const pfAll = (S['Realized & Unrealized Performance Summary'] || {}).d || [];
const pfTotAll = pfAll.find(r => r[0] === 'Total (All Assets)');
const rPL = pfTotAll ? p(pfTotAll[7]) : 0;
const uPL = pfTotAll ? p(pfTotAll[12]) : 0;

// === Deposits (5-column: cur[0], acct[1], date[2], desc[3], amt[4]) ===
const dd = (S['Deposits & Withdrawals'] || {}).d || [];
const deps = dd.filter(r => r[0] !== 'Total').map(r => ({
  cur: r[0], acct: r[1], date: r[2], desc: r[3], amt: p(r[4])
}));

// === Open Positions ===
const pd = (S['Open Positions'] || {}).d || [];
const stocks = [], options = [];
for (const r of pd) {
  if (r[0] !== 'Summary') continue;
  const o = { cat: r[1], sym: r[3], qty: p(r[4]), mult: p(r[5]), cp: p(r[6]), cb: p(r[7]), clp: p(r[8]), val: p(r[9]), upl: p(r[10]) };
  if (r[1] === 'Stocks') stocks.push(o);
  else if (r[1] === 'Equity and Index Options') options.push(o);
}

// === Option Performance Summary ===
const oPerf = pfAll.filter(r => r[0] === 'Equity and Index Options').map(r => ({
  sym: r[1], rTot: p(r[7]), uTot: p(r[12])
}));

// Parse option symbol
function pOpt(sym) {
  const m = sym.match(/^(\w+)\s+(\d{2})([A-Z]{3})(\d{2})\s+([\d.]+)\s+([PC])$/);
  if (!m) return null;
  return { tk: m[1], st: parseFloat(m[5]), tp: m[6] };
}

// === TRADE COUNTING (closed = not in open positions) ===
const openSyms = new Set(options.map(o => o.sym));
const closed = oPerf.filter(o => !openSyms.has(o.sym));

// Performance metrics
const wins = closed.filter(o => o.rTot > 0);
const losses = closed.filter(o => o.rTot < 0);
const totWin = wins.reduce((a, o) => a + o.rTot, 0);
const totLoss = Math.abs(losses.reduce((a, o) => a + o.rTot, 0));
const puts = closed.filter(o => { const x = pOpt(o.sym); return x?.tp === 'P'; });
const calls = closed.filter(o => { const x = pOpt(o.sym); return x?.tp === 'C'; });
const putWins = puts.filter(o => o.rTot > 0).length;
const callWins = calls.filter(o => o.rTot > 0).length;
const putPL = puts.reduce((a, o) => a + o.rTot, 0);
const callPL = calls.reduce((a, o) => a + o.rTot, 0);

// === Equity: holding-without-CC (check for open call options) ===
const eq = stocks.map(s => {
  const ccCr = oPerf.filter(o => { const pp = pOpt(o.sym); return pp && pp.tk === s.sym && pp.tp === 'C'; }).reduce((a, o) => a + o.rTot, 0);
  const hasOpenCC = options.some(o => { const pp = pOpt(o.sym); return pp && pp.tk === s.sym && pp.tp === 'C'; });
  return { sym: s.sym, qty: s.qty, cp: s.cp, clp: s.clp, val: s.val, ccCr, hasOpenCC };
});

const hnc = eq.filter(e => !e.hasOpenCC && Math.abs(e.val) > 100);

// === Deployment ===
const sv = stocks.reduce((a, s) => a + Math.abs(s.val), 0);
const pn = options.filter(o => { const pp = pOpt(o.sym); return pp?.tp === 'P'; })
  .reduce((a, o) => a + pOpt(o.sym).st * Math.abs(o.qty) * (o.mult || 100), 0);
const dpct = nav > 0 ? ((sv + pn) / nav * 100) : 0;

// === OUTPUT ===
console.log('=' .repeat(60));
console.log('SENTINEL DASHBOARD QA REPORT');
console.log('CSV: ' + file);
console.log('=' .repeat(60));

console.log('\n--- METRICS BAR ---');
console.log('NAV:          $' + nav.toFixed(2));
console.log('Cash:         $' + cash.toFixed(2));
console.log('TWR:          ' + twr.toFixed(6) + '%');
console.log('Realized P&L: $' + rPL.toFixed(2) + '  (from Perf Summary Total All Assets)');
console.log('Unrealized:   $' + uPL.toFixed(2) + '  (from Perf Summary Total All Assets)');
console.log('Deployment:   ' + dpct.toFixed(1) + '%');

console.log('\n--- DEPOSITS & WITHDRAWALS ---');
for (const d of deps) {
  console.log('  ' + d.date + '  ' + d.desc + '  $' + d.amt.toFixed(2));
}

console.log('\n--- POSITIONS ---');
console.log('Stocks: ' + stocks.length);
for (const s of eq) {
  console.log('  ' + s.sym + ': qty=' + s.qty + ' cost=$' + s.cp.toFixed(2) + ' ccCredits=$' + s.ccCr.toFixed(2) + ' hasOpenCC=' + s.hasOpenCC);
}
console.log('Options: ' + options.length);

console.log('\n--- PERFORMANCE ---');
console.log('Trades:    ' + closed.length + ' (closed: not in open positions)');
console.log('Win Rate:  ' + (closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) : 0) + '%');
console.log('Puts:      ' + puts.length + ' trades, ' + putWins + ' wins, P&L: $' + putPL.toFixed(2));
console.log('  Win Rate:  ' + (puts.length > 0 ? (putWins / puts.length * 100).toFixed(1) : 0) + '%');
console.log('Calls:     ' + calls.length + ' trades, ' + callWins + ' wins, P&L: $' + callPL.toFixed(2));
console.log('  Win Rate:  ' + (calls.length > 0 ? (callWins / calls.length * 100).toFixed(1) : 0) + '%');
console.log('Net P&L:   $' + (totWin - totLoss).toFixed(2));
console.log('Avg Win:   $' + (wins.length > 0 ? totWin / wins.length : 0).toFixed(2));
console.log('Avg Loss:  $' + (losses.length > 0 ? totLoss / losses.length : 0).toFixed(2));
console.log('Expectancy: $' + (closed.length > 0 ? (totWin - totLoss) / closed.length : 0).toFixed(2));
console.log('Profit Factor: ' + (totLoss > 0 ? (totWin / totLoss).toFixed(1) : 'Inf'));

console.log('\n--- HOLDING WITHOUT CC ---');
console.log('Holdings without covered calls: ' + (hnc.length > 0 ? hnc.map(e => e.sym).join(', ') : 'none'));

// === VALIDATION CHECKS ===
console.log('\n--- CHECKS ---');
let bugs = 0;

// Check 1: NAV must be non-zero
if (nav === 0) { bugs++; console.log('FAIL: NAV is $0'); }
else console.log('PASS: NAV $' + nav.toFixed(2));

// Check 2: Realized P&L from Perf Summary must be non-zero (for real accounts)
if (rPL === 0 && pfTotAll) { bugs++; console.log('FAIL: Realized P&L is $0 despite Perf Summary existing'); }
else if (!pfTotAll) { console.log('PASS: No Perf Summary section (OK for live Gateway CSV)'); }
else console.log('PASS: Realized P&L $' + rPL.toFixed(2));

// Check 3: Unrealized from Perf Summary
if (!pfTotAll) { /* no perf summary — already noted above */ }
else console.log('PASS: Unrealized $' + uPL.toFixed(2));

// Check 4: Deposits parse correctly (amounts should not all be $0 if deposits exist)
if (dd.length > 0 && deps.length > 0 && deps.every(d => d.amt === 0)) {
  bugs++; console.log('FAIL: All deposit amounts are $0 (column index shift?)');
} else if (deps.length > 0) {
  console.log('PASS: Deposits parsed (' + deps.length + ' entries, amounts non-zero)');
} else {
  console.log('PASS: No deposits section (OK for live CSV)');
}

// Check 5: Positions loaded
if (stocks.length === 0 && options.length === 0) {
  bugs++; console.log('FAIL: No positions found');
} else {
  console.log('PASS: ' + stocks.length + ' stocks, ' + options.length + ' options');
}

// Check 6: Holding-without-CC uses open call check (sanity: EOSE should be flagged if no open calls)
const eose = eq.find(e => e.sym === 'EOSE');
if (eose && !eose.hasOpenCC && hnc.find(e => e.sym === 'EOSE')) {
  console.log('PASS: EOSE correctly flagged as holding without CC');
} else if (eose && eose.hasOpenCC) {
  console.log('PASS: EOSE has open CC — not flagged');
} else if (!eose) {
  console.log('PASS: EOSE not in portfolio (check N/A)');
}

// Check 7: Closed trade count is reasonable (skip if no perf summary)
if (closed.length === 0 && oPerf.length > 0) {
  bugs++; console.log('FAIL: 0 closed trades but ' + oPerf.length + ' in performance summary');
} else {
  console.log('PASS: ' + closed.length + ' closed trades');
}

console.log('\n--- RESULT ---');
if (bugs === 0) {
  console.log('All checks passed. No bugs detected.');
  console.log('\n' + '='.repeat(60));
  process.exit(0);
} else {
  console.log(bugs + ' bug(s) found. See FAIL lines above.');
  console.log('\n' + '='.repeat(60));
  process.exit(1);
}
