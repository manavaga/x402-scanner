#!/usr/bin/env node
/**
 * x402 Scanner - Daily Data Update Script
 *
 * Fetches live data from x402scan.com, x402list.fun, and public APIs,
 * then injects updated stats into the dashboard HTML files.
 *
 * Run: node scripts/update-data.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Helpers ───────────────────────────────────────────────

function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : require('http');
    client.get(url, { headers: { 'User-Agent': 'x402-scanner/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function extractNumber(html, pattern) {
  const match = html.match(pattern);
  return match ? match[1] : null;
}

function formatDate() {
  return new Date().toISOString().split('T')[0];
}

// ─── Data Sources ──────────────────────────────────────────

async function fetchX402ScanData() {
  console.log('[1/4] Fetching x402scan.com...');
  try {
    const { body } = await fetch('https://www.x402scan.com/');
    // Extract any server-rendered stats from the page source
    // x402scan is a Next.js app so most data is client-rendered,
    // but some stats may appear in __NEXT_DATA__ or meta tags
    const nextDataMatch = body.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        console.log('  ✓ Found __NEXT_DATA__ payload');
        return { source: 'x402scan', data: nextData, raw: body };
      } catch (e) {
        console.log('  ⚠ Could not parse __NEXT_DATA__');
      }
    }
    return { source: 'x402scan', data: null, raw: body };
  } catch (e) {
    console.log(`  ✗ Failed: ${e.message}`);
    return { source: 'x402scan', data: null, raw: '' };
  }
}

async function fetchX402ListData() {
  console.log('[2/4] Fetching x402list.fun stats...');
  try {
    const { body } = await fetch('https://x402list.fun/');
    return { source: 'x402list', data: null, raw: body };
  } catch (e) {
    console.log(`  ✗ Failed: ${e.message}`);
    return { source: 'x402list', data: null, raw: '' };
  }
}

async function fetchDuneData() {
  console.log('[3/4] Fetching Dune Analytics (public query)...');
  try {
    // Dune public query results endpoint (no API key needed for public queries)
    const { body } = await fetch('https://api.dune.com/api/v1/query/5236154/results?limit=1');
    const data = JSON.parse(body);
    if (data.result && data.result.rows) {
      console.log(`  ✓ Got ${data.result.rows.length} rows from Dune`);
      return { source: 'dune', data: data.result.rows };
    }
    console.log('  ⚠ No rows in Dune response');
    return { source: 'dune', data: null };
  } catch (e) {
    console.log(`  ⚠ Dune fetch failed (may need API key): ${e.message}`);
    return { source: 'dune', data: null };
  }
}

async function fetchEcosystemPage() {
  console.log('[4/4] Fetching x402.org/ecosystem...');
  try {
    const { body } = await fetch('https://www.x402.org/ecosystem');
    // Count project entries
    const projectCount = (body.match(/class="[^"]*card[^"]*"/gi) || []).length;
    console.log(`  ✓ Page loaded (${body.length} bytes)`);
    return { source: 'ecosystem', data: { projectCount }, raw: body };
  } catch (e) {
    console.log(`  ✗ Failed: ${e.message}`);
    return { source: 'ecosystem', data: null, raw: '' };
  }
}

// ─── Data Processing ───────────────────────────────────────

function buildUpdatedStats(sources) {
  // Try to extract numbers from scraped pages
  // These patterns attempt to find stats in server-rendered or meta content
  const stats = {
    totalTransactions: null,
    totalVolume: null,
    uniqueBuyers: null,
    uniqueSellers: null,
    avgTxSize: null,
    lastUpdated: formatDate()
  };

  // Try x402scan source
  const scanRaw = sources.find(s => s.source === 'x402scan')?.raw || '';

  // Look for common stat patterns in the HTML
  const txMatch = scanRaw.match(/(\d[\d,.]*)\s*(?:M|million)?\s*(?:total\s*)?transactions/i);
  if (txMatch) stats.totalTransactions = txMatch[1];

  const volMatch = scanRaw.match(/\$\s*([\d,.]+)\s*(?:M|million)/i);
  if (volMatch) stats.totalVolume = volMatch[1];

  const buyerMatch = scanRaw.match(/([\d,.]+)\s*(?:K|k)?\s*buyers/i);
  if (buyerMatch) stats.uniqueBuyers = buyerMatch[1];

  const sellerMatch = scanRaw.match(/([\d,.]+)\s*(?:K|k)?\s*sellers/i);
  if (sellerMatch) stats.uniqueSellers = sellerMatch[1];

  return stats;
}

function injectTimestamp(htmlPath) {
  let html = fs.readFileSync(htmlPath, 'utf8');
  const today = formatDate();

  // Update the footer timestamp
  html = html.replace(
    /Generated\s+(?:Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Jan)\s+\d{4}/g,
    `Generated ${today}`
  );

  // Update "Data as of" notes
  html = html.replace(
    /Data as of\s+(?:Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Jan)\s+\d{4}/g,
    `Data as of ${today}`
  );

  fs.writeFileSync(htmlPath, html);
  return html;
}

function injectStats(htmlPath, stats) {
  let html = fs.readFileSync(htmlPath, 'utf8');

  // Only inject if we got real data
  if (stats.totalTransactions) {
    html = html.replace(
      /(<div class="value purple">).*?(<\/div>)/,
      `$1${stats.totalTransactions}$2`
    );
  }
  if (stats.totalVolume) {
    html = html.replace(
      /(<div class="value green">\$).*?(<\/div>)/,
      `$1${stats.totalVolume}$2`
    );
  }
  if (stats.uniqueBuyers) {
    html = html.replace(
      /(<div class="value blue">).*?(<\/div>)/,
      `$1${stats.uniqueBuyers}$2`
    );
  }
  if (stats.uniqueSellers) {
    html = html.replace(
      /(<div class="value orange">).*?(<\/div>)/,
      `$1${stats.uniqueSellers}$2`
    );
  }

  fs.writeFileSync(htmlPath, html);
  console.log(`  ✓ Updated ${path.basename(htmlPath)}`);
}

// ─── Logging ───────────────────────────────────────────────

function writeLog(stats, sources) {
  const logDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const logEntry = {
    timestamp: new Date().toISOString(),
    stats,
    sourcesStatus: sources.map(s => ({
      source: s.source,
      hasData: !!s.data,
      rawLength: s.raw?.length || 0
    }))
  };

  const logFile = path.join(logDir, 'update-log.json');
  let logs = [];
  if (fs.existsSync(logFile)) {
    try { logs = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch {}
  }
  logs.push(logEntry);
  // Keep last 90 days
  if (logs.length > 90) logs = logs.slice(-90);
  fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
  console.log(`  ✓ Wrote update log (${logs.length} entries)`);
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  x402 Scanner - Daily Data Update    ║`);
  console.log(`║  ${formatDate()}                       ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  // 1. Fetch data from all sources
  const sources = await Promise.all([
    fetchX402ScanData(),
    fetchX402ListData(),
    fetchDuneData(),
    fetchEcosystemPage()
  ]);

  // 2. Build updated stats
  console.log('\nProcessing data...');
  const stats = buildUpdatedStats(sources);
  console.log('  Stats extracted:', JSON.stringify(stats, null, 2));

  // 3. Update HTML files
  console.log('\nUpdating HTML files...');
  const publicDir = path.join(__dirname, '..', 'public');

  const indexPath = path.join(publicDir, 'index.html');
  const sellerPath = path.join(publicDir, 'seller-analysis.html');

  // Always update timestamps
  injectTimestamp(indexPath);
  injectTimestamp(sellerPath);

  // Inject any live stats we managed to scrape
  injectStats(indexPath, stats);

  // 4. Write update log
  console.log('\nWriting logs...');
  writeLog(stats, sources);

  console.log('\n✅ Update complete!\n');
}

main().catch(err => {
  console.error('❌ Update failed:', err);
  process.exit(1);
});
