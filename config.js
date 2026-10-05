let local = {}

try {
  local = require('./config.local')
} catch (err) {
  if (err && err.code !== 'MODULE_NOT_FOUND') throw err
}

function pick(envName, localName, fallback) {
  const envValue = process.env[envName]
  if (envValue !== undefined && envValue !== '') return envValue
  if (local[localName] !== undefined) return local[localName]
  return fallback
}

function pickNumber(envName, localName, fallback) {
  const value = Number(pick(envName, localName, fallback))
  return Number.isFinite(value) ? value : fallback
}

const defaultWorkers = ['BuilderWorker1', 'BuilderWorker2', 'BuilderWorker3']
const envWorkers = String(process.env.MC_WORKER_USERNAMES || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)

module.exports = {
  host: pick('MC_HOST', 'host', 'localhost'),
  port: pickNumber('MC_PORT', 'port', 25565),
  username: pick('MC_USERNAME', 'username', 'BuilderLeader'),
  workerUsernames: envWorkers.length
    ? envWorkers
    : (Array.isArray(local.workerUsernames) && local.workerUsernames.length
        ? local.workerUsernames
        : defaultWorkers),
  password: pick('MC_PASSWORD', 'password', ''),
  version: pick('MC_VERSION', 'version', '1.21.11'),
  owner: pick('MC_OWNER', 'owner', 'YourMinecraftName'),
  placeDelayTicks: 0,
  progressEvery: 250,
  burstSize: 8,
  storageSearchRadius: 48,
  storageMaxContainers: 64,
  stuckTimeoutMs: 30000,
  pathTimeoutMs: 20000,
  ownerMessageDelayMs: 2000,
  wallBandHeight: 3,
  wallReserveBlocks: 128,
  wallScaffoldBlockName: 'netherrack',
  wallScaffoldReserve: 64
}
