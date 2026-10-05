const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { fork } = require('child_process')
const config = require('./config')
const Builder = require('./builder')

const ROLE = process.env.BOT_ROLE || 'leader'
const IS_LEADER = ROLE === 'leader'
const WORKER_INDEX = Number(process.env.WORKER_INDEX || 0)
const HOST = config.host
const PORT = config.port
const USERNAME = process.env.BOT_USERNAME || config.username
const LEADER_USERNAME = process.env.LEADER_USERNAME || config.username
const PASSWORD = config.password
const VERSION = config.version
const OWNER = config.owner
const WORKER_USERNAMES = config.workerUsernames || [
  'BuilderWorker1',
  'BuilderWorker2',
  'BuilderWorker3'
]

let loginCount = 0
let spawnCount = 0
let authState = 'CONNECTING'
const submitted = new Set()

const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: USERNAME,
  auth: 'offline',
  version: VERSION,
  hideErrors: true,
  checkTimeoutInterval: 60000,
  physicsEnabled: false
})
bot.loadPlugin(pathfinder)

const ownerMessageQueue = []
const OWNER_MESSAGE_DELAY_MS = config.ownerMessageDelayMs || 2000

function queueOwnerMessage(text) {
  const message = String(text)

  if (message.startsWith('RUNNING |')) {
    const existing = ownerMessageQueue.findIndex(
      item => item.startsWith('RUNNING |')
    )

    if (existing >= 0) {
      ownerMessageQueue[existing] = message
      return
    }
  }

  if (message.startsWith('[ALERT]')) {
    ownerMessageQueue.unshift(message)
  } else {
    ownerMessageQueue.push(message)
  }

  if (ownerMessageQueue.length > 12) {
    const routineIndex = ownerMessageQueue.findIndex(
      item => !item.startsWith('[ALERT]')
    )
    if (routineIndex >= 0) ownerMessageQueue.splice(routineIndex, 1)
  }
}

setInterval(() => {
  if (!ownerMessageQueue.length) return
  if (!bot._client || bot._client.state !== 'play') return

  const message = ownerMessageQueue.shift()

  try {
    bot.whisper(OWNER, message)
    console.log('[OWNER MSG QUEUE] sent: ' + message)
  } catch (err) {
    console.log('[OWNER MSG ERROR] ' + err.message)
  }
}, OWNER_MESSAGE_DELAY_MS).unref()

const storageLocks = new Map()
const storageLockWaiters = new Map()
let storageLockRequestSeq = 0

function storageLockOwner() {
  return IS_LEADER ? 'leader' : ('worker-' + WORKER_INDEX)
}

function cleanExpiredStorageLocks() {
  const now = Date.now()

  for (const [key, lock] of storageLocks.entries()) {
    if (!lock || lock.expiresAt <= now) {
      storageLocks.delete(key)
    }
  }
}

function tryAcquireStorageLock(owner, key) {
  cleanExpiredStorageLocks()

  const current = storageLocks.get(key)

  if (current && current.owner !== owner) {
    return false
  }

  storageLocks.set(key, {
    owner,
    expiresAt: Date.now() + 30000
  })

  return true
}

function releaseStorageLockLocal(owner, key) {
  const current = storageLocks.get(key)

  if (current && current.owner === owner) {
    storageLocks.delete(key)
  }
}

function requestStorageLock(key) {
  if (IS_LEADER) {
    return Promise.resolve(
      tryAcquireStorageLock(storageLockOwner(), key)
    )
  }

  if (!process.send) return Promise.resolve(false)

  const requestId =
    USERNAME + '-' + (++storageLockRequestSeq)

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      storageLockWaiters.delete(requestId)
      resolve(false)
    }, 3000)

    storageLockWaiters.set(requestId, {
      resolve,
      timer
    })

    process.send({
      type: 'storage-lock-request',
      requestId,
      key,
      owner: storageLockOwner()
    })
  })
}

function releaseStorageLock(key) {
  if (IS_LEADER) {
    releaseStorageLockLocal(storageLockOwner(), key)
    return
  }

  if (process.send) {
    process.send({
      type: 'storage-lock-release',
      key,
      owner: storageLockOwner()
    })
  }
}

const builder = new Builder(bot, {
  owner: OWNER,
  placeDelayTicks: config.placeDelayTicks,
  progressEvery: config.progressEvery,
  burstSize: config.burstSize,
  storageSearchRadius: config.storageSearchRadius,
  storageMaxContainers: config.storageMaxContainers,
  stuckTimeoutMs: config.stuckTimeoutMs,
  pathTimeoutMs: config.pathTimeoutMs,
  wallBandHeight: config.wallBandHeight,
  wallReserveBlocks: config.wallReserveBlocks,
  wallScaffoldBlockName: config.wallScaffoldBlockName,
  wallScaffoldReserve: config.wallScaffoldReserve,
  acquireStorageLock: requestStorageLock,
  releaseStorageLock,
  reply: text => {
    const message = String(text)

    if (IS_LEADER) {
      if (bot._client && bot._client.state === 'play') {
        queueOwnerMessage(message)
      }
      return
    }

    if (process.send) {
      process.send({
        type: 'worker-report',
        workerIndex: WORKER_INDEX,
        username: USERNAME,
        text: message
      })
    }
  }
})

const workerChildren = new Map()
const workerReady = new Map()
const workerRallied = new Map()
const pendingTeamTasks = new Map()
let workersSpawned = false
let pendingWorkerTask = null
let workerTaskStarting = false
let workerRallyPending = false

const sleep = ms => new Promise(r => setTimeout(r, ms))

function clonePoint(p) {
  if (!p) return null
  return { x: p.x, y: p.y, z: p.z }
}

function isFreeBlock(block) {
  if (!block) return false
  return (
    block.name === 'air' ||
    block.name === 'cave_air' ||
    block.name === 'void_air' ||
    block.boundingBox === 'empty'
  )
}

function isSafeStand(pos) {
  const below = bot.blockAt(pos.offset(0, -1, 0))
  const feet = bot.blockAt(pos)
  const head = bot.blockAt(pos.offset(0, 1, 0))

  if (!below || !feet || !head) return false

  if (
    below.name === 'water' || below.name === 'lava' ||
    feet.name === 'water' || feet.name === 'lava' ||
    head.name === 'water' || head.name === 'lava'
  ) return false

  return below.boundingBox !== 'empty' && isFreeBlock(feet) && isFreeBlock(head)
}

function isOpenStaging(pos) {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (!isSafeStand(pos.offset(dx, 0, dz))) return false
    }
  }

  return true
}

function findTeamStagingSpot(from, to) {
  if (!from || !to) return null

  const minX = Math.min(from.x, to.x)
  const maxX = Math.max(from.x, to.x)
  const minY = Math.min(from.y, to.y)
  const maxY = Math.max(from.y, to.y)
  const minZ = Math.min(from.z, to.z)
  const maxZ = Math.max(from.z, to.z)
  const centerX = Math.floor((minX + maxX) / 2)
  const centerZ = Math.floor((minZ + maxZ) / 2)
  const candidates = []

  const verticalWall =
    maxY > minY &&
    (minX === maxX || minZ === maxZ)

  if (verticalWall && teamMode === 'wall') {
    const standLevels = [
      minY + 1,
      minY,
      minY + 2,
      minY - 1
    ]

    const sideOrder = teamWallSide === '+'
      ? [1, -1]
      : teamWallSide === '-'
        ? [-1, 1]
        : [1, -1]

    for (const standY of standLevels) {
      for (const sign of sideOrder) {
        for (let distance = 3; distance <= 12; distance++) {
          const base = minZ === maxZ
            ? new Vec3(centerX, standY, minZ + (sign * distance))
            : new Vec3(minX + (sign * distance), standY, centerZ)

          const widthAxis = minZ === maxZ ? 'x' : 'z'

          for (let shift = 0; shift <= 8; shift++) {
            for (const direction of shift === 0 ? [0] : [-1, 1]) {
              const pos = base.clone()

              if (widthAxis === 'x') {
                pos.x += shift * direction
                if (pos.x < minX + 2 || pos.x > maxX - 2) continue
              } else {
                pos.z += shift * direction
                if (pos.z < minZ + 2 || pos.z > maxZ - 2) continue
              }

              if (!isOpenStaging(pos)) continue

              candidates.push({
                pos,
                score:
                  Math.abs(standY - (minY + 1)) * 100 +
                  distance * 10 +
                  shift
              })
            }
          }
        }
      }
    }
  } else {
    const standY = minY + 1

    for (let x = minX + 2; x <= maxX - 2; x++) {
      for (let z = minZ + 2; z <= maxZ - 2; z++) {
        const pos = new Vec3(x, standY, z)
        if (!isOpenStaging(pos)) continue

        const score =
          Math.abs(x - centerX) +
          Math.abs(z - centerZ)

        candidates.push({ pos, score })
      }
    }
  }

  candidates.sort((a, b) => a.score - b.score)
  return candidates.length ? candidates[0].pos : null
}

async function moveLeaderToStaging() {
  if (!IS_LEADER) return true

  const pos = findTeamStagingSpot(teamFrom, teamTo)

  if (!pos) {
    queueOwnerMessage(
      '[ALERT] No open 5x5 staging area found inside build zone'
    )
    return false
  }

  queueOwnerMessage(
    '[TEAM] moving leader to staging ' +
    pos.x + ' ' + pos.y + ' ' + pos.z
  )

  try {
    await builder.withTimeout(
      bot.pathfinder.goto(
        new goals.GoalBlock(pos.x, pos.y, pos.z)
      ),
      30000,
      'leader staging path'
    )

    await sleep(1000)

    console.log(
      '[TEAM] leader staging ready at ' +
      bot.entity.position.toString()
    )

    return true
  } catch (err) {
    bot.pathfinder.setGoal(null)
    queueOwnerMessage(
      '[ALERT] Leader cannot reach staging point: ' + err.message
    )
    return false
  }
}

function workerEscapeCandidates() {
  if (!bot.entity) return []

  const origin = bot.entity.position.floored()
  const candidates = []

  for (let radius = 2; radius <= 5; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue

        for (let dy = 1; dy >= -1; dy--) {
          const pos = new Vec3(
            origin.x + dx,
            origin.y + dy,
            origin.z + dz
          )

          if (isSafeStand(pos)) {
            candidates.push(pos)
            break
          }
        }
      }
    }
  }

  return candidates
}

async function verifyWorkerCanEscape() {
  if (IS_LEADER || !bot.entity) return false

  const start = bot.entity.position.clone()
  const candidates = workerEscapeCandidates()

  for (const pos of candidates.slice(0, 16)) {
    try {
      await builder.withTimeout(
        bot.pathfinder.goto(
          new goals.GoalBlock(pos.x, pos.y, pos.z)
        ),
        8000,
        'rally escape test'
      )

      const moved = bot.entity.position.distanceTo(start)

      if (moved >= 1.5) {
        console.log(
          '[WORKER ' + WORKER_INDEX + '] escape test OK moved=' +
          moved.toFixed(1)
        )
        return true
      }
    } catch (err) {
      bot.pathfinder.setGoal(null)
    }
  }

  console.log(
    '[WORKER ' + WORKER_INDEX + '] escape test FAILED at ' +
    start.toString()
  )

  return false
}

let teamBlockName = 'stone'
let teamMode = 'stream'
let teamWallBandHeight = config.wallBandHeight || 3
let teamWallSide = 'auto'
let teamFrom = null
let teamTo = null
let teamTaskId = 0
const tpaQueue = []
let tpaQueueBusy = false

function splitBuildArea(from, to, count = 4) {
  const minX = Math.min(from.x, to.x)
  const maxX = Math.max(from.x, to.x)
  const minY = Math.min(from.y, to.y)
  const maxY = Math.max(from.y, to.y)
  const minZ = Math.min(from.z, to.z)
  const maxZ = Math.max(from.z, to.z)

  const sizeX = maxX - minX + 1
  const sizeZ = maxZ - minZ + 1
  const axis = sizeZ >= sizeX ? 'z' : 'x'
  const min = axis === 'z' ? minZ : minX
  const max = axis === 'z' ? maxZ : maxX
  const length = max - min + 1
  const activeCount = Math.max(1, Math.min(count, length))

  const chunks = []
  let cursor = min

  for (let i = 0; i < activeCount; i++) {
    const remaining = max - cursor + 1
    const slots = activeCount - i
    const span = Math.ceil(remaining / slots)
    const end = Math.min(max, cursor + span - 1)

    if (axis === 'z') {
      chunks.push({
        from: { x: minX, y: minY, z: cursor },
        to: { x: maxX, y: maxY, z: end }
      })
    } else {
      chunks.push({
        from: { x: cursor, y: minY, z: minZ },
        to: { x: end, y: maxY, z: maxZ }
      })
    }

    cursor = end + 1
  }

  return { axis, chunks }
}

async function processTpaQueue() {
  if (!IS_LEADER || tpaQueueBusy) return
  tpaQueueBusy = true

  try {
    while (tpaQueue.length) {
      const username = tpaQueue.shift()

      await sleep(900)

      if (bot._client && bot._client.state === 'play') {
        console.log('[TEAM TPA] accepting ' + username)
        bot.chat('/tpaccept ' + username)
      }

      await sleep(6500)
    }
  } finally {
    tpaQueueBusy = false
  }
}

function handleWorkerMessage(index, child, message) {
  if (!message || typeof message !== 'object') return

  const workerName = WORKER_USERNAMES[index - 1] || ('Worker' + index)

  if (message.type === 'storage-lock-request') {
    const granted = tryAcquireStorageLock(
      message.owner || ('worker-' + index),
      message.key
    )

    if (child && child.connected) {
      child.send({
        type: 'storage-lock-response',
        requestId: message.requestId,
        key: message.key,
        granted
      })
    }

    return
  }

  if (message.type === 'storage-lock-release') {
    releaseStorageLockLocal(
      message.owner || ('worker-' + index),
      message.key
    )
    return
  }

  if (message.type === 'worker-ready') {
    workerReady.set(index, true)
    console.log('[TEAM] W' + index + ' ready: ' + workerName)
    queueOwnerMessage('[TEAM] W' + index + ' READY: ' + workerName)

    const pending = pendingTeamTasks.get(index)
    if (pending && child && child.connected) {
      console.log('[TEAM] W' + index + ' has queued task; rallying first')
      workerRallied.set(index, false)
      child.send({ type: 'rally' })
    }

    return
  }

  if (message.type === 'worker-rallied') {
    workerRallied.set(index, true)
    console.log('[TEAM] W' + index + ' rallied at leader: ' + workerName)

    const pending = pendingTeamTasks.get(index)
    if (pending && child && child.connected) {
      console.log('[TEAM] dispatching queued task to rallied W' + index)
      child.send({ type: 'task', task: pending })
    }

    return
  }

  if (message.type === 'worker-rally-failed') {
    workerRallied.set(index, false)

    console.log(
      '[TEAM] W' + index + ' rally escape failed; retrying TPA'
    )

    setTimeout(() => {
      if (child && child.connected && !workerRallied.get(index)) {
        child.send({ type: 'rally' })
      }
    }, 3000)

    return
  }

  if (message.type === 'tpa-request') {
    console.log('[TEAM] W' + index + ' requested TPA: ' + message.username)

    const delay = 1000 + ((index - 1) * 1500)

    setTimeout(() => {
      if (bot._client && bot._client.state === 'play') {
        console.log('[TEAM TPA] accepting W' + index + ': ' + message.username)
        bot.chat('/tpaccept ' + message.username)
      }
    }, delay)

    return
  }

  if (message.type === 'worker-started') {
    console.log(
      '[TEAM] W' + index + ' started chunk ' +
      message.from.x + ',' + message.from.z +
      ' -> ' + message.to.x + ',' + message.to.z
    )
    return
  }

  if (message.type === 'worker-status') {
    queueOwnerMessage('[W' + index + '] ' + message.text)
    return
  }

  if (message.type === 'worker-report') {
    const text = String(message.text || '')
    console.log('[W' + index + '] ' + text)

    if (text.startsWith('DONE')) {
      pendingTeamTasks.delete(index)
    }

    if (
      text.startsWith('[ALERT]') ||
      text.startsWith('DONE') ||
      text.startsWith('REFILLED') ||
      text.startsWith('OUT OF')
    ) {
      queueOwnerMessage('[W' + index + '] ' + text)
    }
  }
}

function spawnSingleWorker(index, username) {
  if (!IS_LEADER) return
  if (workerChildren.has(index)) return

  const child = fork(__filename, [], {
    env: {
      ...process.env,
      BOT_ROLE: 'worker',
      BOT_USERNAME: username,
      WORKER_INDEX: String(index),
      LEADER_USERNAME: USERNAME
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })

  workerChildren.set(index, child)
  workerReady.set(index, false)

  child.on('message', message => {
    handleWorkerMessage(index, child, message)
  })

  child.on('exit', (code, signal) => {
    workerReady.set(index, false)
    workerChildren.delete(index)

    console.log(
      '[TEAM] W' + index + ' exited code=' + code + ' signal=' + signal
    )

    queueOwnerMessage(
      '[ALERT] Worker ' + index + ' offline: ' + username + ' | retrying'
    )

    setTimeout(() => {
      if (IS_LEADER && !workerChildren.has(index)) {
        console.log('[TEAM] retrying W' + index + ': ' + username)
        spawnSingleWorker(index, username)
      }
    }, 12000)
  })

  console.log('[TEAM] spawned W' + index + ': ' + username)
}

function spawnWorkers() {
  if (!IS_LEADER || workersSpawned) return
  workersSpawned = true

  WORKER_USERNAMES.forEach((username, idx) => {
    const index = idx + 1

    setTimeout(() => {
      spawnSingleWorker(index, username)
    }, idx * 8000)
  })
}

function splitWallByAir(from, to, count) {
  const minX = Math.min(from.x, to.x)
  const maxX = Math.max(from.x, to.x)
  const minY = Math.min(from.y, to.y)
  const maxY = Math.max(from.y, to.y)
  const minZ = Math.min(from.z, to.z)
  const maxZ = Math.max(from.z, to.z)

  const wallOnZ = minZ === maxZ && maxY > minY
  const wallOnX = minX === maxX && maxY > minY

  if (!wallOnZ && !wallOnX) {
    return splitBuildArea(from, to, count)
  }

  const widthMin = wallOnZ ? minX : minZ
  const widthMax = wallOnZ ? maxX : maxZ
  const widthLength = widthMax - widthMin + 1
  const minimumSliceWidth = Math.max(
    2,
    (teamWallBandHeight || 3) + 1
  )
  const maxUsefulBots = Math.max(
    1,
    Math.floor(widthLength / minimumSliceWidth)
  )
  const activeCount = Math.max(
    1,
    Math.min(count, maxUsefulBots)
  )
  const columns = []

  for (let width = widthMin; width <= widthMax; width++) {
    let air = 0

    for (let y = minY; y <= maxY; y++) {
      const pos = wallOnZ
        ? new Vec3(width, y, minZ)
        : new Vec3(minX, y, width)

      const block = bot.blockAt(pos)

      if (!block || isFreeBlock(block)) {
        air += 1
      }
    }

    columns.push({ width, air })
  }

  const totalAir = columns.reduce((sum, col) => sum + col.air, 0)

  if (totalAir <= 0) {
    const completeSplit = splitBuildArea(
      from,
      to,
      activeCount
    )

    return {
      ...completeSplit,
      airBalanced: true,
      totalAir: 0
    }
  }

  const chunks = []
  let cursor = 0
  let remainingAir = totalAir

  for (let part = 0; part < activeCount; part++) {
    const partsLeft = activeCount - part
    const minimumForRest =
      (partsLeft - 1) * minimumSliceWidth

    if (part === activeCount - 1) {
      const start = columns[cursor].width
      const end = columns[columns.length - 1].width

      chunks.push(
        wallOnZ
          ? {
              from: { x: start, y: minY, z: minZ },
              to: { x: end, y: maxY, z: minZ }
            }
          : {
              from: { x: minX, y: minY, z: start },
              to: { x: minX, y: maxY, z: end }
            }
      )
      break
    }

    const targetAir = remainingAir / partsLeft
    let accumulated = 0
    const startIndex = cursor
    const maxCursor = columns.length - minimumForRest

    while (
      cursor < maxCursor &&
      (
        cursor - startIndex < minimumSliceWidth ||
        accumulated < targetAir
      )
    ) {
      accumulated += columns[cursor].air
      cursor += 1
    }

    const start = columns[startIndex].width
    const end = columns[cursor - 1].width

    chunks.push(
      wallOnZ
        ? {
            from: { x: start, y: minY, z: minZ },
            to: { x: end, y: maxY, z: minZ }
          }
        : {
            from: { x: minX, y: minY, z: start },
            to: { x: minX, y: maxY, z: end }
          }
    )

    remainingAir -= accumulated
  }

  return {
    axis: wallOnZ ? 'x' : 'z',
    chunks,
    airBalanced: true,
    totalAir
  }
}

function estimateWallChunkBlocks(chunk, bandHeight = 3) {
  const minX = Math.min(chunk.from.x, chunk.to.x)
  const maxX = Math.max(chunk.from.x, chunk.to.x)
  const minY = Math.min(chunk.from.y, chunk.to.y)
  const maxY = Math.max(chunk.from.y, chunk.to.y)
  const minZ = Math.min(chunk.from.z, chunk.to.z)
  const maxZ = Math.max(chunk.from.z, chunk.to.z)

  const wallOnZ = minZ === maxZ
  const widthMin = wallOnZ ? minX : minZ
  const widthMax = wallOnZ ? maxX : maxZ
  const width = widthMax - widthMin + 1
  const height = maxY - minY + 1
  const safeBand = Math.max(1, Math.min(4, Number(bandHeight) || 3))
  const bands = Math.ceil(height / safeBand)

  let air = 0

  for (let w = widthMin; w <= widthMax; w++) {
    for (let y = minY; y <= maxY; y++) {
      const pos = wallOnZ
        ? new Vec3(w, y, minZ)
        : new Vec3(minX, y, w)

      const block = bot.blockAt(pos)

      if (!block || isFreeBlock(block)) {
        air += 1
      }
    }
  }

  // Conservative upper-bound budgets. The bot may use fewer blocks
  // when a lane/support already exists, but carrying extra is intentional.
  const laneBudget = width * bands
  const transitions = Math.max(0, bands - 1)
  const rampBudget = transitions * (safeBand + 1)
  const seedBudget = bands
  const mainReserve = 128
  const scaffoldReserve = 64

  const mainRequired = air + mainReserve
  const scaffoldRequired =
    laneBudget +
    rampBudget +
    seedBudget +
    scaffoldReserve

  const requiredBlocks = mainRequired + scaffoldRequired

  return {
    air,
    width,
    height,
    bands,
    laneBudget,
    rampBudget,
    seedBudget,
    mainReserve,
    scaffoldReserve,
    mainRequired,
    scaffoldRequired,
    requiredBlocks
  }
}

async function waitForWorkersReady(workerCount, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    let allReady = true

    for (let i = 1; i <= workerCount; i++) {
      if (!workerReady.get(i)) {
        allReady = false
        break
      }
    }

    if (allReady) return true
    await sleep(500)
  }

  return false
}

async function rallyWorkers(workerCount, timeoutMs = 60000) {
  if (workerCount <= 0) return true

  for (let i = 1; i <= workerCount; i++) {
    workerRallied.set(i, false)

    const child = workerChildren.get(i)
    if (!child || !child.connected) return false

    child.send({ type: 'rally' })
  }

  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    let allRallied = true

    for (let i = 1; i <= workerCount; i++) {
      if (!workerRallied.get(i)) {
        allRallied = false
        break
      }
    }

    if (allRallied) return true
    await sleep(500)
  }

  return false
}

async function distributeTeamBuild(workerCount = 3) {
  if (!IS_LEADER) return

  workerCount = Math.max(
    0,
    Math.min(WORKER_USERNAMES.length, Number(workerCount) || 0)
  )

  if (!teamFrom || !teamTo) {
    queueOwnerMessage('[ALERT] Set FROM and TO before team start')
    return
  }

  if (teamMode === 'wall') {
    const minX = Math.min(teamFrom.x, teamTo.x)
    const maxX = Math.max(teamFrom.x, teamTo.x)
    const minY = Math.min(teamFrom.y, teamTo.y)
    const maxY = Math.max(teamFrom.y, teamTo.y)
    const minZ = Math.min(teamFrom.z, teamTo.z)
    const maxZ = Math.max(teamFrom.z, teamTo.z)

    if (
      maxY <= minY ||
      !(
        (minZ === maxZ && minX <= maxX) ||
        (minX === maxX && minZ <= maxZ)
      )
    ) {
      queueOwnerMessage(
        '[ALERT] WALL mode needs a vertical plane: X fixed or Z fixed'
      )
      return
    }
  }

  spawnWorkers()

  if (builder.state !== 'STOPPED' && builder.state !== 'DONE') {
    builder.forceStop(false)
  }

  pendingTeamTasks.clear()

  builder.blockName = teamBlockName
  const sharedStorages = builder.captureStoragesNow()

  queueOwnerMessage(
    '[TEAM] storage snapshot=' + sharedStorages.length +
    ' chest/shulker before staging'
  )

  if (!sharedStorages.length) {
    queueOwnerMessage(
      '[ALERT] No chest/shulker found before staging; team start cancelled'
    )
    return
  }

  let plannedSplit = teamMode === 'wall'
    ? splitWallByAir(teamFrom, teamTo, workerCount + 1)
    : splitBuildArea(teamFrom, teamTo, workerCount + 1)

  if (
    teamMode === 'wall' &&
    plannedSplit.airBalanced &&
    plannedSplit.totalAir === 0
  ) {
    queueOwnerMessage(
      '[TEAM] WALL already complete | AIR=0'
    )
    return
  }

  const usefulWorkers = Math.max(
    0,
    plannedSplit.chunks.length - 1
  )

  if (usefulWorkers < workerCount) {
    queueOwnerMessage(
      '[TEAM] wall width supports ' + usefulWorkers +
      ' worker(s); reducing from ' + workerCount
    )
    workerCount = usefulWorkers
  }

  for (const child of workerChildren.values()) {
    if (child.connected) {
      child.send({ type: 'control', command: 'หยุด' })
    }
  }

  if (workerCount > 0) {
    queueOwnerMessage(
      '[TEAM] calling ' + workerCount + ' worker(s) to leader...'
    )

    const ready = await waitForWorkersReady(workerCount)

    if (!ready) {
      queueOwnerMessage(
        '[ALERT] Not all selected workers became READY in time'
      )
      return
    }
  }

  const staged = await moveLeaderToStaging()

  if (!staged) {
    return
  }

  if (workerCount > 0) {
    const rallied = await rallyWorkers(workerCount)

    if (!rallied) {
      queueOwnerMessage(
        '[ALERT] Not all selected workers reached leader by TPA'
      )
      return
    }

    queueOwnerMessage(
      '[TEAM] all ' + workerCount + ' worker(s) arrived. Starting build.'
    )

    await sleep(2000)
  }

  if (plannedSplit.chunks.length !== workerCount + 1) {
    plannedSplit = teamMode === 'wall'
      ? splitWallByAir(teamFrom, teamTo, workerCount + 1)
      : splitBuildArea(teamFrom, teamTo, workerCount + 1)
  }

  const split = plannedSplit
  const { axis, chunks } = split

  const blockPlans = teamMode === 'wall'
    ? chunks.map(chunk =>
        estimateWallChunkBlocks(
          chunk,
          teamWallBandHeight
        )
      )
    : chunks.map(() => null)

  if (teamMode === 'wall') {
    const planSummary = blockPlans
      .map((plan, i) => {
        const name = i === 0 ? 'L' : ('W' + i)
        return name +
          ' main=' + plan.mainRequired +
          ' temp=' + plan.scaffoldRequired +
          ' total=' + plan.requiredBlocks
      })
      .join(' | ')

    queueOwnerMessage(
      '[TEAM] BLOCK PLAN | ' + planSummary
    )
  }

  teamTaskId += 1
  const taskId = teamTaskId

  queueOwnerMessage(
    '[TEAM] START task#' + taskId +
    ' block=' + teamBlockName +
    ' mode=' + teamMode.toUpperCase() +
    ' bots=' + chunks.length +
    ' split=' + axis.toUpperCase() +
    (split.airBalanced ? ' air=' + split.totalAir : '')
  )

  const leaderChunk = chunks[0]

  if (builder.state !== 'STOPPED' && builder.state !== 'DONE') {
    builder.forceStop(false)
  }

  builder.blockName = teamBlockName
  builder.mode = teamMode
  builder.wallBandHeight = teamWallBandHeight
  builder.wallSide = teamWallSide
  builder.from = clonePoint(leaderChunk.from)
  builder.to = clonePoint(leaderChunk.to)

  for (let i = 1; i < chunks.length; i++) {
    const task = {
      id: taskId,
      block: teamBlockName,
      mode: teamMode,
      wallBandHeight: teamWallBandHeight,
      wallSide: teamWallSide,
      from: clonePoint(chunks[i].from),
      to: clonePoint(chunks[i].to),
      storages: sharedStorages,
      preloadMainTarget: blockPlans[i]
        ? blockPlans[i].mainRequired
        : 0,
      preloadScaffoldTarget: blockPlans[i]
        ? blockPlans[i].scaffoldRequired
        : 0,
      blockPlan: blockPlans[i]
    }

    pendingTeamTasks.set(i, task)

    const child = workerChildren.get(i)

    if (child && child.connected) {
      child.send({
        type: 'task',
        task
      })
    } else {
      console.log('[TEAM] W' + i + ' not spawned yet; task queued')
    }
  }

  for (let i = chunks.length; i <= WORKER_USERNAMES.length; i++) {
    const child = workerChildren.get(i)
    if (child && child.connected) {
      child.send({ type: 'control', command: 'หยุด' })
    }
  }

  await builder.start({
    useExistingStorages: true,
    preloadMainTarget: blockPlans[0]
      ? blockPlans[0].mainRequired
      : 0,
    preloadScaffoldTarget: blockPlans[0]
      ? blockPlans[0].scaffoldRequired
      : 0
  })
}

async function handleOwnerCommand(message) {
  const raw = String(message || '').trim()
  if (!raw) return

  const args = raw.split(/\s+/)
  const command = args[0].toLowerCase()

  if (command === 'เริ่ม' || command === 'start') {
    let workerCount = 3

    if (args[1] !== undefined) {
      const parsed = Number(String(args[1]).replace(/[^0-9]/g, ''))

      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 3) {
        queueOwnerMessage(
          '[ALERT] Worker count must be 0-3. Example: เริ่ม 3 ตัว'
        )
        return
      }

      workerCount = parsed
    }

    await distributeTeamBuild(workerCount)
    return
  }

  if (
    command === 'พัก' || command === 'pause' ||
    command === 'ต่อ' || command === 'resume' ||
    command === 'หยุด' || command === 'stop'
  ) {
    await builder.handleCommand(raw)

    for (const child of workerChildren.values()) {
      if (child.connected) {
        child.send({ type: 'control', command: raw })
      }
    }
    return
  }

  if (command === 'status' || command === 'สถานะ') {
    await builder.handleCommand(raw)

    for (const child of workerChildren.values()) {
      if (child.connected) child.send({ type: 'status-request' })
    }
    return
  }

  await builder.handleCommand(raw)

  if (command === 'from' || command === 'pos1') {
    teamFrom = clonePoint(builder.from)
  } else if (command === 'to' || command === 'pos2') {
    teamTo = clonePoint(builder.to)
  } else if (command === 'mode') {
    teamMode = builder.mode
  } else if (command === 'band') {
    teamWallBandHeight = builder.wallBandHeight
  } else if (command === 'side') {
    teamWallSide = builder.wallSide
  } else {
    teamBlockName = builder.blockName
  }
}

async function maybeStartWorkerTask() {
  if (IS_LEADER) return
  if (!builder.ready || !pendingWorkerTask || workerTaskStarting) return

  workerTaskStarting = true
  const task = pendingWorkerTask
  pendingWorkerTask = null

  try {
    if (builder.state !== 'STOPPED' && builder.state !== 'DONE') {
      builder.forceStop(false)
    }

    console.log(
      '[WORKER ' + WORKER_INDEX + '] task#' + task.id +
      ' starting from rallied position'
    )

    builder.blockName = task.block
    builder.mode = task.mode || 'stream'
    builder.wallBandHeight = task.wallBandHeight || (config.wallBandHeight || 3)
    builder.wallSide = task.wallSide || 'auto'
    builder.wallNormalSign = null
    builder.from = clonePoint(task.from)
    builder.to = clonePoint(task.to)
    builder.importStorages(task.storages || [])

    console.log(
      '[WORKER ' + WORKER_INDEX + '] imported storage snapshot=' +
      builder.storagePositions.length
    )

    if (process.send) {
      process.send({
        type: 'worker-started',
        workerIndex: WORKER_INDEX,
        username: USERNAME,
        from: task.from,
        to: task.to,
        preloadMainTarget: task.preloadMainTarget || 0,
        preloadScaffoldTarget: task.preloadScaffoldTarget || 0
      })
    }

    await builder.start({
      useExistingStorages: true,
      preloadMainTarget: task.preloadMainTarget || 0,
      preloadScaffoldTarget: task.preloadScaffoldTarget || 0
    })
  } catch (err) {
    console.log('[WORKER TASK ERROR] ' + (err.stack || err.message))

    if (process.send) {
      process.send({
        type: 'worker-report',
        workerIndex: WORKER_INDEX,
        username: USERNAME,
        text: '[ALERT] Worker task error: ' + err.message
      })
    }
  } finally {
    workerTaskStarting = false
  }
}

if (!IS_LEADER) {
  process.on('message', message => {
    if (!message || typeof message !== 'object') return

    if (message.type === 'storage-lock-response') {
      const waiter = storageLockWaiters.get(message.requestId)

      if (waiter) {
        clearTimeout(waiter.timer)
        storageLockWaiters.delete(message.requestId)
        waiter.resolve(Boolean(message.granted))
      }

      return
    }

    if (message.type === 'rally') {
      if (!builder.ready) return

      if (builder.state !== 'STOPPED' && builder.state !== 'DONE') {
        builder.forceStop(false)
      }

      workerRallyPending = true
      console.log(
        '[WORKER ' + WORKER_INDEX + '] rally -> TPA ' + LEADER_USERNAME
      )

      bot.chat('/tpa ' + LEADER_USERNAME)

      if (process.send) {
        process.send({
          type: 'tpa-request',
          workerIndex: WORKER_INDEX,
          username: USERNAME
        })
      }

      return
    }

    if (message.type === 'task') {
      pendingWorkerTask = message.task
      maybeStartWorkerTask().catch(err => {
        console.log('[WORKER START ERROR] ' + err.message)
      })
      return
    }

    if (message.type === 'control') {
      builder.handleCommand(message.command).catch(err => {
        console.log('[WORKER CONTROL ERROR] ' + err.message)
      })
      return
    }

    if (message.type === 'status-request') {
      if (process.send) {
        process.send({
          type: 'worker-status',
          workerIndex: WORKER_INDEX,
          username: USERNAME,
          text: builder.statusText()
        })
      }
    }
  })
}

function safeJson(v) {
  try {
    return JSON.stringify(v, (_, x) => {
      if (typeof x === 'bigint') return x.toString()
      if (Buffer.isBuffer(x)) return { type: 'Buffer', length: x.length }
      return x
    }, 2)
  } catch {
    return String(v)
  }
}

function nbtValue(node) {
  if (node == null || typeof node !== 'object') return node
  const isNBT =
    typeof node.type === 'string' &&
    Object.prototype.hasOwnProperty.call(node, 'value')

  if (!isNBT) {
    if (Array.isArray(node)) return node.map(nbtValue)
    const out = {}
    for (const [k, v] of Object.entries(node)) out[k] = nbtValue(v)
    return out
  }

  if (['string','int','byte','short','long','float','double',
    'intArray','byteArray','longArray'].includes(node.type)) {
    return node.value
  }

  if (node.type === 'compound') {
    const out = {}
    for (const [k, v] of Object.entries(node.value || {})) out[k] = nbtValue(v)
    return out
  }

  if (node.type === 'list') {
    const v = node.value
    if (!v) return []
    if (Array.isArray(v)) return v.map(nbtValue)
    if (Array.isArray(v.value)) return v.value.map(nbtValue)
    return []
  }
  return nbtValue(node.value)
}
function componentText(c) {
  if (!c) return ''
  if (typeof c === 'string') return c
  if (c.text !== undefined) return String(c.text)
  if (c.contents !== undefined) return componentText(c.contents)
  return ''
}

function varInt(value) {
  const a = []
  value >>>= 0
  do {
    let t = value & 0x7f
    value >>>= 7
    if (value !== 0) t |= 0x80
    a.push(t)
  } while (value !== 0)
  return Buffer.from(a)
}

function mcString(s) {
  const b = Buffer.from(String(s), 'utf8')
  return Buffer.concat([varInt(b.length), b])
}

function nbtString(name, value) {
  const n = Buffer.from(String(name), 'utf8')
  const v = Buffer.from(String(value), 'utf8')
  const b = Buffer.alloc(1 + 2 + n.length + 2 + v.length)
  let o = 0
  b.writeUInt8(0x08, o++)
  b.writeUInt16BE(n.length, o); o += 2
  n.copy(b, o); o += n.length
  b.writeUInt16BE(v.length, o); o += 2
  v.copy(b, o)
  return b
}

function nbtIntArray(name, values) {
  const n = Buffer.from(String(name), 'utf8')
  const b = Buffer.alloc(1 + 2 + n.length + 4 + values.length * 4)
  let o = 0
  b.writeUInt8(0x0b, o++)
  b.writeUInt16BE(n.length, o); o += 2
  n.copy(b, o); o += n.length
  b.writeInt32BE(values.length, o); o += 4
  for (const v of values) {
    b.writeInt32BE(Number(v), o)
    o += 4
  }
  return b
}

function formNBT(uuid, fields) {
  const p = [Buffer.from([0x0a]), nbtIntArray('id', uuid)]
  for (const [k, v] of Object.entries(fields)) p.push(nbtString(k, v))
  p.push(Buffer.from([0x00]))
  return Buffer.concat(p)
}
function sendDialogAction(actionId, uuid, fields) {
  const nbt = formNBT(uuid, fields)
  const raw = Buffer.concat([
    varInt(0x41),
    mcString(actionId),
    varInt(nbt.length),
    nbt
  ])
  bot._client.writeRaw(raw)
  console.log('[AUTH] submitted fields: ' + Object.keys(fields).join(', '))
}

function inputFields(inputs) {
  const out = {}
  for (const input of inputs) {
    const key = String(input.key || '')
    const low = key.toLowerCase()
    if (!key) continue

    if (low.includes('password')) out[key] = PASSWORD
    else if (low.includes('username') || low === 'user' || low === 'name') {
      out[key] = USERNAME
    } else if (input.initial !== undefined) out[key] = String(input.initial)
    else if (input.value !== undefined) out[key] = String(input.value)
  }
  return out
}

function findButton(actions, words) {
  return actions.find(a => {
    const label = componentText(a.label).toLowerCase()
    return words.some(w => label.includes(w))
  }) || actions.find(a => a.action)
}
async function handleDialog(packet) {
  try {
    const raw = packet && packet.dialog && packet.dialog.data
    if (!raw) return

    const d = nbtValue(raw)
    const title = componentText(d.title)
    const inputs = Array.isArray(d.inputs) ? d.inputs.filter(Boolean) : []
    const actions = Array.isArray(d.actions) ? d.actions.filter(Boolean) : []
    const fields = inputs.map(x => String(x.key || '').toLowerCase())

    const register =
      title.toLowerCase().includes('register') ||
      title.toLowerCase().includes('สมัคร') ||
      fields.some(x => x.includes('confirm_password'))

    const mode = register ? 'REGISTER' : 'LOGIN'
    const words = register
      ? ['register', 'สมัคร', 'ยืนยัน']
      : ['login', 'เข้าสู่ระบบ', 'ล็อกอิน', 'ยืนยัน']

    const button = findButton(actions, words)
    const actionId = button && button.action && button.action.id
    const uuid = button && button.action && button.action.additions &&
      button.action.additions.id

    if (!actionId || !Array.isArray(uuid) || uuid.length !== 4) {
      throw new Error('Auth dialog callback not found')
    }
    const signature = mode + '|' + actionId + '|' + uuid.join(',')
    if (submitted.has(signature)) {
      console.log('[AUTH] duplicate ' + mode + ' dialog ignored')
      return
    }

    submitted.add(signature)
    authState = mode
    console.log('[AUTH] ' + mode + ' dialog: ' + title)

    await sleep(500)
    sendDialogAction(actionId, uuid, inputFields(inputs))
    authState = mode + '_SUBMITTED'
  } catch (err) {
    console.log('[AUTH ERROR] ' + (err.stack || err.message))
  }
}

bot.on('connect', () => console.log('[TCP CONNECTED]'))

function armGameReady(reason, delay = 1500) {
  setTimeout(() => {
    if (builder.ready) return

    bot.physicsEnabled = true
    authState = 'READY'
    builder.setReady(true)

    console.log(
      '[GAME SERVER] READY / ' +
      (IS_LEADER ? 'TEAM LEADER' : ('WORKER ' + WORKER_INDEX)) +
      ' via ' + reason
    )

    if (IS_LEADER) {
      console.log('[OWNER] private /msg from ' + OWNER + ' only')
      spawnWorkers()
    } else {
      if (process.send) {
        process.send({
          type: 'worker-ready',
          workerIndex: WORKER_INDEX,
          username: USERNAME
        })
      }

      maybeStartWorkerTask().catch(err => {
        console.log('[WORKER READY ERROR] ' + err.message)
      })
    }
  }, delay)
}

async function openServerSelector() {
  bot.physicsEnabled = true

  for (let i = 0; i < 40; i++) {
    const item = bot.inventory && bot.inventory.items().find(
      x => x.name === 'recovery_compass'
    )

    if (!item) {
      await sleep(250)
      continue
    }

    console.log('[LOBBY] Server Selector found in slot ' + item.slot)

    bot.once('windowOpen', async window => {
      await sleep(500)

      if (
        authState === 'READY' ||
        (bot.game && bot.game.gameMode === 'survival')
      ) {
        console.log('[LOBBY] ignoring stale selector window in game')
        return
      }

      console.log('[SERVER SELECTOR OPEN] ' + componentText(window.title))

      const entries = []
      for (let slot = 0; slot < window.slots.length; slot++) {
        const it = window.slots[slot]
        if (!it) continue

        const text = (
          it.name + ' ' +
          it.displayName + ' ' +
          safeJson(it.customName) + ' ' +
          safeJson(it.components)
        ).toLowerCase()

        entries.push({ slot, it, text })
        console.log('[MENU ITEM] slot=' + slot + ' text=' + text.slice(0, 220))
      }

      const selected = entries.find(x =>
        x.text.includes('survival') ||
        x.text.includes('hicraft') ||
        x.text.includes('hi-smp') ||
        x.text.includes('hismp')
      )

      if (!selected) {
        console.log('[LOBBY] Survival menu item not found')
        return
      }

      console.log(
        '[LOBBY] selecting game server slot=' +
        selected.slot + ' item=' + selected.it.name
      )

      try {
        await bot.clickWindow(selected.slot, 0, 0)
        console.log('[LOBBY] game server menu clicked')
      } catch (err) {
        console.log('[LOBBY CLICK ERROR] ' + err.message)
      }
    })

    bot.setQuickBarSlot(item.slot - 36)
    await sleep(2500)

    for (let attempt = 1; attempt <= 8 && !bot.currentWindow; attempt++) {
      if (
        spawnCount >= 2 ||
        (bot.game && bot.game.gameMode === 'survival')
      ) {
        console.log('[LOBBY] SMP entered successfully')
        armGameReady('survival-detected', 500)
        return
      }

      console.log(
        '[LOBBY] held=' +
        (bot.heldItem ? bot.heldItem.name : 'none') +
        ' quickBar=' + bot.quickBarSlot +
        ' attempt=' + attempt
      )

      bot.activateItem()
      await sleep(1500)
    }

    if (
      spawnCount >= 2 ||
      (bot.game && bot.game.gameMode === 'survival')
    ) {
      console.log('[LOBBY] SMP entered successfully')
      armGameReady('survival-detected', 500)
      return
    }

    if (bot.currentWindow) return

    console.log('[LOBBY] Could not enter SMP with Server Selector')
    return
  }

  console.log('[LOBBY] Server Selector not found')
}

bot.on('login', () => {
  loginCount++
  console.log('[LOGIN #' + loginCount + '] ' + USERNAME + ' ' + bot.version)
  if (loginCount >= 2) {
    authState = 'TRANSFER'
    builder.setReady(false)
    console.log('[TRANSFER] backend transfer detected')
    console.log('[WAIT] opening Server Selector before GAME SERVER SPAWN')
    openServerSelector().catch(err => console.log('[LOBBY ERROR] ' + err.message))

    setTimeout(() => {
      const items = bot.inventory
        ? bot.inventory.items().map(i => i.slot + ':' + i.name + 'x' + i.count)
        : []
      console.log(
        '[TRANSFER STATE] pos=' +
        (bot.entity ? bot.entity.position.toString() : 'no-entity') +
        ' gameMode=' + (bot.game ? bot.game.gameMode : 'unknown') +
        ' items=' + (items.join(', ') || 'empty')
      )

      if (bot.game && bot.game.gameMode === 'survival') {
        armGameReady('survival-state', 500)
      }
    }, 3000)
  }
})

bot.on('resourcePack', () => {
  try {
    bot.acceptResourcePack()
    console.log('[RESOURCE PACK] accepted')
  } catch (err) {
    console.log('[RESOURCE PACK ERROR] ' + err.message)
  }
})

bot.on('spawn', () => {
  spawnCount++
  console.log('[SPAWN #' + spawnCount + '] ' + (bot.entity ? bot.entity.position.toString() : 'no-entity') + ' gameMode=' + (bot.game ? bot.game.gameMode : 'unknown'))

  if (spawnCount === 1) {
    builder.setReady(false)
    console.log('[AUTH SERVER] waiting for login/register')
    return
  }

  console.log('[GAME SERVER SPAWNED] enabling builder after server settles')
  armGameReady('spawn#' + spawnCount, 2000)
})

bot._client.on('packet', (data, meta) => {
  if (!meta || !meta.name) return
  if (meta.name === 'show_dialog') handleDialog(data)
})

bot.on('whisper', (username, message) => {
  console.log('[WHISPER] ' + username + ': ' + message)

  if (!IS_LEADER) return

  if (
    String(username).toLowerCase() !==
    String(OWNER).toLowerCase()
  ) {
    console.log('[WHISPER] ignored unauthorized sender')
    return
  }

  handleOwnerCommand(message).catch(err => {
    console.log('[COMMAND ERROR] ' + (err.stack || err.message))
    builder.alertOwner('Command error: ' + err.message, true)
  })
})

bot.on('messagestr', message => {
  const text = String(message)
  const lower = text.toLowerCase()
  console.log('[MSG] ' + text)

  const customWhisper = text.match(
    /\[?กระซิบ\]?\s*\|\s*([^\s]+)\s*(?:➜|➔|→|->)\s*ฉัน\s*»\s*(.+)$/i
  )

  if (customWhisper) {
    const sender = customWhisper[1].trim()
    const commandText = customWhisper[2].trim()

    console.log('[CUSTOM WHISPER] ' + sender + ': ' + commandText)

    if (
      IS_LEADER &&
      sender.toLowerCase() ===
      String(OWNER).toLowerCase()
    ) {
      handleOwnerCommand(commandText).catch(err => {
        console.log('[COMMAND ERROR] ' + (err.stack || err.message))
        builder.alertOwner('Command error: ' + err.message, true)
      })
    } else if (IS_LEADER) {
      console.log('[CUSTOM WHISPER] ignored unauthorized sender')
    }
  }

  if (
    !IS_LEADER &&
    workerRallyPending &&
    text.includes('TPA > วาร์ปไปยังเป้าหมายสำเร็จ')
  ) {
    workerRallyPending = false

    console.log(
      '[WORKER ' + WORKER_INDEX + '] TPA success; waiting for chunks'
    )

    setTimeout(async () => {
      const escaped = await verifyWorkerCanEscape()

      if (!process.send) return

      process.send({
        type: escaped ? 'worker-rallied' : 'worker-rally-failed',
        workerIndex: WORKER_INDEX,
        username: USERNAME
      })
    }, 2000)
  }

  if (
    lower.includes('wrong password') ||
    lower.includes('incorrect password') ||
    lower.includes('รหัสผ่านผิด') ||
    lower.includes('รหัสผ่านไม่ถูกต้อง')
  ) {
    authState = 'WRONG_PASSWORD'
  }
})

setInterval(() => {
  console.log('[STATUS] auth=' + authState + ' | ' + builder.statusText())
}, 30000).unref()
bot._client.on('disconnect', packet => {
  ownerMessageQueue.length = 0
  builder.setReady(false)
  console.log('[DISCONNECT] ' + safeJson(packet))
})

bot.on('kicked', reason => {
  ownerMessageQueue.length = 0
  builder.setReady(false)
  console.log('[KICKED] ' + safeJson(reason))
})

bot.on('error', err => {
  console.log('[ERROR] ' + err.message)

  if (bot._client && bot._client.state === 'play') {
    builder.alertOwner('Bot error: ' + err.message, true)
  }
})

bot.on('end', reason => {
  ownerMessageQueue.length = 0
  authState = 'OFFLINE'
  builder.setReady(false)
  console.log('[END] ' + reason)

  if (!IS_LEADER) {
    if (process.send) {
      process.send({
        type: 'worker-report',
        workerIndex: WORKER_INDEX,
        username: USERNAME,
        text: '[ALERT] Worker disconnected: ' + reason
      })
    }

    setTimeout(() => process.exit(2), 1000)
  }
})

process.on('SIGINT', () => {
  builder.forceStop(false)

  if (IS_LEADER) {
    for (const child of workerChildren.values()) {
      try { child.kill('SIGINT') } catch {}
    }
  }

  try { bot.quit('Builder bot stopped') } catch {}
  setTimeout(() => process.exit(0), 500)
})
console.log('======================================')
console.log(' Mineflayer Turbo Builder')
console.log('======================================')
console.log('Server : ' + HOST + ':' + PORT)
console.log('Bot    : ' + USERNAME)
console.log('Role   : ' + (IS_LEADER ? 'LEADER' : ('WORKER ' + WORKER_INDEX)))
console.log('Owner  : ' + OWNER)
console.log('Mode   : ' + (IS_LEADER ? 'TEAM CONTROL / private message only' : 'IPC WORKER'))
console.log('======================================')
