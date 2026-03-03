# Options Tracker Automation Plan (v10)

**Updated:** March 3, 2026
**Status:** Phase 3 complete. Auto-load dashboard shipped. Flex Query needed for full automation.

---

## Completed Work Log

| Session | Date | What | Impact |
|---------|------|------|--------|
| 1 | Feb 19 | CSV parser, equity table, options table, metrics bar | Dashboard MVP |
| 2 | Feb 19 | Wheel-adjusted cost basis, rolling calculator, exposure alerts | Core Sentinel |
| 3 | Feb 23 | 2025 analysis (7 rules), rules reference, spec frozen | Data-backed guardrails |
| 4 | Feb 23 | Performance tab, outcome analysis, UI consolidation | Industry metrics |
| 5 | Feb 24 | Deployment 55 to 85%, staleness banner, CSV validation | Fixed ignored warning |
| 6 | Feb 24 | Rebuild without Recharts (861 to 374 lines), pure CSS charts | Zero dependencies |
| 7 | Feb 26 | Light theme, NAV/Cash column fix, expiry column, no welcome screen | 367 lines, GitHub Pages |
| 8 | Feb 26 | IBKR API scaffold (1,294 lines, 5 files) | Ready for spike |
| 9 | Mar 3 AM | **API integration live.** Gateway auth, spike, 7 fixes, penny-exact validation | Live data pipeline |
| 10 | Mar 3 PM | 3 dashboard bugs fixed (deposits, realized P&L, holding-without-CC). QA v2 script, pre-push hook, setup.sh, auto-load from GitHub. Discovered API cannot replace Activity Statement. | QA enforced, cross-device dashboard |

### Session 9 Details (March 3, 2026)

**Setup completed:**
- Node.js v25.7.0, OpenJDK 21.0.10 installed
- Client Portal Gateway on port 5001 (AirPlay blocked 5000)
- Integration files deployed to ~/sentinel/ibkr-api-integration/

**Spike findings + fixes (all applied by Claude Code):**
1. Gateway requires /v1/api prefix on all endpoints
2. Gateway requires User-Agent header
3. Auth status check must be GET not POST
4. Option symbols come as bracket format — parser converts to dashboard format
5. Option cost uses avgPrice (per-share) not avgCost (per-contract)
6. Integer strikes formatted with .0 suffix — fixed to match IBKR CSV
7. Unrealized Change hardcoded to $0 — now sums unrealizedPnl from positions

**Validation results:**
- Structure: 8 passed, 1 warning
- Dashboard Compatibility: 10/10 passed
- Penny-Exact: All 3 stock + all 9 option positions exact on cost fields

**Known limitations:**
- Realized P&L = $0 (API only provides on closing trades, use manual Activity Statement)
- Cushion = dash (needs underlying price for tickers without stock positions)

**Committed:** 54d8f6a — 18 files, 4,482 insertions

### Session 10 Details (March 3, 2026 PM)

**Dashboard bugs found and fixed:**
1. Deposits showed $0 — column index shift (Account field not accounted for)
2. Realized P&L showed $0 — "Realized P/L" row doesn't exist in Change in NAV section. Fixed to read from Realized & Unrealized Performance Summary "Total (All Assets)" row
3. Unrealized Chg showed $0 — same root cause as #2
4. EOSE missing from Holding Without CC — checked historical CC credits instead of open CC positions

**Infrastructure shipped:**
- dashboard-qa.js v2 (matches fixed dashboard logic, zero false positives, exit codes for hooks)
- Pre-push git hook (auto-runs QA, blocks push on failure)
- setup.sh (one-command hook installation, portable across machines)
- Auto-load from GitHub (index.html fetches latest.csv from raw.githubusercontent.com on page load)
- run.js --push flag (copies CSV to repo root, commits, pushes)

**Key discovery:** Client Portal API only provides live positions/NAV. Does NOT provide trade history, realized P&L, performance summary, or deposits. Cannot replace the Activity Statement for dashboard Performance tab. Flex Query API is the correct automation path.

**Commits:** 5c778dd (bug fixes + QA), 13e3436 (setup.sh), ac5b892 (auto-load + --push)

---

## Current Workflow (post-Session 10)

| Step | What | Time |
|------|------|------|
| 1 | Download Activity Statement from IBKR web portal | 1 min |
| 2 | Save to ~/sentinel/ibkr-api-integration/real_ibkr_baseline.csv | 15 sec |
| 3 | Run: cd ~/sentinel/ibkr-api-integration && node run.js --push | 30 sec |
| 4 | Open lunaman81.github.io/sentinel on any device — auto-loads | 5-10 min |

**Total: ~7-12 min** (down from 1-1.5 hrs/week pre-dashboard)
**After Flex Query (Phase 4):** Steps 1-2 eliminated. Just run --push.

---

## Phase 4: Full Automation via Flex Query (Next Build)

**Problem discovered:** Client Portal API only has live positions/NAV. No trade history, performance, deposits, or realized P&L. Dashboard Performance tab is blank with API-generated CSV. Merging API + Activity Statement creates franken-CSV with inconsistencies.

**Solution:** IBKR Flex Query API delivers the full Activity Statement via REST call. No gateway, no browser auth, no manual download. Set up once, automate forever.

| Data | Source | Freshness |
|------|--------|-----------|
| Full dashboard (all tabs) | Flex Query API | Positions: today. Trades: T+1 |
| Live price alerts | Client Portal API (already built) | Real-time |

### Step 1: Flex Query Setup (~1 hr)
1. Create Flex Query in IBKR Account Management (5 min, browser)
2. Replace run.js --push internals to call Flex Query API
3. Auto-generates full Activity Statement, saves as latest.csv, pushes to GitHub
4. Dashboard auto-loads on any device with all tabs working

### Step 2: Auto-Sync on Interval (~30 min)
Cron/launchd runs run.js --push every morning. Dashboard always current.

### Step 3: Live Price Alerts (~2.5 hrs)
Client Portal API monitors positions for 80% profit targets. Sends push notification when close target hit. Requires gateway running (Mac only).

### What we built that still has value:
- Client Portal API integration: validated, penny-exact. Use for real-time alerts (Step 3)
- Auto-load dashboard from GitHub: shipped, works on any device
- Pre-push QA hook: enforces correctness on every push
- dashboard-qa.js v2: matches fixed dashboard logic, zero false positives

### What we learned:
- Client Portal API is great for live data, bad for reporting
- Flex Query is the right tool for full Activity Statement automation
- Should have validated "does the API CSV populate ALL dashboard tabs" during spike
- Added to QA checklist: validate all tabs, not just Positions

---

## Phase 5: Feature Backlog (Not Prioritized)

| Feature | Status | Notes |
|---------|--------|-------|
| Close notifications (SMS/push) | Deferred | After monitor validated |
| Drawdown protection / dynamic cap | Deferred | Needs design decision, May review |
| Order execution via API | Deferred | Highest risk, needs stable API first |
| Realized P&L from API | Blocked | API limitation, revisit with Flex Query |
| Cushion calculation | Blocked | Needs underlying price data |
| Kill Google Sheet | Ready | Dashboard + API covers everything |

---

## Explicitly Not Building

- Manual trade entry form (dual source of truth)
- Discord to IBKR pipeline (signal provider may change)
- Mobile responsive (trade at desk)
- AI trade suggestions (Sentinel = guardrails not signals)
- IV/Greeks modeling (complexity without improving core decision)

---

## Sentinel Rules (Frozen Feb 23, 2026)

| # | Rule | Threshold |
|---|------|-----------|
| 1 | Max per-ticker exposure | 10% target / 12% hard cap |
| 2 | Max deployment | 85% NAV |
| 3 | Max rolls per ticker | 3 (Tier 1 exception) |
| 4 | No calls below breakeven | Absolute |
| 5 | Tier 3 blacklist | 10 tickers |
| 6 | Profit target | 80% general, 0 DTE 90% |
| 7 | Min cushion at entry | 5% default |

**Next review:** May 2026 (quarterly)
