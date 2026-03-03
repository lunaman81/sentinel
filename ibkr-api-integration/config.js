/**
 * IBKR API Integration Configuration
 * 
 * Edit this file before running. All other files read from here.
 */

module.exports = {
  // ── Connection ───────────────────────────────────────────────
  // Gateway URL. Default is localhost:5000 for Client Portal Gateway.
  // If using IB Gateway (TWS), change to localhost:4001 or 4002.
  baseUrl: 'https://localhost:5001',

  // Your IBKR account ID (visible on Activity Statements).
  // Leave null to auto-detect (picks first account).
  accountId: 'U12781141',

  // Account holder name (for CSV header)
  accountName: 'Gabriel Luna-Ostaseski',

  // ── Session ──────────────────────────────────────────────────
  keepaliveMs: 55_000,  // Tickle interval (session expires at 60s)

  // ── Polling ──────────────────────────────────────────────────
  // How often to check for close targets (in ms)
  priceCheckIntervalMs: 60_000,  // 1 minute

  // ── Output ───────────────────────────────────────────────────
  // Where to save generated CSVs
  outputDir: './output',

  // ── Sentinel Thresholds (from Rules Reference) ───────────────
  // These match your dashboard. Used by the live monitor for alerts.
  sentinel: {
    maxExposurePct:     12,    // Hard cap per ticker
    warnExposurePct:    10,    // Yellow alert
    maxDeploymentPct:   85,    // Stock + put notional / NAV
    frozenThresholdPct: -3,    // P&L below this % of NAV → frozen
    maxRolls:           3,     // Per ticker (Tier 1 exception)
    profitTargetPct:    80,    // General close target
    zeroDteTargetPct:   90,    // 0-DTE close target
    minCushionPct:      5,     // Entry cushion
  },

  // ── Close Target Ladder (by DTE) ─────────────────────────────
  // From v3 plan: dynamic close targets by days to expiration
  closeTargets: [
    { maxDte: 0, targetPct: 90, label: '0 DTE — close >90% or let expire' },
    { maxDte: 1, targetPct: 85, label: '1 DTE (Thu AM) — close >85%' },
    { maxDte: 2, targetPct: 80, label: '2+ DTE — close >80%' },
  ],

  // ── Prior NAV Snapshot (from last CSV upload) ────────────────
  // Update these after each CSV upload to maintain accurate Change in NAV.
  // Values from your most recent Activity Statement.
  priorNav: {
    total:    2305823.41,
    cash:     1239381.25,
    stock:    1074766.79,
    options:  -11343.62,
    interest: 3018.99,
  },

  // ── Market Data Fields ───────────────────────────────────────
  // Field codes requested from /iserver/marketdata/snapshot
  // 31=last, 84=bid, 86=ask, 7284=impliedVol
  marketDataFields: ['31', '84', '86'],

  // ── Tier 3 Blacklist (from 2025 analysis) ────────────────────
  blacklist: ['MSTR', 'RIOT', 'DDOG', 'ABNB', 'META', 'SHOP', 'COIN', 'AMZN', 'OPEN', 'AMD'],
};
