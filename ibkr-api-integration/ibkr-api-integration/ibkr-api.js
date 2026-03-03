/**
 * IBKR Client Portal API Client
 * 
 * Connects to the IBKR Client Portal Gateway running locally.
 * Gateway must be started first (see README.md).
 * 
 * Endpoints used:
 *   Auth:      POST /iserver/auth/ssodh/init, GET /iserver/auth/status
 *   Keepalive: POST /tickle
 *   Account:   GET /portfolio/accounts, GET /portfolio/{id}/summary
 *   Positions: GET /portfolio/{id}/positions/0
 *   Prices:    GET /iserver/marketdata/snapshot?conids=X&fields=Y
 *   Trades:    GET /iserver/account/trades
 */

const https = require('https');
const http = require('http');

class IBKRApi {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || 'https://localhost:5000';
    this.accountId = config.accountId || null;
    this.useSSL = this.baseUrl.startsWith('https');
    this.keepaliveInterval = config.keepaliveMs || 55_000; // 55s (session times out at 60s)
    this._keepaliveTimer = null;
    this._authenticated = false;

    // IBKR gateway uses self-signed cert
    this.agent = this.useSSL
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined;
  }

  // ── HTTP primitives ──────────────────────────────────────────────

  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const lib = this.useSSL ? https : http;

      const opts = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/json' },
        agent: this.agent,
      };

      const req = lib.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            } else {
              resolve(parsed);
            }
          } catch {
            // Some endpoints return non-JSON (e.g. plain text)
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            } else {
              resolve(data);
            }
          }
        });
      });

      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          reject(new Error(`ECONNREFUSED — Is the gateway running? (${this.baseUrl})`));
        } else {
          reject(err);
        }
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  get(path) { return this._request('GET', path); }
  post(path, body) { return this._request('POST', path, body); }

  // ── Authentication ───────────────────────────────────────────────

  async checkAuth() {
    const status = await this.post('/iserver/auth/status');
    this._authenticated = status.authenticated === true;
    return status;
  }

  async reauthenticate() {
    const result = await this.post('/iserver/reauthenticate');
    // After reauth, verify status
    await this._sleep(2000);
    return this.checkAuth();
  }

  async waitForAuth(maxWaitMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const status = await this.checkAuth();
      if (status.authenticated) {
        console.log('✅ Authenticated to IBKR');
        return true;
      }
      console.log('⏳ Waiting for authentication...');
      await this._sleep(2000);
    }
    throw new Error('Authentication timeout. Complete login in browser at https://localhost:5000');
  }

  // ── Session keepalive ────────────────────────────────────────────

  async tickle() {
    return this.post('/tickle');
  }

  startKeepalive() {
    if (this._keepaliveTimer) return;
    this._keepaliveTimer = setInterval(async () => {
      try {
        await this.tickle();
      } catch (e) {
        console.warn('⚠️  Keepalive failed:', e.message);
        // Try reauthenticate
        try { await this.reauthenticate(); } catch {}
      }
    }, this.keepaliveInterval);
    console.log(`🔄 Keepalive started (every ${this.keepaliveInterval / 1000}s)`);
  }

  stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  // ── Account ──────────────────────────────────────────────────────

  async getAccounts() {
    const accounts = await this.get('/portfolio/accounts');
    if (!Array.isArray(accounts)) {
      throw new Error(`Unexpected accounts response: ${JSON.stringify(accounts)}`);
    }
    if (accounts.length > 0 && !this.accountId) {
      this.accountId = accounts[0].accountId;
      console.log(`📋 Using account: ${this.accountId}`);
    }
    return accounts;
  }

  async getAccountSummary() {
    this._requireAccount();
    return this.get(`/portfolio/${this.accountId}/summary`);
  }

  async getAccountLedger() {
    this._requireAccount();
    return this.get(`/portfolio/${this.accountId}/ledger`);
  }

  // ── Positions ────────────────────────────────────────────────────

  async getPositions(pageId = 0) {
    this._requireAccount();
    const positions = await this.get(`/portfolio/${this.accountId}/positions/${pageId}`);
    // API returns up to 30 positions per page. Fetch all pages.
    if (Array.isArray(positions) && positions.length === 30) {
      const nextPage = await this.getPositions(pageId + 1);
      return [...positions, ...nextPage];
    }
    return Array.isArray(positions) ? positions : [];
  }

  // ── Market Data (live prices) ────────────────────────────────────

  /**
   * Get live market data snapshots.
   * @param {number[]} conids - Contract IDs
   * @param {string[]} fields - Field codes (see FIELD_MAP below)
   * @returns {Object[]} Array of snapshot objects
   * 
   * IMPORTANT: First call initiates subscription. Data may not be ready.
   * Call twice with a 1-2s gap for reliable data.
   */
  async getMarketData(conids, fields = ['31', '84', '86']) {
    if (!conids.length) return [];
    const fieldStr = fields.join(',');

    // IBKR limits ~100 conids per snapshot request. Batch if needed.
    const BATCH_SIZE = 50;
    const allSnapshots = [];

    for (let i = 0; i < conids.length; i += BATCH_SIZE) {
      const batch = conids.slice(i, i + BATCH_SIZE);
      const conidStr = batch.join(',');

      // First call subscribes
      await this.get(`/iserver/marketdata/snapshot?conids=${conidStr}&fields=${fieldStr}`);
      await this._sleep(1500);
      // Second call gets data
      const result = await this.get(`/iserver/marketdata/snapshot?conids=${conidStr}&fields=${fieldStr}`);
      if (Array.isArray(result)) {
        allSnapshots.push(...result);
      }
    }

    return allSnapshots;
  }

  /**
   * Unsubscribe from market data to free resources
   */
  async unsubscribeAll() {
    return this.get('/iserver/marketdata/unsubscribeall');
  }

  // ── Trades ───────────────────────────────────────────────────────

  async getTrades() {
    return this.get('/iserver/account/trades');
  }

  // ── Contract lookup ──────────────────────────────────────────────

  async searchContract(symbol) {
    return this.get(`/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`);
  }

  async getContractInfo(conid) {
    return this.get(`/iserver/contract/${conid}/info`);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  _requireAccount() {
    if (!this.accountId) {
      throw new Error('No accountId set. Call getAccounts() first.');
    }
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  destroy() {
    this.stopKeepalive();
  }
}

// ── IBKR Market Data Field Codes ─────────────────────────────────
// Reference: https://ibkrcampus.com/ibkr-api-page/cpapi-v1/#/Market%20Data
const FIELD_MAP = {
  '31':  'lastPrice',
  '55':  'symbol',
  '70':  'high',
  '71':  'low',
  '73':  'marketValue',
  '78':  'openPrice',
  '82':  'change',
  '83':  'changePercent',
  '84':  'bidPrice',
  '85':  'askSize',
  '86':  'askPrice',
  '87':  'volume',
  '88':  'bidSize',
  '7051': 'companyName',
  '7284': 'impliedVol',
  '7285': 'putCallInterest',
  '7286': 'putCallVolume',
  '7287': 'histVolatility',
  '7288': 'optionImpliedVol',
  '7308': 'delta',
  '7309': 'gamma',
  '7310': 'theta',
  '7311': 'vega',
};

module.exports = { IBKRApi, FIELD_MAP };
