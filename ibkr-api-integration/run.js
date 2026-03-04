#!/usr/bin/env node
/**
 * IBKR API Integration Runner
 *
 * Usage:
 *   node run.js              # One-shot: generate CSV from current positions (requires Gateway)
 *   node run.js --push       # Flex Query: fetch → convert → QA → push to GitHub
 *   node run.js --live       # Gateway: generate CSV → push to GitHub, loop every 5 min
 *   node run.js --code "description"  # Code push: QA → changelog → tag → push modified files
 *   node run.js --monitor    # Generate CSV + start live price monitoring (requires Gateway)
 *   node run.js --spike      # Quick auth test (validates gateway connection)
 *
 * --push mode uses Flex Query API (no Gateway needed):
 *   1. Runs flex-fetch.js to download raw Flex CSV
 *   2. Runs flex-to-activity.js to convert to Activity Statement format
 *   3. Runs dashboard-qa.js to validate — aborts if bugs found
 *   4. Copies to ~/sentinel/latest.csv, git add/commit/push
 *
 * Prerequisites for --push:
 *   ~/.sentinel-flex-config.json with token and queryId
 *
 * Prerequisites for other modes:
 *   1. IBKR Client Portal Gateway running (see README.md)
 *   2. Authenticated in browser at https://localhost:5000
 *   3. config.js updated with your account ID
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MODES = {
  SPIKE:   '--spike',
  CSV:     '--csv',      // default
  MONITOR: '--monitor',
  PUSH:    '--push',
  LIVE:    '--live',
  CODE:    '--code',
};

// ── Flex Query Push Mode ──────────────────────────────────────
async function flexPush() {
  const __dir = __dirname;
  const sentinelDir = path.resolve(__dir, '..');
  const latestCsv = path.join(sentinelDir, 'latest.csv');

  // Step 1: Fetch raw Flex CSV
  console.log('\n═══ STEP 1: Fetching Flex Query from IBKR ═══');
  try {
    execSync('node flex-fetch.js', { cwd: __dir, stdio: 'inherit' });
  } catch (err) {
    console.error('❌ flex-fetch.js failed. Aborting.');
    process.exit(1);
  }

  // Step 2: Convert to Activity Statement format
  console.log('\n═══ STEP 2: Converting to Activity Statement ═══');
  try {
    execSync('node flex-to-activity.js', { cwd: __dir, stdio: 'inherit' });
  } catch (err) {
    console.error('❌ flex-to-activity.js failed. Aborting.');
    process.exit(1);
  }

  // Step 3-7: QA → changelog → tag → commit → push (via push-wrapper)
  const { pushWithQA } = require('./push-wrapper');
  const result = await pushWithQA({ mode: 'flex' });
  if (!result.success) process.exit(1);

  console.log('\n══════════════════════════════════════════════');
  console.log('✅ FLEX PUSH COMPLETE');
  console.log('══════════════════════════════════════════════\n');
}

// ── Live Gateway Push Mode (merges live prices into Flex CSV) ──
const LIVE_INTERVAL_MS = 5 * 60 * 1000;

// Parse Activity Statement CSV into ordered sections
function parseActivityCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').split('\n').filter(l => l.trim());
  // Track sections in order, preserving raw lines grouped by section name
  const sectionOrder = [];
  const sectionLines = {};
  for (const line of lines) {
    // Parse first field to get section name
    let first = '', q = false, i = 0;
    for (; i < line.length; i++) {
      if (line[i] === '"') { q = !q; continue; }
      if (line[i] === ',' && !q) break;
      first += line[i];
    }
    const name = first.trim();
    if (!sectionLines[name]) {
      sectionOrder.push(name);
      sectionLines[name] = [];
    }
    sectionLines[name].push(line);
  }
  return { sectionOrder, sectionLines };
}

// Build Open Positions section from Gateway positions + live prices
function buildPositionLines(positions, prices) {
  const { CSVGenerator } = require('./ibkr-to-csv');
  const gen = new CSVGenerator('', '');
  const stocks = positions.filter(p => p.assetClass === 'STK');
  const options = positions.filter(p => p.assetClass === 'OPT');
  const lines = [];

  if (stocks.length > 0 || options.length > 0) {
    lines.push('Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code');
  }

  for (const p of stocks) {
    const mapped = gen._mapStockPosition(p, prices);
    lines.push(`Open Positions,Data,Summary,Stocks,USD,${mapped.symbol},${mapped.qty},1,${mapped.costPrice},${mapped.costBasis},${mapped.closePrice},${mapped.value},${mapped.unrealizedPL},`);
  }

  for (const p of options) {
    const mapped = gen._mapOptionPosition(p, prices);
    lines.push(`Open Positions,Data,Summary,Equity and Index Options,USD,${mapped.symbol},${mapped.qty},100,${mapped.costPrice},${mapped.costBasis},${mapped.closePrice},${mapped.value},${mapped.unrealizedPL},`);
  }

  return lines;
}

// Build NAV section from Gateway ledger data, preserving prior totals from Flex
function buildNavLines(ledger, priorNavLines) {
  const usd = ledger?.USD || ledger?.BASE || {};
  const cash = parseFloat(usd.cashbalance) || 0;
  const stock = parseFloat(usd.stockmarketvalue) || 0;
  const opts = parseFloat(usd.optionmarketvalue) || 0;
  const interest = parseFloat(usd.accruedinterest) || 0;
  const total = parseFloat(usd.netliquidationvalue) || 0;

  // Extract prior totals from existing Flex NAV lines
  function priorVal(assetName) {
    const line = priorNavLines.find(l => {
      const parts = l.split(',');
      return parts[1] === 'Data' && parts[2]?.trim() === assetName;
    });
    if (!line) return 0;
    const parts = line.split(',');
    return parseFloat(parts[3]) || 0;
  }
  const priorCash = priorVal('Cash');
  const priorStock = priorVal('Stock');
  const priorOpts = priorVal('Options');
  const priorInterest = priorVal('Interest Accruals');
  const priorTotal = priorVal('Total');

  const totalLong = cash + Math.max(0, stock) + Math.max(0, opts) + interest;
  const totalShort = Math.min(0, opts);

  const lines = [];
  lines.push('Net Asset Value,Header,Asset Class,Prior Total,Current Long,Current Short,Current Total,Change');
  lines.push(`Net Asset Value,Data,Cash ,${priorCash},${cash},0,${cash},${cash - priorCash}`);
  lines.push(`Net Asset Value,Data,Stock,${priorStock},${Math.max(0, stock)},0,${Math.max(0, stock)},${stock - priorStock}`);
  lines.push(`Net Asset Value,Data,Options,${priorOpts},${Math.max(0, opts)},${Math.min(0, opts)},${opts},${opts - priorOpts}`);
  lines.push(`Net Asset Value,Data,Interest Accruals,${priorInterest},${interest},0,${interest},${interest - priorInterest}`);
  lines.push(`Net Asset Value,Data,Total,${priorTotal},${totalLong},${totalShort},${total},${total - priorTotal}`);

  // Preserve TWR from Flex
  const twrLine = priorNavLines.find(l => l.includes('Time Weighted Rate'));
  const twrDataLine = priorNavLines.find(l => l.match(/Net Asset Value,Data,[\d.-]+%/));
  if (twrLine) lines.push(twrLine);
  if (twrDataLine) lines.push(twrDataLine);

  return lines;
}

async function livePush() {
  const { IBKRApi } = require('./ibkr-api');
  const config = require('./config');

  const sentinelDir = path.resolve(__dirname, '..');
  const latestCsv = path.join(sentinelDir, 'latest.csv');
  const api = new IBKRApi(config);

  // Require existing latest.csv from a prior --push run
  if (!fs.existsSync(latestCsv)) {
    console.error('❌ No latest.csv found. Run --push first to establish baseline Flex data.');
    process.exit(1);
  }

  // Step 1: Authenticate once
  console.log('\n═══ LIVE MODE: Merge live prices into Flex CSV (every 5 min) ═══');
  console.log('🔐 Checking IBKR authentication...');
  await api.waitForAuth(15_000);
  api.startKeepalive();
  const accounts = await api.getAccounts();
  console.log(`📋 Account: ${api.accountId}`);

  let cycle = 0;

  async function tick() {
    cycle++;
    const ts = new Date().toLocaleTimeString();
    console.log(`\n──── Cycle ${cycle} @ ${ts} ────`);

    try {
      // Step 2: Read existing Flex CSV
      const existing = fs.readFileSync(latestCsv, 'utf-8');
      const { sectionOrder, sectionLines } = parseActivityCSV(existing);

      // Step 3: Pull live data from Gateway
      console.log('📡 Pulling live data from IBKR...');
      const [ledger, positions] = await Promise.all([
        api.getAccountLedger(),
        api.getPositions(),
      ]);
      console.log(`   Positions: ${positions.length}`);

      const conids = positions.map(p => p.conid).filter(Boolean);
      let prices = {};
      if (conids.length > 0) {
        const snapshots = await api.getMarketData(conids, config.marketDataFields);
        if (Array.isArray(snapshots)) {
          for (const snap of snapshots) {
            prices[snap.conid] = {
              lastPrice: parseFloat(snap['31']) || 0,
              bidPrice:  parseFloat(snap['84']) || 0,
              askPrice:  parseFloat(snap['86']) || 0,
            };
          }
        }
        console.log(`   Live prices: ${Object.keys(prices).length} received`);
      }

      // Step 4: Replace sections with live data, preserve the rest
      // Update Statement timestamp
      if (sectionLines['Statement']) {
        const genLine = sectionLines['Statement'].findIndex(l => l.includes('WhenGenerated'));
        if (genLine >= 0) {
          const now = new Date();
          const gen = now.toISOString().replace('T', ', ').slice(0, 22) + ' EST';
          sectionLines['Statement'][genLine] = `Statement,Data,WhenGenerated,${gen}`;
        }
      }

      // Replace NAV with live values (preserve prior totals from Flex)
      sectionLines['Net Asset Value'] = buildNavLines(ledger, sectionLines['Net Asset Value'] || []);

      // Replace Open Positions with live data
      sectionLines['Open Positions'] = buildPositionLines(positions, prices);

      // Step 5: Reassemble CSV in original section order
      const merged = [];
      for (const name of sectionOrder) {
        if (sectionLines[name]) {
          merged.push(...sectionLines[name]);
        }
      }

      fs.writeFileSync(latestCsv, merged.join('\n') + '\n');
      const stkCount = positions.filter(p => p.assetClass === 'STK').length;
      const optCount = positions.filter(p => p.assetClass === 'OPT').length;
      console.log(`   Merged: ${stkCount} stocks, ${optCount} options into Flex CSV`);

      // Step 6-7: QA → changelog → tag → commit → push (via push-wrapper)
      const { pushWithQA } = require('./push-wrapper');
      await pushWithQA({ mode: 'live' });
    } catch (err) {
      console.error(`⚠️  Cycle ${cycle} failed: ${err.message}`);
    }

    console.log(`⏳ Next update in 5 minutes...`);
  }

  // Run first cycle immediately, then loop
  await tick();
  const interval = setInterval(() => tick().catch(e => console.error(`⚠️  tick error: ${e.message}`)), LIVE_INTERVAL_MS);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down live mode...');
    clearInterval(interval);
    api.destroy();
    process.exit(0);
  });

  console.log('Press Ctrl+C to stop.\n');
}

// ── Code Push Mode ────────────────────────────────────────────
async function codePush() {
  const sentinelDir = path.resolve(__dirname, '..');

  // Collect description from args after --code
  const args = process.argv.slice(3);
  const description = args.join(' ').trim();
  if (!description) {
    console.error('❌ Usage: node run.js --code "description of what changed and why"');
    process.exit(1);
  }

  // Auto-detect modified and untracked files (relative to sentinel root)
  console.log('\n═══ CODE PUSH ═══');
  let statusOutput;
  try {
    statusOutput = execSync('git status --porcelain', { cwd: sentinelDir, encoding: 'utf-8' });
  } catch (err) {
    console.error('❌ git status failed:', err.message);
    process.exit(1);
  }

  const files = statusOutput
    .split('\n')
    .filter(l => l.trim())
    .map(l => l.slice(3).trim())       // strip status prefix (e.g. " M ", "?? ")
    .filter(f => f !== 'latest.csv' && f !== 'CHANGELOG.md' && f !== 'run.log'); // managed by wrapper

  if (files.length === 0) {
    console.log('No modified files to push.');
    process.exit(0);
  }

  console.log(`  Files: ${files.join(', ')}`);
  console.log(`  Description: ${description}`);

  const { pushWithQA } = require('./push-wrapper');
  const result = await pushWithQA({ mode: 'code', files, description });
  if (!result.success) process.exit(1);

  console.log('══════════════════════════════════════════════');
  console.log('✅ CODE PUSH COMPLETE');
  console.log('══════════════════════════════════════════════\n');
}

async function main() {
  const mode = process.argv[2] || MODES.CSV;

  // --push uses Flex Query API (no Gateway needed)
  if (mode === MODES.PUSH) {
    return flexPush();
  }

  // --live uses Gateway + loops every 5 min
  if (mode === MODES.LIVE) {
    return livePush();
  }

  // --code pushes code/config changes through the wrapper
  if (mode === MODES.CODE) {
    return codePush();
  }

  // All other modes require Gateway
  const { IBKRApi } = require('./ibkr-api');
  const { CSVGenerator } = require('./ibkr-to-csv');
  const { LiveMonitor } = require('./live-monitor');
  const config = require('./config');

  const api = new IBKRApi(config);

  try {
    // ── Step 1: Authenticate ─────────────────────────────────
    console.log('🔐 Checking IBKR authentication...');
    await api.waitForAuth(15_000);
    api.startKeepalive();

    // ── Step 2: Get account ──────────────────────────────────
    const accounts = await api.getAccounts();
    console.log(`📋 Account: ${api.accountId}`);

    // ── Spike mode: just verify connection ───────────────────
    if (mode === MODES.SPIKE) {
      console.log('\n── SPIKE: Testing data access ──');

      // Pull positions
      const positions = await api.getPositions();
      console.log(`\n✅ Positions: ${positions.length} found`);

      if (positions.length === 0) {
        console.log('\n⚠️  No positions found. Is the market open? Do you have open positions?');
        api.destroy();
        return;
      }

      // Find a stock and an option position to validate both mappings
      const stockPos = positions.find(p => p.assetClass === 'STK');
      const optPos = positions.find(p => p.assetClass === 'OPT');

      // Dump ALL fields from each (so we catch any naming surprises)
      if (stockPos) {
        console.log('\n── Stock Position (ALL fields) ──');
        console.log(JSON.stringify(stockPos, null, 2));
      } else {
        console.log('\n⚠️  No stock positions found (OK if you have no assigned shares right now)');
      }

      if (optPos) {
        console.log('\n── Option Position (ALL fields) ──');
        console.log(JSON.stringify(optPos, null, 2));
      } else {
        console.log('\n⚠️  No option positions found');
      }

      // Validate the specific fields our CSV generator depends on
      console.log('\n── Field Validation ──');
      const REQUIRED_FIELDS = ['conid', 'position', 'avgCost', 'mktPrice', 'mktValue', 'unrealizedPnl', 'assetClass'];
      const OPT_FIELDS = ['contractDesc', 'strike', 'expiry', 'putOrCall'];
      const sample = optPos || stockPos;

      for (const field of REQUIRED_FIELDS) {
        const val = sample[field];
        const status = val !== undefined ? `✅ ${field} = ${val}` : `❌ ${field} MISSING`;
        console.log(`  ${status}`);
      }
      if (optPos) {
        for (const field of OPT_FIELDS) {
          const val = optPos[field];
          const status = val !== undefined ? `✅ ${field} = ${val}` : `⚠️  ${field} missing (will use fallback)`;
          console.log(`  ${status}`);
        }
      }

      // Also check: does the API use 'ticker' or 'symbol' for the ticker name?
      const tickerField = sample.ticker ? 'ticker' : (sample.symbol ? 'symbol' : 'NEITHER');
      console.log(`\n  Ticker field name: "${tickerField}" = ${sample.ticker || sample.symbol || 'N/A'}`);

      // Pull summary
      const summary = await api.getAccountSummary();
      console.log('\n── Account Summary (key fields) ──');
      console.log(`  netliquidation: ${JSON.stringify(summary.netliquidation)}`);
      console.log(`  totalcashvalue: ${JSON.stringify(summary.totalcashvalue)}`);
      console.log(`  realizedpnl:    ${JSON.stringify(summary.realizedpnl)}`);

      // Pull ledger
      const ledger = await api.getAccountLedger();
      const usd = ledger?.USD || ledger?.BASE || {};
      console.log('\n── Ledger USD (key fields) ──');
      console.log(`  cashbalance:         ${usd.cashbalance}`);
      console.log(`  netliquidationvalue: ${usd.netliquidationvalue}`);
      console.log(`  accruedinterest:     ${usd.accruedinterest}`);

      // Pull trades
      const trades = await api.getTrades();
      console.log(`\n✅ Recent trades: ${Array.isArray(trades) ? trades.length : 0} found`);
      if (Array.isArray(trades) && trades.length > 0) {
        console.log('\n── Sample Trade (ALL fields) ──');
        console.log(JSON.stringify(trades[0], null, 2));
      }

      console.log('\n══════════════════════════════════════════════');
      console.log('✅ SPIKE PASSED — Copy the output above and share with me.');
      console.log('   I\'ll verify field mappings match and flag any fixes needed.');
      console.log('   Then: `node run.js` for CSV, `node run.js --monitor` for live alerts.');
      console.log('══════════════════════════════════════════════\n');

      api.destroy();
      return;
    }

    // ── Step 3: Pull all data ────────────────────────────────
    console.log('\n📡 Pulling data from IBKR...');

    const [summary, ledger, positions, trades] = await Promise.all([
      api.getAccountSummary(),
      api.getAccountLedger(),
      api.getPositions(),
      api.getTrades(),
    ]);

    console.log(`   Positions: ${positions.length}`);
    console.log(`   Trades: ${Array.isArray(trades) ? trades.length : 0}`);

    // ── Step 4: Get live prices for all positions ────────────
    const conids = positions.map(p => p.conid).filter(Boolean);
    let prices = {};
    if (conids.length > 0) {
      console.log(`   Fetching live prices for ${conids.length} contracts...`);
      const snapshots = await api.getMarketData(conids, config.marketDataFields);
      if (Array.isArray(snapshots)) {
        for (const snap of snapshots) {
          prices[snap.conid] = {
            lastPrice: parseFloat(snap['31']) || 0,
            bidPrice:  parseFloat(snap['84']) || 0,
            askPrice:  parseFloat(snap['86']) || 0,
          };
        }
      }
      console.log(`   Live prices: ${Object.keys(prices).length} received`);
    }

    // ── Step 5: Generate CSV ─────────────────────────────────
    const generator = new CSVGenerator(config.accountId, config.accountName);
    const csv = generator.generate({
      summary,
      ledger,
      positions,
      trades: Array.isArray(trades) ? trades : [],
      priorNav: config.priorNav,
      prices,
    });

    // Write to output dir
    const outputDir = config.outputDir;
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `${config.accountId}_LIVE_${dateStr}.csv`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, csv);

    console.log(`\n✅ CSV generated: ${filepath}`);
    console.log(`   Upload this to your dashboard — parser will read it identically to a manual IBKR download.`);

    // ── Step 6: Monitor mode (optional) ──────────────────────
    if (mode === MODES.MONITOR) {
      const monitor = new LiveMonitor(api);
      await monitor.start();

      // Graceful shutdown
      process.on('SIGINT', () => {
        console.log('\n\nShutting down...');
        monitor.stop();
        api.destroy();
        process.exit(0);
      });

      console.log('Press Ctrl+C to stop monitoring.\n');
    } else {
      api.destroy();
    }

  } catch (e) {
    console.error(`\n❌ Error: ${e.message}`);

    if (e.message.includes('ECONNREFUSED')) {
      console.error('\n💡 Gateway not running. Start it first:');
      console.error('   cd ~/clientportal.gw && bin/run.sh root/conf.yaml\n');
    } else if (e.message.includes('Authentication timeout')) {
      console.error(`\n💡 Open ${config.baseUrl} in your browser and log in.\n`);
    }

    api.destroy();
    process.exit(1);
  }
}

main();
