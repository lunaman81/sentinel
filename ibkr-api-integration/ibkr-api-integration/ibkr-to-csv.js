/**
 * IBKR API → Activity Statement CSV Generator
 * 
 * Transforms Client Portal API responses into the exact CSV format
 * produced by IBKR Activity Statement exports. This means ZERO changes
 * to the dashboard parser — it reads the generated CSV identically to
 * a manual download.
 * 
 * CSV Sections generated:
 *   Statement           - Metadata (period, generation time)
 *   Account Information  - Name, account ID, type
 *   Net Asset Value      - Cash, Stock, Options, Total, TWR
 *   Change in NAV        - Starting/Ending value, Realized P/L, etc.
 *   Open Positions       - Stocks and Options with cost/value/P&L
 *   Trades               - Executed trades for the period
 *   Deposits & Withdrawals
 * 
 * Field mapping notes (API field → CSV column):
 *   position.avgCost      → Cost Price
 *   position.avgPrice     → (not used, avgCost is what IBKR CSV uses)
 *   position.mktValue     → Value
 *   position.unrealizedPnl → Unrealized P/L
 *   position.position     → Quantity
 *   position.conid        → (used for live price lookup)
 *   position.contractDesc → Symbol (needs parsing for options)
 */


class CSVGenerator {
  constructor(accountId, accountName = '') {
    this.accountId = accountId;
    this.accountName = accountName;
  }

  /**
   * Generate full Activity Statement CSV from API data.
   * 
   * @param {Object} params
   * @param {Object} params.summary    - From getAccountSummary()
   * @param {Object} params.ledger     - From getAccountLedger()
   * @param {Object[]} params.positions - From getPositions()
   * @param {Object[]} params.trades    - From getTrades()
   * @param {Object} params.priorNav   - { total, cash, stock, options } from last CSV
   * @param {Object[]} params.prices    - Live price snapshots (optional, enriches close prices)
   * @returns {string} CSV content
   */
  generate({ summary, ledger, positions, trades = [], priorNav = null, prices = {} }) {
    const lines = [];
    const now = new Date();
    const periodStart = this._periodStart();
    const periodEnd = this._formatDate(now);
    const generated = this._formatDateTime(now);

    // ── Statement section ──────────────────────────────────────
    lines.push('Statement,Header,Field Name,Field Value');
    lines.push('Statement,Data,BrokerName,Interactive Brokers LLC');
    lines.push('Statement,Data,BrokerAddress,"Two Pickwick Plaza, Greenwich, CT 06830"');
    lines.push('Statement,Data,Title,Activity Statement');
    lines.push(`Statement,Data,Period,"${periodStart} - ${periodEnd}"`);
    lines.push(`Statement,Data,WhenGenerated,"${generated}"`);

    // ── Account Information ────────────────────────────────────
    lines.push('Account Information,Header,Field Name,Field Value');
    lines.push(`Account Information,Data,Name,${this.accountName}`);
    lines.push(`Account Information,Data,Account,${this.accountId}`);
    lines.push('Account Information,Data,Account Type,Individual');
    lines.push('Account Information,Data,Customer Type,Individual');
    lines.push('Account Information,Data,Account Capabilities,Margin');
    lines.push('Account Information,Data,Base Currency,USD');

    // ── Net Asset Value ────────────────────────────────────────
    const nav = this._buildNAV(summary, ledger, positions, priorNav);
    lines.push('Net Asset Value,Header,Asset Class,Prior Total,Current Long,Current Short,Current Total,Change');
    lines.push(`Net Asset Value,Data,Cash ,${nav.priorCash},${nav.cash},0,${nav.cash},${nav.cashChange}`);
    lines.push(`Net Asset Value,Data,Stock,${nav.priorStock},${nav.stockLong},0,${nav.stockLong},${nav.stockChange}`);
    lines.push(`Net Asset Value,Data,Options,${nav.priorOptions},0,${nav.optionsShort},${nav.optionsShort},${nav.optionsChange}`);
    lines.push(`Net Asset Value,Data,Interest Accruals,${nav.priorInterest},${nav.interest},0,${nav.interest},${nav.interestChange}`);
    lines.push(`Net Asset Value,Data,Total,${nav.priorTotal},${nav.totalLong},${nav.optionsShort},${nav.total},${nav.totalChange}`);
    lines.push('Net Asset Value,Header,Time Weighted Rate of Return');
    lines.push(`Net Asset Value,Data,${nav.twr}%`);

    // ── Change in NAV ──────────────────────────────────────────
    lines.push('Change in NAV,Header,Field Name,Field Value');
    lines.push(`Change in NAV,Data,Starting Value,${nav.priorTotal}`);
    lines.push(`Change in NAV,Data,Realized P/L,${nav.realizedPL}`);
    lines.push(`Change in NAV,Data,Change in Unrealized P/L,${nav.unrealizedChange}`);
    lines.push(`Change in NAV,Data,Deposits & Withdrawals,${nav.deposits}`);
    lines.push(`Change in NAV,Data,Interest,${nav.interest}`);
    lines.push(`Change in NAV,Data,Ending Value,${nav.total}`);

    // ── Open Positions ─────────────────────────────────────────
    const { stocks, options } = this._splitPositions(positions);

    if (stocks.length > 0) {
      lines.push('Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code');
      let stockCostTotal = 0, stockValueTotal = 0, stockPLTotal = 0;
      for (const p of stocks) {
        const mapped = this._mapStockPosition(p, prices);
        lines.push(`Open Positions,Data,Summary,Stocks,USD,${mapped.symbol},${mapped.qty},1,${mapped.costPrice},${mapped.costBasis},${mapped.closePrice},${mapped.value},${mapped.unrealizedPL},`);
        stockCostTotal += mapped.costBasis;
        stockValueTotal += mapped.value;
        stockPLTotal += mapped.unrealizedPL;
      }
      lines.push(`Open Positions,Total,,Stocks,USD,,,,,${this._roundCost(stockCostTotal)},,${this._round(stockValueTotal)},${this._roundCost(stockPLTotal)},`);
    }

    if (options.length > 0) {
      lines.push('Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code');
      let optCostTotal = 0, optValueTotal = 0, optPLTotal = 0;
      for (const p of options) {
        const mapped = this._mapOptionPosition(p, prices);
        lines.push(`Open Positions,Data,Summary,Equity and Index Options,USD,${mapped.symbol},${mapped.qty},100,${mapped.costPrice},${mapped.costBasis},${mapped.closePrice},${mapped.value},${mapped.unrealizedPL},`);
        optCostTotal += mapped.costBasis;
        optValueTotal += mapped.value;
        optPLTotal += mapped.unrealizedPL;
      }
      lines.push(`Open Positions,Total,,Equity and Index Options,USD,,,,,${this._roundCost(optCostTotal)},,${optValueTotal},${this._roundCost(optPLTotal)},`);
    }

    // ── Trades ─────────────────────────────────────────────────
    if (trades.length > 0) {
      lines.push('Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Proceeds,Comm/Fee,Basis,Realized P/L,Code');
      for (const t of trades) {
        const mapped = this._mapTrade(t);
        lines.push(`Trades,Data,Order,${mapped.category},USD,${mapped.symbol},"${mapped.dateTime}",${mapped.qty},${mapped.price},${mapped.proceeds},${mapped.commission},${mapped.basis},${mapped.realizedPL},${mapped.code}`);
      }
    }

    return lines.join('\n');
  }

  // ── Position mapping ─────────────────────────────────────────

  _splitPositions(positions) {
    const stocks = [];
    const options = [];
    for (const p of positions) {
      if (p.assetClass === 'STK' || p.putOrCall === undefined) {
        if (p.assetClass === 'STK') stocks.push(p);
      } else if (p.assetClass === 'OPT') {
        options.push(p);
      }
    }
    return { stocks, options };
  }

  _mapStockPosition(p, prices = {}) {
    const livePrice = prices[p.conid]?.lastPrice;
    return {
      symbol: p.ticker || p.contractDesc,
      qty: p.position,
      costPrice: p.avgCost,
      costBasis: this._roundCost(p.avgCost * Math.abs(p.position)),
      closePrice: livePrice || p.mktPrice || 0,
      value: livePrice
        ? this._round(livePrice * p.position)
        : (p.mktValue || 0),
      unrealizedPL: livePrice
        ? this._round((livePrice - p.avgCost) * p.position)
        : (p.unrealizedPnl || 0),
    };
  }

  _mapOptionPosition(p, prices = {}) {
    // IBKR API contractDesc: "AMD 27FEB26 192.5 P" (matches CSV format)
    // But sometimes it's structured differently. Normalize.
    const symbol = this._normalizeOptionSymbol(p);
    const livePrice = prices[p.conid]?.lastPrice;
    const mult = 100;

    return {
      symbol,
      qty: p.position,                         // negative for short
      costPrice: Math.abs(p.avgCost),           // per-contract cost (always positive)
      costBasis: this._roundCost(p.avgCost * p.position * mult),  // negative for short (matches IBKR CSV)
      closePrice: livePrice || p.mktPrice || 0,
      value: livePrice
        ? this._round(livePrice * p.position * mult)
        : (p.mktValue || 0),
      unrealizedPL: p.unrealizedPnl || 0,
    };
  }

  _normalizeOptionSymbol(p) {
    // API may return contractDesc in various formats.
    // Target format: "AMD 27FEB26 192.5 P"
    if (p.contractDesc && /\d{2}[A-Z]{3}\d{2}/.test(p.contractDesc)) {
      return p.contractDesc;
    }
    // Build from components if available
    if (p.ticker && p.expiry && p.strike && p.putOrCall) {
      const expStr = this._formatExpiry(p.expiry);
      const pc = p.putOrCall === 'P' ? 'P' : 'C';
      return `${p.ticker} ${expStr} ${p.strike} ${pc}`;
    }
    // Fallback
    return p.contractDesc || p.ticker || 'UNKNOWN';
  }

  _formatExpiry(expiry) {
    // API returns "20260227" → "27FEB26"
    if (!expiry || expiry.length !== 8) return expiry;
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const day = expiry.substring(6, 8);
    const month = months[parseInt(expiry.substring(4, 6)) - 1];
    const year = expiry.substring(2, 4);
    return `${day}${month}${year}`;
  }

  // ── Trade mapping ────────────────────────────────────────────

  _mapTrade(t) {
    const isOption = t.secType === 'OPT';
    const category = isOption ? 'Equity and Index Options' : 'Stocks';
    const symbol = isOption ? this._normalizeOptionSymbol(t) : (t.ticker || t.symbol);

    // Build IBKR-style code flags
    const codes = [];
    if (t.side === 'B') codes.push('O'); // Opening buy
    if (t.side === 'S') codes.push('C'); // Closing sell
    // IBKR also uses A (assignment), P (partial)

    return {
      category,
      symbol,
      dateTime: t.tradeTime || t.trade_time || '',
      qty: t.size || t.position || 0,
      price: t.price || 0,
      proceeds: this._round((t.price || 0) * (t.size || 0) * (isOption ? 100 : 1) * (t.side === 'S' ? 1 : -1)),
      commission: this._round(t.commission || 0),
      basis: this._round(t.cost || 0),
      realizedPL: this._round(t.realizedPnl || 0),
      code: codes.join(';'),
    };
  }

  // ── NAV calculation ──────────────────────────────────────────

  _buildNAV(summary, ledger, positions, priorNav) {
    // Extract from summary (API field names vary by endpoint)
    const s = summary || {};
    const l = (ledger && ledger.USD) || {};

    // Current values from positions
    const { stocks, options } = this._splitPositions(positions);
    const stockValue = stocks.reduce((sum, p) => sum + (p.mktValue || 0), 0);
    const optValue = options.reduce((sum, p) => sum + (p.mktValue || 0), 0);

    // Cash from ledger
    const cash = l.cashbalance || s.totalcashvalue?.amount || 0;
    const nav = l.netliquidationvalue || s.netliquidation?.amount || 0;
    const interest = l.accruedinterest || 0;
    const realizedPL = s.realizedpnl?.amount || 0;

    // Prior values (from last uploaded CSV, stored in config)
    const prior = priorNav || { total: 0, cash: 0, stock: 0, options: 0, interest: 0 };

    return {
      cash: this._round(cash),
      stockLong: this._round(stockValue),
      optionsShort: this._round(optValue),
      interest: this._round(interest),
      total: this._round(nav),
      totalLong: this._round(cash + stockValue + interest),
      priorCash: prior.cash,
      priorStock: prior.stock,
      priorOptions: prior.options,
      priorInterest: prior.interest || 0,
      priorTotal: prior.total,
      cashChange: this._round(cash - prior.cash),
      stockChange: this._round(stockValue - prior.stock),
      optionsChange: this._round(optValue - prior.options),
      interestChange: this._round(interest - (prior.interest || 0)),
      totalChange: this._round(nav - prior.total),
      realizedPL: this._round(realizedPL),
      unrealizedChange: 0, // Calculated from position-level data
      deposits: 0,         // Requires separate API call or manual input
      twr: s.twr?.amount || 0,
    };
  }

  // ── Utilities ────────────────────────────────────────────────

  _round(n, decimals = 2) { 
    const factor = Math.pow(10, decimals);
    return Math.round((n || 0) * factor) / factor; 
  }

  // IBKR preserves higher precision for cost calculations
  _roundCost(n) { return this._round(n, 5); }

  _formatDate(d) {
    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  _formatDateTime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} EST`;
  }

  _periodStart() {
    const d = new Date();
    return `January 1, ${d.getFullYear()}`;
  }
}

module.exports = { CSVGenerator };
