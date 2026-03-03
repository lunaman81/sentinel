#!/usr/bin/env node
/**
 * flex-fetch.js — Download IBKR Flex Query Activity Statement CSV
 *
 * Reads token and queryId from ~/.sentinel-flex-config.json
 * Calls the IBKR Flex Web Service API to request and download a report.
 *
 * Usage: node flex-fetch.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Read config
const configPath = path.join(require('os').homedir(), '.sentinel-flex-config.json');
if (!fs.existsSync(configPath)) {
  console.error(`❌ Config not found: ${configPath}`);
  console.error('Create it with: {"token":"YOUR_TOKEN","queryId":"YOUR_QUERY_ID"}');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const { token, queryId } = config;

if (!token || token === 'YOUR_TOKEN' || !queryId || queryId === 'YOUR_QUERY_ID') {
  console.error('❌ Please set your real token and queryId in ~/.sentinel-flex-config.json');
  process.exit(1);
}

const OUTPUT_PATH = path.join(__dirname, 'flex-raw-latest.csv');
const USER_AGENT = 'Sentinel/1.0';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function parseXmlTag(xml, tag) {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1] : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  // Step 1: Send request to get reference code
  console.log('📡 Requesting Flex Query report from IBKR...');
  const sendUrl = `https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t=${token}&q=${queryId}&v=3`;

  const sendRes = await httpsGet(sendUrl);

  const status = parseXmlTag(sendRes.body, 'Status');
  const referenceCode = parseXmlTag(sendRes.body, 'ReferenceCode');
  const errorCode = parseXmlTag(sendRes.body, 'ErrorCode');
  const errorMessage = parseXmlTag(sendRes.body, 'ErrorMessage');

  if (status !== 'Success') {
    console.error(`❌ Flex Query request failed:`);
    console.error(`   Status: ${status}`);
    console.error(`   ErrorCode: ${errorCode}`);
    console.error(`   ErrorMessage: ${errorMessage}`);
    console.error(`   Full response: ${sendRes.body}`);
    process.exit(1);
  }

  console.log(`✅ Request accepted. Reference code: ${referenceCode}`);

  // Step 2: Wait for report generation
  console.log('⏳ Waiting 10 seconds for report generation...');
  await sleep(10000);

  // Step 3: Fetch the statement
  const getUrl = `https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement?t=${token}&q=${referenceCode}&v=3`;

  let csvContent = null;
  const maxRetries = 5;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`📥 Fetching statement (attempt ${attempt}/${maxRetries})...`);
    const getRes = await httpsGet(getUrl);

    // Check if still generating (XML response with error code 1019)
    if (getRes.body.includes('<FlexStatementResponse') && getRes.body.includes('1019')) {
      console.log('   Still generating, waiting 10 more seconds...');
      await sleep(10000);
      continue;
    }

    // Check for other XML errors
    if (getRes.body.includes('<FlexStatementResponse') && getRes.body.includes('<ErrorCode>')) {
      const ec = parseXmlTag(getRes.body, 'ErrorCode');
      const em = parseXmlTag(getRes.body, 'ErrorMessage');
      console.error(`❌ GetStatement error: ${ec} — ${em}`);
      process.exit(1);
    }

    // Success — body is the CSV content
    csvContent = getRes.body;
    break;
  }

  if (!csvContent) {
    console.error('❌ Failed to retrieve statement after all retries');
    process.exit(1);
  }

  // Step 4: Save to file
  fs.writeFileSync(OUTPUT_PATH, csvContent);
  const size = (Buffer.byteLength(csvContent) / 1024).toFixed(1);
  console.log(`\n✅ Flex Query CSV saved: ${OUTPUT_PATH} (${size} KB)`);
}

main().catch(err => {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
});
