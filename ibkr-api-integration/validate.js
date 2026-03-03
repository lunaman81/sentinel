#!/usr/bin/env node
/**
 * Sentinel CSV Validation Suite
 * 
 * Compares API-generated CSV against a real IBKR Activity Statement export.
 * Enforces penny-exact matching on all critical fields.
 * 
 * Usage:
 *   node validate.js <real-ibkr-csv>                    # Structure + dashboard compat
 *   node validate.js <real-ibkr-csv> <generated-csv>    # Full penny-exact comparison
 *   node validate.js --dashboard-test <csv>             # Dashboard parser compat only
 * 
 * Exit codes: 0 = passed, 1 = critical failures, 2 = warnings only
 */

const fs = require('fs');

const PENNY = 0.01;
const PRICE_MOVE = 5.00;  // Value fields: prices move between exports

// ── CSV Parser (identical logic to dashboard) ────────────────────

function parseCSV(content) {
  const S = {};
  const lines = content.replace(/^\uFEFF/, '').split('\n').filter(l => l.trim());
  for (const line of lines) {
    const f = [];
    let c = '', q = false;
    for (const ch of line) {
      if (ch === '"') { q = !q; continue; }
      if (ch === ',' && !q) { f.push(c.trim()); c = ''; continue; }
      c += ch;
    }
    f.push(c.trim());
    const s = f[0], tp = f[1];
    if (!S[s]) S[s] = { h: [], d: [], t: [] };
    if (tp === 'Header') S[s].h.push(f.slice(2));
    else if (tp === 'Data') S[s].d.push(f.slice(2));
    else if (tp === 'Total' || tp === 'SubTotal') S[s].t.push(f.slice(2));
  }
  return S;
}

const p = v => parseFloat(v) || 0;
const fmt = n => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sign = n => (n < 0 ? '-' : '') + fmt(n);

// ── Test Runner ──────────────────────────────────────────────────

class V {
  constructor() { this.results = []; this.crit = 0; this.warn = 0; this.ok = 0; }
  pass(l, d) { this.results.push({ s: '✅', l, d: d || '' }); this.ok++; }
  warning(l, d) { this.results.push({ s: '⚠️ ', l, d: d || '' }); this.warn++; }
  fail(l, d) { this.results.push({ s: '❌', l, d: d || '' }); this.crit++; }
  section(n) { this.results.push({ s: '──', l: n, d: '' }); }

  check(label, actual, expected, tol) {
    const diff = Math.abs(actual - expected);
    if (diff <= (tol || PENNY)) this.pass(label, sign(actual));
    else this.fail(label, 'expected ' + sign(expected) + ', got ' + sign(actual) + ', diff ' + sign(diff));
  }

  print(title) {
    console.log('\n' + '='.repeat(70));
    console.log(' ' + title);
    console.log('='.repeat(70));
    for (const r of this.results) {
      if (r.s === '──') console.log('\n-- ' + r.l + ' ' + '-'.repeat(Math.max(0, 55 - r.l.length)));
      else console.log('  ' + r.s + ' ' + r.l + (r.d ? '  (' + r.d + ')' : ''));
    }
    console.log('\n' + '-'.repeat(70));
    console.log(' ' + this.ok + ' passed, ' + this.warn + ' warnings, ' + this.crit + ' CRITICAL');
    if (this.crit > 0) console.log(' XX DO NOT SHIP. Fix critical failures. Paste this output into Claude.');
    else if (this.warn > 0) console.log(' ** Review warnings — likely OK but check details.');
    else console.log(' OK ALL PASSED');
    console.log('='.repeat(70) + '\n');
    return this.crit > 0 ? 1 : (this.warn > 0 ? 2 : 0);
  }
}

// ── Test: Structure ─────────────────────────────────────────────

function testStructure(S) {
  const v = new V();
  v.section('Required Sections');
  for (const s of ['Statement', 'Net Asset Value', 'Open Positions']) {
    if (S[s]) v.pass(s);
    else v.fail(s + ' — MISSING');
  }
  v.section('Optional Sections');
  for (const s of ['Change in NAV', 'Trades', 'Deposits & Withdrawals']) {
    if (S[s]) v.pass(s);
    else v.warning(s + ' — not present');
  }
  if (S['Open Positions']) {
    v.section('Position Counts');
    const d = S['Open Positions'].d;
    const stocks = d.filter(r => r[0] === 'Summary' && r[1] === 'Stocks');
    const opts = d.filter(r => r[0] === 'Summary' && r[1] === 'Equity and Index Options');
    v.pass(stocks.length + ' stock positions');
    v.pass(opts.length + ' option positions');
    const sample = stocks[0] || opts[0];
    if (sample) {
      if (sample.length >= 11) v.pass('Field count: ' + sample.length + ' (need >= 11)');
      else v.fail('Field count: ' + sample.length + ' (need >= 11)');
    }
  }
  return v.print('STRUCTURE CHECK');
}

// ── Test: Dashboard Parser Compatibility ────────────────────────

function testDashboardCompat(S) {
  const v = new V();

  v.section('Dashboard Accept/Reject');
  if (!S['Open Positions'] && !S['Net Asset Value']) {
    v.fail('Dashboard would REJECT — missing Open Positions and Net Asset Value');
    return v.print('DASHBOARD COMPATIBILITY');
  }
  v.pass('File would be accepted by dashboard');

  // NAV extraction (replicates dashboard lines 93-97 exactly)
  v.section('NAV Extraction (dashboard column index test)');
  const nr = (S['Net Asset Value'] || {}).d || [];
  const nt = nr.find(r => r[0] === 'Total');
  const cr = nr.find(r => (r[0] || '').trim() === 'Cash');

  if (nt) {
    const nav = p(nt[4]);
    const pNav = p(nt[1]);
    if (nav > 0) v.pass('NAV [index 4]: ' + sign(nav));
    else v.fail('NAV [index 4] is ' + sign(nav) + ' — wrong column?');
    v.pass('Prior NAV [index 1]: ' + sign(pNav));
  } else {
    v.fail('No "Total" row — dashboard shows $0');
  }

  if (cr) {
    const cash = p(cr[4]);
    if (cash > 0) v.pass('Cash [index 4]: ' + sign(cash));
    else v.warning('Cash [index 4] is ' + sign(cash));
  } else {
    v.warning('No "Cash" row — dashboard shows $0');
  }

  const tr = nr.find(r => /^\d/.test(r[0]));
  if (tr) v.pass('TWR: ' + p(tr[0]) + '%');
  else v.warning('No TWR row — dashboard shows 0%');

  // Change in NAV
  v.section('Change in NAV Extraction');
  const ch = (S['Change in NAV'] || {}).d || [];
  const rpl = ch.find(x => x[0] === 'Realized P/L');
  const uch = ch.find(x => x[0] === 'Change in Unrealized P/L');
  if (rpl) v.pass('Realized P/L: ' + sign(p(rpl[1])));
  else v.warning('No Realized P/L row');
  if (uch) v.pass('Unrealized Change: ' + sign(p(uch[1])));
  else v.warning('No Unrealized Change row');

  // Positions
  v.section('Position Extraction');
  const pd = (S['Open Positions'] || {}).d || [];
  const stocks = pd.filter(r => r[0] === 'Summary' && r[1] === 'Stocks');
  const opts = pd.filter(r => r[0] === 'Summary' && r[1] === 'Equity and Index Options');
  v.pass('Stocks: ' + stocks.length);
  v.pass('Options: ' + opts.length);

  // Verify option symbol format (dashboard pOpt regex)
  if (opts.length > 0) {
    v.section('Option Symbol Format (must match dashboard parser)');
    let formatOk = 0, formatBad = 0;
    for (const o of opts) {
      const sym = o[3] || '';
      if (/^\w+\s+\d{2}[A-Z]{3}\d{2}\s+[\d.]+\s+[PC]$/.test(sym)) {
        formatOk++;
      } else {
        v.fail('Bad format: "' + sym + '" — expected "TICKER DDMMMYY STRIKE P/C"');
        formatBad++;
      }
    }
    if (formatOk > 0) v.pass(formatOk + '/' + opts.length + ' options have valid symbol format');
  }

  return v.print('DASHBOARD COMPATIBILITY');
}

// ── Test: Penny-Exact Comparison ────────────────────────────────

function testComparison(real, gen) {
  const v = new V();

  // NAV
  v.section('NAV Values (within $5 — prices move)');
  const rNav = (real['Net Asset Value'] || {}).d || [];
  const gNav = (gen['Net Asset Value'] || {}).d || [];
  for (const label of ['Cash', 'Stock', 'Options', 'Total']) {
    const rr = rNav.find(r => (r[0] || '').trim() === label);
    const gr = gNav.find(r => (r[0] || '').trim() === label);
    if (!rr) { v.warning(label + ': not in real CSV'); continue; }
    if (!gr) { v.fail(label + ': MISSING from generated CSV'); continue; }
    v.check(label, p(gr[4]), p(rr[4]), PRICE_MOVE);
  }

  // Stock positions
  v.section('Stock Positions — Penny-Exact on Cost Fields');
  compareCat(v, real, gen, 'Stocks');

  // Option positions
  v.section('Option Positions — Penny-Exact on Cost Fields');
  compareCat(v, real, gen, 'Equity and Index Options');

  return v.print('PENNY-EXACT COMPARISON (Generated vs Real)');
}

function compareCat(v, real, gen, cat) {
  const rPos = (real['Open Positions'] || {}).d.filter(r => r[0] === 'Summary' && r[1] === cat);
  const gPos = (gen['Open Positions'] || {}).d.filter(r => r[0] === 'Summary' && r[1] === cat);

  const rMap = {}, gMap = {};
  for (const r of rPos) rMap[r[3]] = r;
  for (const g of gPos) gMap[g[3]] = g;

  const missing = Object.keys(rMap).filter(s => !gMap[s]);
  const extra = Object.keys(gMap).filter(s => !rMap[s]);
  if (missing.length) v.fail('Missing: ' + missing.join(', '));
  if (extra.length) v.warning('Extra: ' + extra.join(', '));

  const matched = Object.keys(rMap).filter(s => gMap[s]);
  let perfect = 0;

  for (const sym of matched) {
    const r = rMap[sym], g = gMap[sym];
    let ok = true;

    // Quantity — exact
    if (p(r[4]) !== p(g[4])) {
      v.fail(sym + ' Qty: expected ' + r[4] + ', got ' + g[4]);
      ok = false;
    }

    // Cost Price — penny-exact (static, doesn't change with market)
    if (Math.abs(p(r[6]) - p(g[6])) > PENNY) {
      v.fail(sym + ' Cost Price: expected ' + r[6] + ', got ' + g[6]);
      ok = false;
    }

    // Cost Basis — penny-exact
    if (Math.abs(p(r[7]) - p(g[7])) > PENNY) {
      v.fail(sym + ' Cost Basis: expected ' + r[7] + ', got ' + g[7]);
      ok = false;
    }

    // Value — allow price movement
    const valDiff = Math.abs(p(r[9]) - p(g[9]));
    if (valDiff > PRICE_MOVE) {
      v.warning(sym + ' Value differs by ' + sign(valDiff) + ' (price movement)');
    }

    if (ok) perfect++;
  }

  if (matched.length > 0) {
    if (perfect === matched.length) {
      v.pass('All ' + matched.length + ' positions penny-exact on cost fields');
    } else {
      v.pass(perfect + '/' + matched.length + ' positions penny-exact');
    }
  }
}

// ── CLI ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log([
    '',
    'Sentinel CSV Validation Suite',
    '-'.repeat(50),
    '',
    '  node validate.js <real-csv>              Structure + dashboard compat',
    '  node validate.js <real-csv> <gen-csv>    Full penny-exact comparison',
    '  node validate.js --dashboard-test <csv>  Dashboard parser test only',
    '',
    'Examples:',
    '  node validate.js ~/Downloads/U12781141_YTD.csv',
    '  node validate.js ~/Downloads/U12781141_YTD.csv ./output/U12781141_LIVE_20260302.csv',
    '  node validate.js --dashboard-test ./output/U12781141_LIVE_20260302.csv',
    '',
  ].join('\n'));
  process.exit(0);
}

let exitCode = 0;

if (args[0] === '--dashboard-test') {
  const S = parseCSV(fs.readFileSync(args[1], 'utf-8'));
  exitCode = testDashboardCompat(S);
} else if (args.length === 1) {
  const S = parseCSV(fs.readFileSync(args[0], 'utf-8'));
  exitCode = Math.max(testStructure(S), testDashboardCompat(S));
} else {
  const real = parseCSV(fs.readFileSync(args[0], 'utf-8'));
  const gen = parseCSV(fs.readFileSync(args[1], 'utf-8'));
  const e1 = testStructure(gen);
  const e2 = testDashboardCompat(gen);
  const e3 = testComparison(real, gen);
  exitCode = Math.max(e1, e2, e3);
}

process.exit(exitCode);
