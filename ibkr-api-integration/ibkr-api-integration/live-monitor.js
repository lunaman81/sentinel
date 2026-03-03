/**
 * Live Position Monitor
 * 
 * Polls IBKR for live prices and alerts when options hit close targets.
 * This is the core value of the API integration — eliminates the
 * "manually checking IBKR at random times" anxiety loop.
 * 
 * What it does:
 *   1. Pulls current positions from API
 *   2. Gets live prices for all option contracts
 *   3. Calculates profit % for each position
 *   4. Applies DTE-based close target ladder
 *   5. Logs actionable alerts to console (and optionally a webhook)
 *   6. Repeats on interval
 * 
 * Close Target Ladder (from v3 plan):
 *   0 DTE  → close >90% or let expire
 *   1 DTE  → close >85%
 *   2+ DTE → close >80%
 */

const { IBKRApi, FIELD_MAP } = require('./ibkr-api');
const config = require('./config');

class LiveMonitor {
  constructor(api) {
    this.api = api;
    this._interval = null;
    this._lastAlerts = new Map(); // Avoid duplicate alerts within same session
  }

  async start() {
    console.log('\n🎯 Live Position Monitor started');
    console.log(`   Polling every ${config.priceCheckIntervalMs / 1000}s`);
    console.log(`   Close targets: ${config.closeTargets.map(t => `${t.targetPct}% (≤${t.maxDte} DTE)`).join(', ')}`);
    console.log('');

    // Run immediately, then on interval
    await this._check();
    this._interval = setInterval(() => this._check(), config.priceCheckIntervalMs);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    console.log('🛑 Monitor stopped');
  }

  async _check() {
    try {
      const positions = await this.api.getPositions();
      const options = positions.filter(p => p.assetClass === 'OPT');

      if (options.length === 0) {
        console.log(`[${this._ts()}] No open options positions`);
        return;
      }

      // Get live prices for all option contracts
      const conids = options.map(p => p.conid);
      const snapshots = await this.api.getMarketData(conids, config.marketDataFields);

      // Build price map: conid → { lastPrice, bidPrice, askPrice }
      const priceMap = {};
      if (Array.isArray(snapshots)) {
        for (const snap of snapshots) {
          priceMap[snap.conid] = {
            lastPrice: this._parseNum(snap['31']),
            bidPrice:  this._parseNum(snap['84']),
            askPrice:  this._parseNum(snap['86']),
          };
        }
      }

      // Analyze each position
      const alerts = [];
      const summary = [];

      for (const pos of options) {
        const analysis = this._analyzePosition(pos, priceMap[pos.conid]);
        summary.push(analysis);

        if (analysis.alert) {
          alerts.push(analysis);
        }
      }

      // Output
      this._printSummary(summary);
      if (alerts.length > 0) {
        this._printAlerts(alerts);
      }

    } catch (e) {
      console.error(`[${this._ts()}] ❌ Monitor error: ${e.message}`);
    }
  }

  _analyzePosition(pos, prices) {
    const symbol = pos.contractDesc || pos.ticker || 'UNKNOWN';
    const qty = Math.abs(pos.position);
    const isShort = pos.position < 0;
    const costPerContract = Math.abs(pos.avgCost);
    const totalPremium = costPerContract * qty * 100;

    // Live price: use ASK for close cost estimate (what you'd pay to buy-to-close)
    // Bid would underestimate close cost and overstate profit
    const live = prices || {};
    const currentPrice = live.askPrice || live.lastPrice || pos.mktPrice || 0;
    const currentValue = Math.abs(currentPrice * qty * 100);

    // For short options: profit = premium collected - current value
    // Profit % = (premium - current) / premium * 100
    let profitPct = 0;
    if (isShort && totalPremium > 0) {
      profitPct = ((totalPremium - currentValue) / totalPremium) * 100;
    }

    // DTE calculation
    const dte = this._calcDTE(pos);

    // Close target based on DTE
    const target = this._getCloseTarget(dte);

    // Is this at or above target?
    const atTarget = profitPct >= target.targetPct;
    const nearTarget = profitPct >= (target.targetPct - 5); // Within 5% of target

    // Cushion (for puts: how far stock is above strike)
    // Requires underlying price — get from position data if available
    const cushion = pos.undPrice && pos.strike
      ? ((pos.undPrice - pos.strike) / pos.undPrice) * 100
      : null;

    // Alert conditions
    let alert = null;
    const alertKey = `${symbol}-${target.targetPct}`;
    if (atTarget && !this._lastAlerts.has(alertKey)) {
      alert = 'CLOSE_TARGET';
      this._lastAlerts.set(alertKey, Date.now());
    }

    return {
      symbol,
      qty,
      isShort,
      costPerContract: this._round(costPerContract),
      currentPrice: this._round(currentPrice),
      profitPct: this._round(profitPct),
      dte,
      target,
      atTarget,
      nearTarget,
      cushion: cushion !== null ? this._round(cushion) : '—',
      unrealizedPL: this._round(pos.unrealizedPnl || 0),
      alert,
    };
  }

  _calcDTE(pos) {
    // Extract expiry from contractDesc or expiry field
    // contractDesc format: "AMD 27FEB26 192.5 P"
    const desc = pos.contractDesc || '';
    const match = desc.match(/(\d{2})([A-Z]{3})(\d{2})/);
    if (match) {
      const months = { JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5,
                       JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11 };
      const day = parseInt(match[1]);
      const month = months[match[2]];
      const year = 2000 + parseInt(match[3]);
      const expiry = new Date(year, month, day);
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      return Math.max(0, Math.ceil((expiry - now) / 86_400_000));
    }

    // Fallback: use expiry field (YYYYMMDD format)
    if (pos.expiry) {
      const y = parseInt(pos.expiry.substring(0, 4));
      const m = parseInt(pos.expiry.substring(4, 6)) - 1;
      const d = parseInt(pos.expiry.substring(6, 8));
      const expiry = new Date(y, m, d);
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      return Math.max(0, Math.ceil((expiry - now) / 86_400_000));
    }

    return null;
  }

  _getCloseTarget(dte) {
    if (dte === null) {
      return { targetPct: config.sentinel.profitTargetPct, label: 'Unknown DTE — using default' };
    }
    // Find matching ladder entry (sorted by maxDte ascending)
    for (const entry of config.closeTargets) {
      if (dte <= entry.maxDte) return entry;
    }
    // Default for higher DTE
    return { maxDte: 999, targetPct: config.sentinel.profitTargetPct, label: `${dte} DTE — standard target` };
  }

  // ── Output ───────────────────────────────────────────────────

  _printSummary(positions) {
    console.log(`\n[${this._ts()}] ── Position Summary ──────────────────────`);
    console.log(
      'Symbol'.padEnd(25) +
      'Qty'.padStart(5) +
      'Cost'.padStart(8) +
      'Now'.padStart(8) +
      'P%'.padStart(7) +
      'DTE'.padStart(5) +
      'Tgt'.padStart(5) +
      'Status'.padStart(10)
    );
    console.log('─'.repeat(73));

    for (const p of positions) {
      const status = p.atTarget ? '🟢 CLOSE' :
                     p.nearTarget ? '🟡 NEAR' : '';
      console.log(
        p.symbol.padEnd(25) +
        String(p.qty).padStart(5) +
        String(p.costPerContract).padStart(8) +
        String(p.currentPrice).padStart(8) +
        `${p.profitPct}%`.padStart(7) +
        String(p.dte ?? '?').padStart(5) +
        `${p.target.targetPct}%`.padStart(5) +
        status.padStart(10)
      );
    }
  }

  _printAlerts(alerts) {
    console.log('\n🔔 ═══ CLOSE ALERTS ═══════════════════════════════');
    for (const a of alerts) {
      console.log(`   🟢 ${a.symbol}: ${a.profitPct}% profit (target: ${a.target.targetPct}%) — ${a.dte} DTE`);
      console.log(`      Action: BUY TO CLOSE ${a.qty}x at ~$${a.currentPrice}`);
    }
    console.log('═══════════════════════════════════════════════════\n');
  }

  // ── Helpers ──────────────────────────────────────────────────

  _parseNum(val) {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const n = parseFloat(val.replace(/[^0-9.\-]/g, ''));
      return isNaN(n) ? 0 : n;
    }
    return 0;
  }

  _round(n) { return Math.round((n || 0) * 100) / 100; }

  _ts() {
    const d = new Date();
    return d.toLocaleTimeString('en-US', { hour12: false });
  }
}

module.exports = { LiveMonitor };
