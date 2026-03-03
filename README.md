# Sentinel

Wheel-strategy trading dashboard and IBKR API integration.

## Quick Start

```bash
# Clone and setup
git clone https://github.com/lunaman81/sentinel.git
cd sentinel
bash setup.sh
```

`setup.sh` checks prerequisites, installs the pre-push QA hook, and installs npm dependencies.

## Prerequisites

- **Node.js** v20+ (`brew install node`)
- **Java 21** (`brew install openjdk@21`) — for IBKR Client Portal Gateway
- **IBKR Client Portal Gateway** — download from IBKR, extract to `~/Downloads/clientportal.gw/`

## Usage

### 1. Start the Gateway

```bash
cd ~/Downloads/clientportal.gw
bin/run.sh root/conf.yaml
```

Authenticate at `https://localhost:5001` in your browser.

### 2. Run Spike Test

```bash
cd ibkr-api-integration
node run.js --spike
```

Validates API connectivity and dumps position data.

### 3. Generate Live CSV

```bash
cd ibkr-api-integration
node run.js
```

Outputs an IBKR Activity Statement CSV to `ibkr-api-integration/output/`.

### 4. Open Dashboard

Open `wheel-dashboard.html` in a browser and load the generated CSV.

## Pre-Push QA Hook

The `setup.sh` script installs a git pre-push hook that runs `dashboard-qa.js` against the baseline CSV before every push. If the QA script detects dashboard bugs, the push is blocked.

To manually run the QA check:

```bash
node dashboard-qa.js ibkr-api-integration/real_ibkr_baseline.csv
```

## Project Structure

```
sentinel/
  wheel-dashboard.html    # Trading dashboard (load CSV to view)
  dashboard-qa.js         # QA script — validates CSV/dashboard compatibility
  setup.sh                # Setup script — installs hooks and deps
  ibkr-api-integration/
    config.js             # API config (account, port, thresholds)
    ibkr-api.js           # IBKR Client Portal API client
    ibkr-to-csv.js        # Converts API data to Activity Statement CSV
    run.js                # Runner (--spike for test, default for CSV gen)
    validate.js           # Validation suite (structure, penny-exact)
    real_ibkr_baseline.csv # Baseline CSV for validation
```
