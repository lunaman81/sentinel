#!/usr/bin/env node
/**
 * flex-to-activity.js — Convert IBKR Flex Query CSV to Activity Statement format
 *
 * Reads flex-raw-latest.csv and writes latest.csv in the exact format
 * the Sentinel dashboard parseCSV() expects.
 *
 * Usage: node flex-to-activity.js [input] [output]
 *   Default input:  ./flex-raw-latest.csv
 *   Default output: ../latest.csv
 */

const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2] || path.join(__dirname, 'flex-raw-latest.csv');
const outputPath = process.argv[3] || path.join(__dirname, '..', 'latest.csv');

if (!fs.existsSync(inputPath)) {
  console.error(`❌ Input not found: ${inputPath}`);
  process.exit(1);
}

// ── Parse Flex CSV ─────────────────────────────────────────
const raw = fs.readFileSync(inputPath, 'utf-8').replace(/^\uFEFF/, '');
const lines = raw.split('\n').filter(l => l.trim());

function parseLine(line) {
  const f = []; let c = '', q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { f.push(c.trim()); c = ''; continue; }
    c += ch;
  }
  f.push(c.trim());
  return f;
}

// Identify sections by their header signatures
const sections = [];
let currentHeader = null;
let currentRows = [];

for (const line of lines) {
  const f = parseLine(line);
  if (f[0] === 'ClientAccountID') {
    // New section header
    if (currentHeader) sections.push({ header: currentHeader, rows: currentRows });
    currentHeader = f;
    currentRows = [];
  } else {
    currentRows.push(f);
  }
}
if (currentHeader) sections.push({ header: currentHeader, rows: currentRows });

// Identify each section by unique column names
function findSection(colName) {
  return sections.find(s => s.header.includes(colName));
}

const acctInfo = sections[0]; // Account info
const navDaily = findSection('ReportDate') && sections.find(s => s.header.includes('Cash') && s.header.includes('Stock') && s.header.includes('Total'));
const changeNav = findSection('StartingValue');
const perfSummary = sections.find(s => s.header.includes('TotalRealizedPnl') && s.header.includes('AssetClass'));
const openPositions = findSection('PositionValue');
const trades = findSection('TradePrice');
const cashTx = sections.find(s => s.header.includes('Amount') && s.header.includes('Type') && s.header.includes('Date/Time'));

// Helper to get column index
function colIdx(section, name) {
  return section.header.indexOf(name);
}

const p = v => parseFloat(v) || 0;

// ── Extract data ───────────────────────────────────────────

// Account info
const acctName = acctInfo.rows[0]?.[colIdx(acctInfo, 'Name')] || 'Unknown';
const accountId = acctInfo.rows[0]?.[colIdx(acctInfo, 'ClientAccountID')] || 'U12781141';

// NAV: last row is most recent date
const navLastRow = navDaily.rows[navDaily.rows.length - 1];
const navFirstRow = navDaily.rows[0];
const iCash = colIdx(navDaily, 'Cash');
const iStock = colIdx(navDaily, 'Stock');
const iOptions = colIdx(navDaily, 'Options');
const iInterest = colIdx(navDaily, 'InterestAccruals');
const iDivAccruals = colIdx(navDaily, 'DividendAccruals');
const iTotal = colIdx(navDaily, 'Total');
const iTotalLong = colIdx(navDaily, 'TotalLong');
const iTotalShort = colIdx(navDaily, 'TotalShort');
const iSLBCollateral = colIdx(navDaily, 'SLBCashCollateral');
const iSLBLent = colIdx(navDaily, 'SLBDirectSecuritiesLent');
const iReportDate = colIdx(navDaily, 'ReportDate');

const curCash = p(navLastRow[iCash]);
const curStock = p(navLastRow[iStock]);
const curOptions = p(navLastRow[iOptions]);
const curInterest = p(navLastRow[iInterest]);
const curDivAccruals = p(navLastRow[iDivAccruals]);
const curTotal = p(navLastRow[iTotal]);
const curTotalLong = p(navLastRow[iTotalLong]);
const curTotalShort = p(navLastRow[iTotalShort]);
const curCollateral = p(navLastRow[iSLBCollateral]);
const curSecLent = p(navLastRow[iSLBLent]);

const priorCash = p(navFirstRow[iCash]);
const priorStock = p(navFirstRow[iStock]);
const priorOptions = p(navFirstRow[iOptions]);
const priorInterest = p(navFirstRow[iInterest]);
const priorTotal = p(navFirstRow[iTotal]);

const lastDate = navLastRow[iReportDate]; // e.g., "20260302"
const firstDate = navFirstRow[iReportDate];

// Format dates
function fmtDateLong(d) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const y = d.substring(0, 4), m = parseInt(d.substring(4, 6)) - 1, day = parseInt(d.substring(6, 8));
  return `${months[m]} ${day}, ${y}`;
}
function fmtDate(d) {
  return `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
}

// Change in NAV
const chgRow = changeNav.rows[0];
const iStarting = colIdx(changeNav, 'StartingValue');
const iMtm = colIdx(changeNav, 'Mtm');
const iDeposits = colIdx(changeNav, 'DepositsWithdrawals');
const iAssetTransfers = colIdx(changeNav, 'AssetTransfers');
const iDividends = colIdx(changeNav, 'Dividends');
const iChgDivAccruals = colIdx(changeNav, 'ChangeInDividendAccruals');
const iInterestNav = colIdx(changeNav, 'Interest');
const iChgIntAccruals = colIdx(changeNav, 'ChangeInInterestAccruals');
const iCommissions = colIdx(changeNav, 'Commissions');
const iEnding = colIdx(changeNav, 'EndingValue');
const iTwr = colIdx(changeNav, 'TWR');

const startingVal = p(chgRow[iStarting]);
const mtm = p(chgRow[iMtm]);
const deposits = p(chgRow[iDeposits]);
const assetTransfers = p(chgRow[iAssetTransfers]);
const chgDivAccruals = p(chgRow[iChgDivAccruals]);
const interest = p(chgRow[iInterestNav]);
const chgIntAccruals = p(chgRow[iChgIntAccruals]);
const commissions = p(chgRow[iCommissions]);
const endingVal = p(chgRow[iEnding]);
const twr = p(chgRow[iTwr]);

// Performance Summary
const iPerfAsset = colIdx(perfSummary, 'AssetClass');
const iPerfSym = colIdx(perfSummary, 'Symbol');
const iPerfDesc = colIdx(perfSummary, 'Description');
const iPerfRealST = colIdx(perfSummary, 'RealizedShortTermProfit');
const iPerfRealSTL = colIdx(perfSummary, 'RealizedShortTermLoss');
const iPerfRealLT = colIdx(perfSummary, 'RealizedLongTermProfit');
const iPerfRealLTL = colIdx(perfSummary, 'RealizedLongTermLoss');
const iPerfRealTot = colIdx(perfSummary, 'TotalRealizedPnl');
const iPerfUnrealProfit = colIdx(perfSummary, 'UnrealizedProfit');
const iPerfUnrealLoss = colIdx(perfSummary, 'UnrealizedLoss');
const iPerfUnrealSTProfit = colIdx(perfSummary, 'UnrealizedSTProfit');
const iPerfUnrealSTLoss = colIdx(perfSummary, 'UnrealizedSTLoss');
const iPerfUnrealTot = colIdx(perfSummary, 'TotalUnrealizedPnl');
const iPerfTotalFifo = colIdx(perfSummary, 'TotalFifoPnl');

// Build performance rows
const perfRows = [];
let stkRealTot = 0, stkUnrealTot = 0, stkFifoTot = 0;
let optRealTot = 0, optUnrealTot = 0, optFifoTot = 0;
let allRealSTProfit = 0, allRealSTLoss = 0, allRealTot = 0;
let allUnrealProfit = 0, allUnrealLoss = 0, allUnrealTot = 0, allFifoTot = 0;

for (const r of perfSummary.rows) {
  const asset = r[iPerfAsset];
  const sym = r[iPerfSym] || r[iPerfDesc] || '';
  if (!asset) continue;

  const cat = asset === 'STK' ? 'Stocks' : asset === 'OPT' ? 'Equity and Index Options' : asset;
  const displaySym = asset === 'OPT' ? (r[iPerfDesc] || sym).trim() : sym;
  const costAdj = 0;
  const realST = p(r[iPerfRealST]);
  const realSTL = p(r[iPerfRealSTL]);
  const realLT = p(r[iPerfRealLT]);
  const realLTL = p(r[iPerfRealLTL]);
  const realTot = p(r[iPerfRealTot]);
  const unrealSTP = p(r[iPerfUnrealSTProfit]);
  const unrealSTL = p(r[iPerfUnrealSTLoss]);
  const unrealTot = p(r[iPerfUnrealTot]);
  const fifoTot = p(r[iPerfTotalFifo]);

  perfRows.push({ cat, sym: displaySym, costAdj, realST, realSTL, realLT, realLTL, realTot, unrealSTP, unrealSTL, unrealLTP: 0, unrealLTL: 0, unrealTot, fifoTot, code: '' });

  if (asset === 'STK') { stkRealTot += realTot; stkUnrealTot += unrealTot; stkFifoTot += fifoTot; }
  if (asset === 'OPT') { optRealTot += realTot; optUnrealTot += unrealTot; optFifoTot += fifoTot; }
  allRealSTProfit += realST; allRealSTLoss += realSTL;
  allRealTot += realTot; allUnrealProfit += unrealSTP; allUnrealLoss += unrealSTL;
  allUnrealTot += unrealTot; allFifoTot += fifoTot;
}

// Open Positions
const iPosAsset = colIdx(openPositions, 'AssetClass');
const iPosSym = colIdx(openPositions, 'Symbol');
const iPosDesc = colIdx(openPositions, 'Description');
const iPosQty = colIdx(openPositions, 'Quantity');
const iPosMult = colIdx(openPositions, 'Multiplier');
const iPosCP = colIdx(openPositions, 'CostBasisPrice');
const iPosCB = colIdx(openPositions, 'CostBasisMoney');
const iPosCloseP = colIdx(openPositions, 'MarkPrice');
const iPosVal = colIdx(openPositions, 'PositionValue');
const iPosUPL = colIdx(openPositions, 'FifoPnlUnrealized');
const iPosLevel = colIdx(openPositions, 'LevelOfDetail');

const posRows = [];
for (const r of openPositions.rows) {
  const level = r[iPosLevel];
  if (level !== 'SUMMARY') continue;
  const asset = r[iPosAsset];
  const cat = asset === 'STK' ? 'Stocks' : asset === 'OPT' ? 'Equity and Index Options' : asset;
  const sym = asset === 'OPT' ? (r[iPosDesc] || r[iPosSym]).trim() : r[iPosSym];
  const qty = p(r[iPosQty]);
  const mult = p(r[iPosMult]) || 1;
  const cp = p(r[iPosCP]);
  const cb = p(r[iPosCB]);
  const closeP = p(r[iPosCloseP]);
  const val = p(r[iPosVal]);
  const upl = p(r[iPosUPL]);
  posRows.push({ cat, sym, qty, mult, cp, cb, closeP, val, upl });
}

// Trades
const iTradeAsset = colIdx(trades, 'AssetClass');
const iTradeSym = colIdx(trades, 'Symbol');
const iTradeDesc = colIdx(trades, 'Description');
const iTradeDateTime = colIdx(trades, 'DateTime');
const iTradeQty = colIdx(trades, 'Quantity');
const iTradePrice = colIdx(trades, 'TradePrice');
const iTradeCloseP = colIdx(trades, 'ClosePrice');
const iTradeProceeds = colIdx(trades, 'Proceeds');
const iTradeComm = colIdx(trades, 'IBCommission');
const iTradeBasis = colIdx(trades, 'CostBasis');
const iTradeRealPnl = colIdx(trades, 'FifoPnlRealized');
const iTradeMtm = colIdx(trades, 'MtmPnl');
const iTradeNotes = colIdx(trades, 'Notes/Codes');
const iTradeLevel = colIdx(trades, 'LevelOfDetail');
const iTradeBuySell = colIdx(trades, 'Buy/Sell');

const tradeRows = [];
for (const r of trades.rows) {
  const level = r[iTradeLevel];
  if (level !== 'EXECUTION') continue;
  const asset = r[iTradeAsset];
  const cat = asset === 'STK' ? 'Stocks' : asset === 'OPT' ? 'Equity and Index Options' : asset;
  const sym = asset === 'OPT' ? (r[iTradeDesc] || r[iTradeSym]).trim() : r[iTradeSym];
  const dt = r[iTradeDateTime] || '';
  // Convert "20260109;162000" to "2026-01-09, 16:20:00"
  const fmtDt = dt.replace(/(\d{4})(\d{2})(\d{2});(\d{2})(\d{2})(\d{2})/, '$1-$2-$3, $4:$5:$6');
  const qty = p(r[iTradeQty]);
  const price = p(r[iTradePrice]);
  const closeP = p(r[iTradeCloseP]);
  const proceeds = p(r[iTradeProceeds]);
  const comm = p(r[iTradeComm]);
  const basis = p(r[iTradeBasis]);
  const realPnl = p(r[iTradeRealPnl]);
  const mtmPnl = p(r[iTradeMtm]);
  const notes = r[iTradeNotes] || '';
  // Map notes: O=open, C=close, A=assignment, P=partial
  let code = '';
  if (notes.includes('A')) code += 'A;';
  if (notes.includes('O')) code += 'O';
  else if (notes.includes('C')) code += 'C';
  if (notes.includes('P')) code += ';P';
  tradeRows.push({ cat, sym, dt: fmtDt, qty, price, closeP, proceeds, comm, basis, realPnl, mtmPnl, code: code.replace(/;$/, '') });
}

// Cash Transactions (Deposits/Withdrawals)
const iCashDesc = colIdx(cashTx, 'Description');
const iCashAmount = colIdx(cashTx, 'Amount');
const iCashType = colIdx(cashTx, 'Type');
const iCashSettle = colIdx(cashTx, 'SettleDate');
const iCashLevel = colIdx(cashTx, 'LevelOfDetail');

const depRows = [];
let depTotal = 0;
// Also look for internal transfers in cash transactions
for (const r of cashTx.rows) {
  const level = r[iCashLevel];
  if (level !== 'DETAIL') continue;
  const type = r[iCashType] || '';
  if (type !== 'Deposits/Withdrawals') continue;
  const desc = (r[iCashDesc] || '').replace(/^DISBURSEMENT/i, 'Disbursement').replace(/^INTERNAL/i, 'Internal');
  const amt = p(r[iCashAmount]);
  const settle = r[iCashSettle] || '';
  const fmtSettle = settle.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  depRows.push({ cur: 'USD', acct: accountId, date: fmtSettle, desc, amt });
  depTotal += amt;
}

// Also check for "Internal Cash Transfers" type for internal transfers
for (const r of cashTx.rows) {
  const level = r[iCashLevel];
  if (level !== 'DETAIL') continue;
  const type = r[iCashType] || '';
  if (type !== 'Internal Cash Transfers' && type !== 'Deposits & Withdrawals') continue;
  if (type === 'Deposits/Withdrawals') continue; // already handled
  const desc = (r[iCashDesc] || '');
  const amt = p(r[iCashAmount]);
  const settle = r[iCashSettle] || '';
  const fmtSettle = settle.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  depRows.push({ cur: 'USD', acct: accountId, date: fmtSettle, desc, amt });
  depTotal += amt;
}

// If deposits from Change in NAV includes internal transfers that aren't in cashTx,
// add them. The deposits total from Change in NAV includes all transfers.
// Check if we need internal transfers from AssetTransfers line
if (assetTransfers !== 0 && !depRows.some(d => d.desc.includes('Transfer'))) {
  // Asset transfers are position transfers — add as a single line if significant
}

// ── Build Activity Statement CSV ───────────────────────────
const out = [];
function addLine(...parts) {
  out.push(parts.map(p => {
    const s = String(p ?? '');
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(','));
}

// Statement
addLine('Statement', 'Header', 'Field Name', 'Field Value');
addLine('Statement', 'Data', 'BrokerName', 'Interactive Brokers LLC');
addLine('Statement', 'Data', 'Title', 'Activity Statement');
addLine('Statement', 'Data', 'Period', `${fmtDateLong(firstDate)} - ${fmtDateLong(lastDate)}`);
addLine('Statement', 'Data', 'WhenGenerated', new Date().toISOString().replace('T', ', ').slice(0, 22) + ' EST');

// Account Information
addLine('Account Information', 'Header', 'Field Name', 'Field Value');
addLine('Account Information', 'Data', 'Name', acctName);
addLine('Account Information', 'Data', 'Account', accountId);
addLine('Account Information', 'Data', 'Base Currency', 'USD');

// Net Asset Value
addLine('Net Asset Value', 'Header', 'Asset Class', 'Prior Total', 'Current Long', 'Current Short', 'Current Total', 'Change');
addLine('Net Asset Value', 'Data', 'Cash ', priorCash, curCash, 0, curCash, curCash - priorCash);
if (curCollateral) addLine('Net Asset Value', 'Data', 'Collateral Value', 0, curCollateral, 0, curCollateral, curCollateral);
addLine('Net Asset Value', 'Data', 'Stock', priorStock, curStock, 0, curStock, curStock - priorStock);
if (curSecLent) addLine('Net Asset Value', 'Data', 'Securities Lent', 0, 0, curSecLent, curSecLent, curSecLent);
addLine('Net Asset Value', 'Data', 'Options', priorOptions, Math.max(0, curOptions), Math.min(0, curOptions), curOptions, curOptions - priorOptions);
addLine('Net Asset Value', 'Data', 'Interest Accruals', priorInterest, curInterest, 0, curInterest, curInterest - priorInterest);
if (curDivAccruals) addLine('Net Asset Value', 'Data', 'Dividend Accruals', 0, curDivAccruals, 0, curDivAccruals, curDivAccruals);
addLine('Net Asset Value', 'Data', 'Total', priorTotal, curTotalLong, curTotalShort, curTotal, curTotal - priorTotal);
addLine('Net Asset Value', 'Header', 'Time Weighted Rate of Return');
addLine('Net Asset Value', 'Data', `${twr}%`);

// Change in NAV
addLine('Change in Combined NAV', 'Header', 'Field Name', 'Field Value');
addLine('Change in NAV', 'Data', 'Starting Value', startingVal);
addLine('Change in NAV', 'Data', 'Mark-to-Market', mtm);
addLine('Change in NAV', 'Data', 'Deposits & Withdrawals', deposits);
if (assetTransfers) addLine('Change in NAV', 'Data', 'Position Transfers', assetTransfers);
if (chgDivAccruals) addLine('Change in NAV', 'Data', 'Change in Dividend Accruals', chgDivAccruals);
addLine('Change in NAV', 'Data', 'Interest', interest);
addLine('Change in NAV', 'Data', 'Change in Interest Accruals', chgIntAccruals);
addLine('Change in NAV', 'Data', 'Commissions', commissions);
addLine('Change in NAV', 'Data', 'Ending Value', endingVal);

// Open Positions
addLine('Open Positions', 'Header', 'DataDiscriminator', 'Asset Category', 'Currency', 'Symbol', 'Quantity', 'Mult', 'Cost Price', 'Cost Basis', 'Close Price', 'Value', 'Unrealized P/L', 'Code');
for (const pos of posRows) {
  addLine('Open Positions', 'Data', 'Summary', pos.cat, 'USD', pos.sym, pos.qty, pos.mult, pos.cp, pos.cb, pos.closeP, pos.val, pos.upl, '');
}

// Trades
addLine('Trades', 'Header', 'DataDiscriminator', 'Asset Category', 'Currency', 'Account', 'Symbol', 'Date/Time', 'Quantity', 'T. Price', 'C. Price', 'Proceeds', 'Comm/Fee', 'Basis', 'Realized P/L', 'MTM P/L', 'Code');
for (const t of tradeRows) {
  addLine('Trades', 'Data', 'Order', t.cat, 'USD', accountId, t.sym, t.dt, t.qty, t.price, t.closeP, t.proceeds, t.comm, t.basis, t.realPnl, t.mtmPnl, t.code);
}

// Realized & Unrealized Performance Summary
addLine('Realized & Unrealized Performance Summary', 'Header', 'Asset Category', 'Symbol', 'Cost Adj.', 'Realized S/T Profit', 'Realized S/T Loss', 'Realized L/T Profit', 'Realized L/T Loss', 'Realized Total', 'Unrealized S/T Profit', 'Unrealized S/T Loss', 'Unrealized L/T Profit', 'Unrealized L/T Loss', 'Unrealized Total', 'Total', 'Code');

// Group by category and emit with subtotals
const stockPerf = perfRows.filter(r => r.cat === 'Stocks');
const optPerf = perfRows.filter(r => r.cat === 'Equity and Index Options');

for (const r of stockPerf) {
  addLine('Realized & Unrealized Performance Summary', 'Data', r.cat, r.sym, r.costAdj, r.realST, r.realSTL, r.realLT, r.realLTL, r.realTot, r.unrealSTP, r.unrealSTL, r.unrealLTP, r.unrealLTL, r.unrealTot, r.fifoTot, r.code);
}
// Stock subtotal
addLine('Realized & Unrealized Performance Summary', 'Data', 'Total', '', 0,
  stockPerf.reduce((a, r) => a + r.realST, 0), stockPerf.reduce((a, r) => a + r.realSTL, 0),
  0, 0, stkRealTot,
  stockPerf.reduce((a, r) => a + r.unrealSTP, 0), stockPerf.reduce((a, r) => a + r.unrealSTL, 0),
  0, 0, stkUnrealTot, stkFifoTot, '');

for (const r of optPerf) {
  addLine('Realized & Unrealized Performance Summary', 'Data', r.cat, r.sym, r.costAdj, r.realST, r.realSTL, r.realLT, r.realLTL, r.realTot, r.unrealSTP, r.unrealSTL, r.unrealLTP, r.unrealLTL, r.unrealTot, r.fifoTot, r.code);
}
// Options subtotal
addLine('Realized & Unrealized Performance Summary', 'Data', 'Total', '', 0,
  optPerf.reduce((a, r) => a + r.realST, 0), optPerf.reduce((a, r) => a + r.realSTL, 0),
  0, 0, optRealTot,
  optPerf.reduce((a, r) => a + r.unrealSTP, 0), optPerf.reduce((a, r) => a + r.unrealSTL, 0),
  0, 0, optUnrealTot, optFifoTot, '');

// All Assets total
addLine('Realized & Unrealized Performance Summary', 'Data', 'Total (All Assets)', '', 0,
  allRealSTProfit, allRealSTLoss, 0, 0, allRealTot,
  allUnrealProfit, allUnrealLoss, 0, 0, allUnrealTot, allFifoTot, '');

// Deposits & Withdrawals
addLine('Deposits & Withdrawals', 'Header', 'Currency', 'Account', 'Settle Date', 'Description', 'Amount');
for (const d of depRows) {
  addLine('Deposits & Withdrawals', 'Data', d.cur, d.acct, d.date, d.desc, d.amt);
}
addLine('Deposits & Withdrawals', 'Data', 'Total', '', '', '', depTotal);

// ── Write output ───────────────────────────────────────────
fs.writeFileSync(outputPath, out.join('\n') + '\n');
const size = (Buffer.byteLength(out.join('\n')) / 1024).toFixed(1);
console.log(`✅ Activity Statement CSV written: ${outputPath} (${size} KB)`);
console.log(`   Sections: Statement, NAV, Change in NAV, Open Positions (${posRows.length}), Trades (${tradeRows.length}), Performance Summary (${perfRows.length}), Deposits (${depRows.length})`);
