#!/usr/bin/env node
/**
 * IBKR API Integration Runner
 *
 * Usage:
 *   node run.js              # One-shot: generate CSV from current positions (requires Gateway)
 *   node run.js --push       # Flex Query: fetch → convert → QA → push to GitHub
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

  // Step 3: QA validation
  console.log('\n═══ STEP 3: Running QA validation ═══');
  try {
    execSync(`node dashboard-qa.js latest.csv`, { cwd: sentinelDir, stdio: 'inherit' });
  } catch (err) {
    console.error('❌ QA validation failed. Aborting push.');
    process.exit(1);
  }

  // Step 4: Git push
  console.log('\n═══ STEP 4: Pushing to GitHub ═══');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  try {
    execSync('git add latest.csv', { cwd: sentinelDir, stdio: 'pipe' });
    execSync(`git commit -m "data: Flex update ${now}"`, { cwd: sentinelDir, stdio: 'pipe' });
    execSync('git push origin main', { cwd: sentinelDir, stdio: 'pipe' });
    console.log(`\n✅ Pushed to GitHub: data: Flex update ${now}`);
  } catch (err) {
    if (err.stderr && err.stderr.toString().includes('nothing to commit')) {
      console.log('ℹ️  No changes to commit (data unchanged).');
    } else {
      console.error(`⚠️  Git push failed: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\n══════════════════════════════════════════════');
  console.log('✅ FLEX PUSH COMPLETE');
  console.log('══════════════════════════════════════════════\n');
}

async function main() {
  const mode = process.argv[2] || MODES.CSV;

  // --push uses Flex Query API (no Gateway needed)
  if (mode === MODES.PUSH) {
    return flexPush();
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
