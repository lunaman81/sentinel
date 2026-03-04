#!/usr/bin/env node
/**
 * push-wrapper.js — Enforced QA → changelog → tag → push sequence
 *
 * Shared by --push and --live modes. No way to skip steps.
 *
 * Sequence:
 *   1. Run dashboard-qa.js — abort if any check fails, log failure
 *   2. Generate version tag: v[YYYY-MM-DD-HHMM]
 *   3. Append to CHANGELOG.md: tag, timestamp, mode, QA result, NAV, positions, trades, errors
 *   4. Git commit using the changelog entry as the message
 *   5. Git tag the commit
 *   6. Git push including tags
 *   7. Append success/failure to run.log
 *
 * Usage:
 *   const { pushWithQA } = require('./push-wrapper');
 *   await pushWithQA({ mode: 'flex' | 'live', errors: [] });
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SENTINEL_DIR = path.resolve(__dirname, '..');
const LATEST_CSV = path.join(SENTINEL_DIR, 'latest.csv');
const CHANGELOG = path.join(SENTINEL_DIR, 'CHANGELOG.md');
const RUN_LOG = path.join(SENTINEL_DIR, 'run.log');
const QA_SCRIPT = path.join(SENTINEL_DIR, 'dashboard-qa.js');

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function versionTag() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `v${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function appendLog(line) {
  fs.appendFileSync(RUN_LOG, line + '\n');
}

function extractMetrics(qaOutput) {
  const nav = qaOutput.match(/NAV:\s+\$([\d,.]+)/)?.[1] || '?';
  const stocks = qaOutput.match(/Stocks:\s+(\d+)/)?.[1] || '0';
  const options = qaOutput.match(/Options:\s+(\d+)/)?.[1] || '0';
  const trades = qaOutput.match(/Trades:\s+(\d+)/)?.[1] || '0';
  const realPL = qaOutput.match(/Realized P&L:\s+\$([\d,.+-]+)/)?.[1] || '?';
  return { nav, stocks, options, trades, realPL, positions: `${stocks} stocks, ${options} options` };
}

/**
 * @param {Object} opts
 * @param {string} opts.mode - 'flex' or 'live'
 * @param {string[]} [opts.errors] - any errors from earlier steps
 * @returns {{ success: boolean, tag: string }} - whether push succeeded and the version tag
 */
async function pushWithQA({ mode, errors = [] }) {
  const ts = timestamp();
  const tag = versionTag();

  console.log(`\n═══ PUSH WRAPPER: ${tag} [${mode}] ═══`);

  // ── Step 1: Run QA ──────────────────────────────────────────
  console.log('  1. Running dashboard QA...');
  let qaOutput = '';
  let qaPass = false;
  try {
    qaOutput = execSync(`node "${QA_SCRIPT}" latest.csv`, {
      cwd: SENTINEL_DIR,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    qaPass = true;
    console.log('     QA: PASS');
  } catch (err) {
    qaOutput = (err.stdout || '') + (err.stderr || '');
    qaPass = false;
    console.error('     QA: FAIL');
    appendLog(`[${ts}] ${tag} ${mode} QA FAILED — push aborted`);
    appendLog(`  ${qaOutput.split('\n').filter(l => l.includes('FAIL')).join('\n  ')}`);
    console.error('❌ QA failed. Push aborted. See run.log for details.');
    return { success: false, tag };
  }

  const metrics = extractMetrics(qaOutput);

  // ── Step 2: Version tag (already generated) ─────────────────
  console.log(`  2. Version: ${tag}`);

  // ── Step 3: Append to CHANGELOG.md ──────────────────────────
  console.log('  3. Updating CHANGELOG.md...');
  const errSummary = errors.length > 0 ? `\n- Errors: ${errors.join('; ')}` : '';
  const entry = [
    `## ${tag}`,
    `- **Timestamp:** ${ts}`,
    `- **Mode:** ${mode}`,
    `- **QA:** PASS`,
    `- **NAV:** $${metrics.nav}`,
    `- **Positions:** ${metrics.positions}`,
    `- **Closed Trades:** ${metrics.trades}`,
    `- **Realized P&L:** $${metrics.realPL}`,
    errSummary ? `- **Errors:** ${errors.join('; ')}` : null,
    '',
  ].filter(l => l !== null).join('\n');

  // Create or prepend to CHANGELOG.md
  if (fs.existsSync(CHANGELOG)) {
    const existing = fs.readFileSync(CHANGELOG, 'utf-8');
    // Insert after the title line
    const titleEnd = existing.indexOf('\n');
    if (titleEnd >= 0 && existing.startsWith('# ')) {
      const title = existing.slice(0, titleEnd + 1);
      const rest = existing.slice(titleEnd + 1);
      fs.writeFileSync(CHANGELOG, title + '\n' + entry + '\n' + rest);
    } else {
      fs.writeFileSync(CHANGELOG, '# Sentinel Changelog\n\n' + entry + '\n' + existing);
    }
  } else {
    fs.writeFileSync(CHANGELOG, '# Sentinel Changelog\n\n' + entry);
  }

  // ── Step 4: Git commit ──────────────────────────────────────
  console.log('  4. Committing...');
  const commitMsg = `${tag} [${mode}] NAV=$${metrics.nav} pos=${metrics.positions} trades=${metrics.trades}`;
  try {
    execSync('git add latest.csv CHANGELOG.md', { cwd: SENTINEL_DIR, stdio: 'pipe' });
    execSync(`git commit -m "${commitMsg}"`, { cwd: SENTINEL_DIR, stdio: 'pipe' });
  } catch (err) {
    if (err.stderr && err.stderr.toString().includes('nothing to commit')) {
      console.log('     No changes to commit (data unchanged).');
      appendLog(`[${ts}] ${tag} ${mode} no changes to commit`);
      return { success: true, tag };
    }
    appendLog(`[${ts}] ${tag} ${mode} COMMIT FAILED: ${err.message}`);
    console.error(`❌ Git commit failed: ${err.message}`);
    return { success: false, tag };
  }

  // ── Step 5: Git tag ─────────────────────────────────────────
  console.log(`  5. Tagging: ${tag}`);
  try {
    execSync(`git tag ${tag}`, { cwd: SENTINEL_DIR, stdio: 'pipe' });
  } catch (err) {
    // Tag may already exist if re-running in same minute
    console.log(`     Tag ${tag} already exists, skipping.`);
  }

  // ── Step 6: Git push with tags ──────────────────────────────
  console.log('  6. Pushing...');
  try {
    execSync('git push origin main --tags', { cwd: SENTINEL_DIR, stdio: 'pipe' });
    console.log(`     Pushed: ${commitMsg}`);
  } catch (err) {
    appendLog(`[${ts}] ${tag} ${mode} PUSH FAILED: ${err.message}`);
    console.error(`❌ Git push failed: ${err.message}`);
    return { success: false, tag };
  }

  // ── Step 7: Log success ─────────────────────────────────────
  appendLog(`[${ts}] ${tag} ${mode} OK — NAV=$${metrics.nav} pos=${metrics.positions} trades=${metrics.trades}`);
  console.log(`✅ ${tag} pushed successfully`);
  console.log(`═══════════════════════════════════════════════\n`);

  return { success: true, tag };
}

module.exports = { pushWithQA };
