// dashboard-qa.js — Validates IBKR CSV against expected dashboard values
// Usage: node dashboard-qa.js <ibkr-activity-statement.csv>

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

// === Realized P&L from Performance Summary ===
const pfAll = (S['Realized & Unrealized Performance Summary'] || {}).d || [];
const pfTotAll = pfAll.find(r => r[0] === 'Total (All Assets)');
const rPL = pfTotAll ? p(pfTotAll[7]) : 0;
const uPL = pfTotAll ? p(pfTotAll[12]) : 0;

// === Deposits ===
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
  const mo = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
  return { tk: m[1], st: parseFloat(m[5]), tp: m[6] };
}

// === TRADE COUNTING (BUG FIX: use open positions to identify closed) ===
const openSyms = new Set(options.map(o => o.sym));
const cl_FIXED = oPerf.filter(o => !openSyms.has(o.sym));
const cl_CURRENT = oPerf.filter(o => o.rTot !== 0); // Current buggy filter

// Fixed metrics
const w_f = cl_FIXED.filter(o => o.rTot > 0);
const lo_f = cl_FIXED.filter(o => o.rTot < 0);
const tw_f = w_f.reduce((a, o) => a + o.rTot, 0);
const tl_f = Math.abs(lo_f.reduce((a, o) => a + o.rTot, 0));
const pp_f = cl_FIXED.filter(o => { const x = pOpt(o.sym); return x?.tp === 'P'; });
const cp_f = cl_FIXED.filter(o => { const x = pOpt(o.sym); return x?.tp === 'C'; });
const pw_f = pp_f.filter(o => o.rTot > 0).length;
const cw_f = cp_f.filter(o => o.rTot > 0).length;
const pt_f = pp_f.reduce((a, o) => a + o.rTot, 0);
const ct_f = cp_f.reduce((a, o) => a + o.rTot, 0);

// Current (buggy) metrics
const w_c = cl_CURRENT.filter(o => o.rTot > 0);
const lo_c = cl_CURRENT.filter(o => o.rTot < 0);
const pp_c = cl_CURRENT.filter(o => { const x = pOpt(o.sym); return x?.tp === 'P'; });
const cp_c = cl_CURRENT.filter(o => { const x = pOpt(o.sym); return x?.tp === 'C'; });

// === Equity: CC credits and holding-without-CC ===
const eq = stocks.map(s => {
  const ccCr = oPerf.filter(o => { const pp = pOpt(o.sym); return pp && pp.tk === s.sym && pp.tp === 'C'; }).reduce((a, o) => a + o.rTot, 0);
  const openCC = options.filter(o => { const pp = pOpt(o.sym); return pp && pp.tk === s.sym && pp.tp === 'C'; });
  const openCCval = openCC.reduce((a, o) => a + Math.abs(o.cb), 0);
  const totCC = ccCr + openCCval;
  const hasOpenCC = openCC.length > 0;
  return { sym: s.sym, qty: s.qty, cp: s.cp, clp: s.clp, val: s.val, totCC, hasOpenCC };
});

const hnc_FIXED = eq.filter(e => !e.hasOpenCC && Math.abs(e.val) > 100);
const hnc_CURRENT = eq.filter(e => e.totCC === 0 && Math.abs(e.val) > 100);

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
  console.log('  ' + s.sym + ': qty=' + s.qty + ' cost=$' + s.cp.toFixed(2) + ' CC=$' + s.totCC.toFixed(2) + ' hasOpenCC=' + s.hasOpenCC);
}
console.log('Options: ' + options.length);

console.log('\n--- PERFORMANCE (CURRENT BUG) ---');
console.log('Trades:    ' + cl_CURRENT.length + ' (filter: rTot!==0)');
console.log('Puts:      ' + pp_c.length + ' trades');
console.log('Calls:     ' + cp_c.length + ' trades');

console.log('\n--- PERFORMANCE (FIXED) ---');
console.log('Trades:    ' + cl_FIXED.length + ' (filter: not in open positions)');
console.log('Win Rate:  ' + (cl_FIXED.length > 0 ? (w_f.length / cl_FIXED.length * 100).toFixed(1) : 0) + '%');
console.log('Puts:      ' + pp_f.length + ' trades, ' + pw_f + ' wins, P&L: $' + pt_f.toFixed(2));
console.log('  Win Rate:  ' + (pp_f.length > 0 ? (pw_f / pp_f.length * 100).toFixed(1) : 0) + '%');
console.log('Calls:     ' + cp_f.length + ' trades, ' + cw_f + ' wins, P&L: $' + ct_f.toFixed(2));
console.log('  Win Rate:  ' + (cp_f.length > 0 ? (cw_f / cp_f.length * 100).toFixed(1) : 0) + '%');
console.log('Net P&L:   $' + (tw_f - tl_f).toFixed(2));
console.log('Avg Win:   $' + (w_f.length > 0 ? tw_f / w_f.length : 0).toFixed(2));
console.log('Avg Loss:  $' + (lo_f.length > 0 ? tl_f / lo_f.length : 0).toFixed(2));
console.log('Expectancy: $' + (cl_FIXED.length > 0 ? (tw_f - tl_f) / cl_FIXED.length : 0).toFixed(2));
console.log('Profit Factor: ' + (tl_f > 0 ? (tw_f / tl_f).toFixed(1) : 'Inf'));

console.log('\n--- HOLDING WITHOUT CC ---');
console.log('Current (buggy, totCC===0): ' + hnc_CURRENT.map(e => e.sym).join(', ') || 'none');
console.log('Fixed (no open CC):         ' + hnc_FIXED.map(e => e.sym).join(', ') || 'none');

console.log('\n--- BUGS FOUND ---');
let bugs = 0;
if (cl_CURRENT.length !== cl_FIXED.length) {
  bugs++;
  console.log('BUG ' + bugs + ': Trade count ' + cl_CURRENT.length + ' (current) vs ' + cl_FIXED.length + ' (correct)');
}
if (hnc_CURRENT.length !== hnc_FIXED.length) {
  bugs++;
  console.log('BUG ' + bugs + ': Holding-without-CC missing: ' + hnc_FIXED.filter(e => !hnc_CURRENT.find(c => c.sym === e.sym)).map(e => e.sym).join(', '));
}
// Check deposits
const badDeps = deps.filter(d => d.amt === 0 && d.desc && d.desc.length > 0);
if (dd.length > 0 && deps.every(d => d.amt === 0)) {
  bugs++;
  console.log('BUG ' + bugs + ': All deposit amounts are $0 (column index shift)');
}
if (rPL !== 0) {
  const chNav = (S['Change in NAV'] || {}).d || [];
  const chRPL = chNav.find(x => x[0] === 'Realized P/L');
  if (!chRPL) {
    bugs++;
    console.log('BUG ' + bugs + ': Change in NAV has no "Realized P/L" row — dashboard shows $0');
  }
}
if (bugs === 0) console.log('No bugs detected.');
console.log('\n' + '='.repeat(60));
