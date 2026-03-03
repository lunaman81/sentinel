# IBKR API Integration for Sentinel Dashboard

**Status:** Scaffold ready. Needs gateway setup + spike to validate.
**Time to first result:** ~15 minutes (gateway download + auth + spike)

## What This Does

Connects to your IBKR account via the Client Portal API and:

1. **Generates Activity Statement CSVs** from live data → upload to dashboard (zero parser changes)
2. **Monitors live prices** → alerts when options hit close targets (80/85/90% by DTE)
3. **Eliminates** the manual check-IBKR-at-random-times anxiety loop

## Architecture

```
IBKR Client Portal Gateway (runs locally on your Mac)
  ↕ REST API (localhost:5000)
ibkr-api.js          → Auth, session keepalive, all API calls
ibkr-to-csv.js       → Transforms API responses → Activity Statement CSV format
live-monitor.js      → Polls prices, calculates profit %, fires close alerts
config.js            → Account ID, Sentinel thresholds, close target ladder
run.js               → Entry point: spike / csv / monitor modes
```

## Quick Start (The Spike)

### Step 1: Download Gateway (~2 min)

```bash
# Download IBKR Client Portal Gateway
# Go to: https://www.interactivebrokers.com/en/trading/ib-api.php
# → "Client Portal API" → Download the gateway ZIP
# OR direct link (may change):
# https://download2.interactivebrokers.com/portal/clientportal.gw.zip

# Unzip to home directory
cd ~
unzip clientportal.gw.zip
```

### Step 2: Start Gateway (~1 min)

```bash
cd ~/clientportal.gw
bin/run.sh root/conf.yaml
```

The gateway starts on `https://localhost:5000`. You'll see:
```
[INFO] Starting server on port 5000
```

### Step 3: Authenticate (~2 min)

1. Open `https://localhost:5000` in Chrome
2. Accept the self-signed certificate warning
3. Log in with your IBKR credentials (same as TWS/IBKR Mobile)
4. Complete 2FA if prompted
5. You'll see a JSON response like `{"authenticated":true}`

### Step 4: Run the Spike (~1 min)

```bash
cd /path/to/ibkr-api-integration
node run.js --spike
```

Expected output:
```
🔐 Checking IBKR authentication...
✅ Authenticated to IBKR
📋 Account: U12781141

── SPIKE: Testing data access ──
✅ Positions: 10 found

Sample position (raw API response):
{
  "acctId": "U12781141",
  "conid": 265598,
  "contractDesc": "AAPL",
  "position": 100,
  "mktPrice": 187.50,
  "mktValue": 18750.00,
  "avgCost": 175.32,
  "unrealizedPnl": 1218.00,
  "assetClass": "STK",
  ...
}

✅ SPIKE PASSED
```

**If the spike passes:** The field names match what the CSV generator expects. You're done. Run `node run.js` for a CSV or `node run.js --monitor` for live alerts.

**If the spike fails:** See Troubleshooting below.

### Step 5: Generate CSV

```bash
node run.js
# → Writes output/U12781141_LIVE_20260225.csv
# → Upload to Sentinel dashboard
```

### Step 6: Start Live Monitor

```bash
node run.js --monitor
```

Output (repeats every 60s):
```
🎯 Live Position Monitor started
   Polling every 60s
   Close targets: 90% (≤0 DTE), 85% (≤1 DTE), 80% (≤2 DTE)

[14:30:15] ── Position Summary ──────────────────────
Symbol                    Qty    Cost     Now     P%  DTE  Tgt    Status
─────────────────────────────────────────────────────────────────────────
AMD 27FEB26 192.5 P         8    2.28    0.45  80.3%    2  80%  🟢 CLOSE
LRCX 27FEB26 207.5 P       14    1.59    0.77  51.6%    2  80%
MRNA 27FEB26 44.5 P        40    0.37    0.25  34.4%    2  80%

🔔 ═══ CLOSE ALERTS ═══════════════════════════════
   🟢 AMD 27FEB26 192.5 P: 80.3% profit (target: 80%) — 2 DTE
      Action: BUY TO CLOSE 8x at ~$0.45
═══════════════════════════════════════════════════
```

Press `Ctrl+C` to stop.

## File Reference

| File | Purpose | Lines |
|------|---------|-------|
| `run.js` | Entry point — 3 modes: spike, csv, monitor | ~130 |
| `ibkr-api.js` | API client: auth, keepalive, positions, prices, trades | ~180 |
| `ibkr-to-csv.js` | Transforms API data → Activity Statement CSV | ~250 |
| `live-monitor.js` | Price polling + close target alerts | ~230 |
| `config.js` | Account, thresholds, ladder, prior NAV | ~60 |

**Total: ~850 lines. No dependencies (Node.js stdlib only).**

## Spike Validation Checklist

After running `node run.js --spike`, verify these fields exist in the sample position:

| CSV Column | API Field | Critical? |
|-----------|-----------|-----------|
| Symbol | `contractDesc` or `ticker` | ✅ Yes |
| Quantity | `position` | ✅ Yes |
| Cost Price | `avgCost` | ✅ Yes |
| Close Price | `mktPrice` | ✅ Yes |
| Value | `mktValue` | ✅ Yes |
| Unrealized P/L | `unrealizedPnl` | ✅ Yes |
| Asset Class | `assetClass` (`STK`/`OPT`) | ✅ Yes |
| Contract ID | `conid` | ✅ Yes (for live prices) |
| Strike | `strike` | For options |
| Expiry | `expiry` | For options |
| Put/Call | `putOrCall` | For options |

If any ✅ field is missing or named differently, the CSV generator mapping needs a one-line fix in `ibkr-to-csv.js`.

## Configuration

Edit `config.js` before running:

1. **`accountId`**: Your IBKR account (already set to `U12781141`)
2. **`priorNav`**: Update after each weekly CSV upload (for accurate Change in NAV)
3. **`sentinel`**: Matches your dashboard thresholds
4. **`closeTargets`**: DTE-based ladder from v3 plan

## Troubleshooting

### "ECONNREFUSED"
Gateway isn't running. Start it:
```bash
cd ~/clientportal.gw && bin/run.sh root/conf.yaml
```

### "Authentication timeout"
1. Open `https://localhost:5000` in browser
2. Accept self-signed cert
3. Log in with IBKR credentials
4. Re-run the script

### "HTTP 401" after working
Session expired. The keepalive usually prevents this, but if idle too long:
```bash
# Re-authenticate in browser, then re-run
```

### Gateway won't start (Java error)
Requires Java 11+. Check:
```bash
java -version
# If missing: brew install openjdk@11
```

### Positions show 0 mktPrice
First market data call initiates subscription. The script handles this by calling twice with a delay. If prices are still 0, increase the delay in `ibkr-api.js` `getMarketData()` from 1500ms to 3000ms.

### CSV doesn't match manual download exactly
The generated CSV covers: Statement, Account Info, NAV, Change in NAV, Open Positions, Trades. It does NOT generate: Realized & Unrealized Performance Summary (complex multi-period calculation), Interest, Fees, Transfers. These sections aren't needed for the dashboard's core functionality (positions, profit %, cushion, exposure).

## Fallback Plan

If the Client Portal Gateway proves unreliable (from v3 plan):

> If the API session management proves unreliable after a real attempt, fall back to more frequent CSV pulls (daily instead of weekly) and accept the T+1 lag.

**Flex Query alternative:** IBKR can email automated Activity Statement CSVs daily. Same T+1 lag but zero manual download. Set up at:
Account Management → Reports → Flex Queries → Create

## What's NOT Built (v2 deferred)

- ❌ Automated trade execution (Phase 7 in v5 plan)
- ❌ SMS/push notifications (trivial add-on once monitor works)
- ❌ Web UI for monitor output (console is fine for now)
- ❌ Historical trade import via API (CSV upload handles this)
