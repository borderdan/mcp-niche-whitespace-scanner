import fs from 'fs';
import https from 'https';

const LOG_FILE = 'pipeline.log';
const OUTPUT_FILE = 'public/data.json';
const REGISTRY_SEED_URL = 'https://raw.githubusercontent.com/modelcontextprotocol/registry/main/data/seed.json';

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  fs.appendFileSync(LOG_FILE, logMessage);
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { ...options, headers: { 'User-Agent': 'mcp-niche-whitespace-scanner', ...options.headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve({ data: JSON.parse(data), headers: res.headers });
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
          }
        } else if (res.statusCode === 403 || res.statusCode === 429) {
           reject({ status: res.statusCode, headers: res.headers, message: `Rate limited by ${url}` });
        } else {
          reject(new Error(`Failed to fetch ${url}: ${res.statusCode} ${res.statusMessage}`));
        }
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleRateLimit(error) {
  if (error.headers && error.headers['x-ratelimit-remaining'] === '0') {
    const resetTime = parseInt(error.headers['x-ratelimit-reset'], 10);
    if (resetTime) {
      const waitTime = (resetTime * 1000) - Date.now();
      if (waitTime > 0) {
        log(`Rate limit reached. Waiting for ${Math.ceil(waitTime / 1000 / 60)} minutes until reset...`);
        await sleep(waitTime + 5000); // Wait until reset + 5 seconds buffer
        return true;
      }
    }
  } else if (error.headers && error.headers['retry-after']) {
      const waitTime = parseInt(error.headers['retry-after'], 10) * 1000;
      log(`Secondary rate limit reached. Waiting for ${waitTime / 1000} seconds...`);
      await sleep(waitTime + 5000);
      return true;
  }
  return false;
}


async function getGithubStats(repoUrl) {
  // Extract owner and repo from url (e.g., https://github.com/domdomegg/airtable-mcp-server.git)
  // Fix the regex to allow dots in repo names
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;

  const owner = match[1];
  const repo = match[2];

  const maxRetries = 3;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      log(`Fetching GitHub stats for ${owner}/${repo}...`);
      await sleep(100);

      const headers = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};

      const { data: repoData } = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, { headers });

      const defaultBranch = repoData.default_branch || 'main';
      const { data: commitData } = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/commits/${defaultBranch}`, { headers });

      return {
        stars: repoData.stargazers_count,
        lastUpdated: commitData.commit.author.date
      };
    } catch (error) {
      if (error.status === 403 || error.status === 429) {
         const handled = await handleRateLimit(error);
         if (handled) {
            retries++;
            continue;
         }
      }
      log(`Error fetching GitHub stats for ${repoUrl}: ${error.message || JSON.stringify(error)}`);
      return null;
    }
  }
  return null;
}

async function run() {
  fs.writeFileSync(LOG_FILE, ''); // Clear log file
  log('Starting MCP Registry data pipeline...');

  if (!fs.existsSync('public')) {
    fs.mkdirSync('public');
  }

  try {
    log(`Fetching seed.json from ${REGISTRY_SEED_URL}...`);
    const { data: seedData } = await fetchJson(REGISTRY_SEED_URL);
    log(`Successfully fetched ${seedData.length} servers from seed.json`);

    const processedServers = [];

    for (const server of seedData) {
      if (server.repository && server.repository.url && server.repository.url.includes('github.com')) {
        const stats = await getGithubStats(server.repository.url);

        if (stats) {
          processedServers.push({
            name: server.name || server.repository.url.split('/').pop(),
            description: server.description || '',
            url: server.repository.url,
            stars: stats.stars,
            lastUpdated: stats.lastUpdated,
          });
        } else {
          processedServers.push({
            name: server.name || server.repository.url.split('/').pop(),
            description: server.description || '',
            url: server.repository.url,
            stars: 0,
            lastUpdated: new Date().toISOString(),
          });
        }
      } else {
          processedServers.push({
            name: server.name || 'Unknown',
            description: server.description || '',
            url: server.repository?.url || '',
            stars: 0,
            lastUpdated: new Date().toISOString(),
          });
      }
    }

    const outputData = {
      lastUpdated: new Date().toISOString(),
      servers: processedServers
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));
    log(`Successfully wrote ${processedServers.length} servers to ${OUTPUT_FILE}`);

  } catch (error) {
    log(`Pipeline failed: ${error.message}`);
    process.exit(1);
  }
}

run();
