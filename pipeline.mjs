import fs from 'fs';
import https from 'https';
import { execSync } from 'child_process';

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

async function getGithubSearchRepos() {
  const maxRetries = 3;
  let retries = 0;
  // Fetch up to 100 top MCP server repos by stars
  const searchUrl = 'https://api.github.com/search/repositories?q=topic:mcp-server&sort=stars&order=desc&per_page=100';

  while (retries < maxRetries) {
    try {
      log(`Fetching GitHub search stats...`);
      await sleep(100);

      const headers = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
      const { data: searchData } = await fetchJson(searchUrl, { headers });

      return searchData.items || [];
    } catch (error) {
      if (error.status === 403 || error.status === 429) {
         const handled = await handleRateLimit(error);
         if (handled) {
            retries++;
            continue;
         }
      }
      log(`Error fetching GitHub search: ${error.message || JSON.stringify(error)}`);
      return [];
    }
  }
  return [];
}

async function getGithubStats(repoUrl) {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;

  const owner = match[1];
  const repo = match[2];

  const maxRetries = 3;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      log(`Fetching individual GitHub stats for ${owner}/${repo}...`);
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
       log(`Error fetching individual GitHub stats for ${repoUrl}: ${error.message || JSON.stringify(error)}`);
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
    const processedServers = new Map();
    let seedServers = [];

    log(`Fetching seed.json from ${REGISTRY_SEED_URL}...`);
    try {
        const { data: seedData } = await fetchJson(REGISTRY_SEED_URL);
        log(`Successfully fetched ${seedData.length} servers from seed.json`);
        seedServers = seedData;
    } catch (error) {
        log(`Warning: Failed to fetch seed.json: ${error.message}`);
    }

    const githubItems = await getGithubSearchRepos();
    log(`Successfully fetched ${githubItems.length} repos from GitHub search.`);

    // Add all github search results
    for (const item of githubItems) {
        processedServers.set(item.full_name, {
            name: item.full_name,
            description: item.description || '',
            url: item.html_url,
            stars: item.stargazers_count,
            lastUpdated: item.pushed_at || item.updated_at || new Date().toISOString(),
        });
    }

    // Now process seed servers and fall back to fetching individual stats if they weren't in the search
    for (const server of seedServers) {
        let foundInSearch = false;

        if (server.repository && server.repository.url && server.repository.url.includes('github.com')) {
           // Try to find if it was already caught in the top 100 search
           for (const existingServer of processedServers.values()) {
              if (server.repository.url.includes(existingServer.url)) {
                 foundInSearch = true;
                 // Override the name to match the registry
                 existingServer.name = server.name;
                 break;
              }
           }

           if (!foundInSearch) {
              // Not in top 100, we need to fetch its stats manually to avoid 0 stars / fake date
              const stats = await getGithubStats(server.repository.url);
              if (stats) {
                 processedServers.set(server.name, {
                    name: server.name || server.repository.url.split('/').pop(),
                    description: server.description || '',
                    url: server.repository.url,
                    stars: stats.stars,
                    lastUpdated: stats.lastUpdated,
                 });
              } else {
                 processedServers.set(server.name, {
                    name: server.name || server.repository.url.split('/').pop(),
                    description: server.description || '',
                    url: server.repository.url,
                    stars: 0,
                    lastUpdated: new Date().toISOString(),
                 });
              }
           }
        } else {
           processedServers.set(server.name, {
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
      servers: Array.from(processedServers.values()).sort((a, b) => b.stars - a.stars)
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));
    log(`Successfully wrote ${outputData.servers.length} servers to ${OUTPUT_FILE}`);

  } catch (error) {
    log(`Pipeline failed: ${error.message}`);
    process.exit(1);
  }
}

run();
