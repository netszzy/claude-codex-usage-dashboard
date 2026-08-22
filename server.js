'use strict';

const path = require('path');
const { writeJsonAtomic } = require('./lib/atomic-json');
const { createBridgeRefresher, refreshBridgeSnapshot } = require('./lib/bridge');
const { createDashboardConfig, envNumber } = require('./lib/dashboard-config');
const { LOCAL_HOSTS, createDashboardServer: createHttpServer, pageHtml, requestHostName } = require('./lib/http');
const { createClaudeCollector } = require('./lib/collectors/claude');
const { createCodexCollector, normalizeCodexAppServerRateLimits, normalizeCodexRateLimits, parseCodexEventLine, queryCodexAppServerRateLimits, resolveCodexExecutable } = require('./lib/collectors/codex');
const { antigravityLineTimestamp, createAntigravityCollector, isUsableAntigravityData, parseAntigravityQuotaPayload } = require('./lib/collectors/antigravity');
const { AGENT_PRESETS, createSnapshotCollector } = require('./lib/collectors/snapshots');

const HOST = process.env.HOST || '127.0.0.1';
if (!LOCAL_HOSTS.has(HOST)) {
  throw new Error('HOST must be a loopback address: 127.0.0.1, localhost, or ::1');
}
const PORT = envNumber('PORT', 8787, { integer: true, min: 1, max: 65535 });
const dashboardConfig = createDashboardConfig();
const claudeCollector = createClaudeCollector();
const codexCollector = createCodexCollector();
const antigravityCollector = createAntigravityCollector();
const snapshotCollector = createSnapshotCollector();

const bridgeDefinitions = Object.freeze([
  {
    id: 'kimi',
    label: 'Kimi',
    scriptPath: path.join(__dirname, 'kimi-usage-snapshot.js'),
    refreshMs: envNumber('KIMI_USAGE_REFRESH_SECONDS', 60, { integer: true, min: 15, max: 3600 }) * 1000,
    timeoutMs: 30000,
    enabled: () => dashboardConfig.getConfig().bridges.kimi,
  },
  {
    id: 'grok',
    label: 'Grok',
    scriptPath: path.join(__dirname, 'grok-usage-snapshot.js'),
    refreshMs: envNumber('GROK_USAGE_REFRESH_SECONDS', 60, { integer: true, min: 15, max: 3600 }) * 1000,
    timeoutMs: 30000,
    enabled: () => dashboardConfig.getConfig().bridges.grok,
  },
]);

function bridgeDefinition(id) {
  return bridgeDefinitions.find((definition) => definition.id === id);
}

function refreshKimiUsageSnapshot(options = {}) {
  return refreshBridgeSnapshot(bridgeDefinition('kimi'), options);
}

function refreshGrokUsageSnapshot(options = {}) {
  return refreshBridgeSnapshot(bridgeDefinition('grok'), options);
}

function createKimiUsageBridgeRefresher(options = {}) {
  return createBridgeRefresher(bridgeDefinition('kimi'), options);
}

function createGrokUsageBridgeRefresher(options = {}) {
  return createBridgeRefresher(bridgeDefinition('grok'), options);
}

const kimiUsageBridgeRefresh = createKimiUsageBridgeRefresher();
const grokUsageBridgeRefresh = createGrokUsageBridgeRefresher();

async function defaultUsageProvider() {
  const claude = claudeCollector.readClaudeUsage();
  const codex = codexCollector.getCodexUsage();
  const antigravity = await antigravityCollector.getAntigravityUsage();
  const config = dashboardConfig.getConfig();
  kimiUsageBridgeRefresh();
  grokUsageBridgeRefresh();
  const coreData = { claude, codex, antigravity };
  const agents = AGENT_PRESETS.slice(0, 3).map((preset) => (
    snapshotCollector.builtinAgentSnapshot(preset, coreData[preset.id])
  ));
  agents.push(...snapshotCollector.readExternalAgentSnapshots());
  return {
    config: {
      ...config,
      agents: snapshotCollector.buildAgentCatalog(agents),
    },
    agents,
    claude,
    codex,
    antigravity,
  };
}

function createDashboardServer(options = {}) {
  return createHttpServer({
    usageProvider: options.usageProvider || defaultUsageProvider,
    configStore: options.configStore || dashboardConfig,
  });
}

function hostForUrl(host) {
  return host.includes(':') ? `[${host}]` : host;
}

if (require.main === module) {
  const server = createDashboardServer();
  server.listen(PORT, HOST, () => {
    const urlHost = hostForUrl(HOST);
    console.log('Claude / Codex usage dashboard');
    console.log(`Desktop: http://${urlHost}:${PORT}/?mode=desktop`);
    console.log(`API:     http://${urlHost}:${PORT}/api/usage`);
  });
}

module.exports = {
  AGENT_PRESETS,
  antigravityLineTimestamp,
  buildAgentCatalog: snapshotCollector.buildAgentCatalog,
  createDashboardServer,
  createGrokUsageBridgeRefresher,
  createKimiUsageBridgeRefresher,
  defaultUsageProvider,
  isUsableAntigravityData,
  normalizeAgentSnapshot: snapshotCollector.normalizeAgentSnapshot,
  normalizeCodexAppServerRateLimits,
  normalizeCodexRateLimits,
  pageHtml,
  parseAntigravityQuotaPayload,
  parseCodexEventLine,
  queryCodexAppServerRateLimits,
  readCodexUsage: codexCollector.readCodexUsage,
  readExternalAgentSnapshots: snapshotCollector.readExternalAgentSnapshots,
  readLatestCodexSnapshot: codexCollector.readLatestCodexSnapshot,
  refreshGrokUsageSnapshot,
  refreshKimiUsageSnapshot,
  requestHostName,
  resolveCodexExecutable,
  writeJsonAtomic,
};
