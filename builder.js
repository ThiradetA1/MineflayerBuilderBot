const { Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

const { GoalNear, GoalPlaceBlock, GoalBlock } = goals
const AIR = new Set(['air', 'cave_air', 'void_air'])

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class Builder {
  constructor(bot, options = {}) {
    this.bot = bot
    this.owner = options.owner
    this.replyFn = options.reply || (() => {})
    this.placeDelayTicks = options.placeDelayTicks ?? 0
    this.progressEvery = options.progressEvery || 250
    this.burstSize = options.burstSize || 8
    this.storageSearchRadius = options.storageSearchRadius || 48
    this.storageMaxContainers = options.storageMaxContainers || 64
    this.stuckTimeoutMs = options.stuckTimeoutMs || 30000
    this.pathTimeoutMs = options.pathTimeoutMs || 20000
    this.acquireStorageLockFn =
      options.acquireStorageLock || (async () => true)
    this.releaseStorageLockFn =
      options.releaseStorageLock || (() => {})

    this.ready = false
    this.state = 'STOPPED'
    this.from = null
    this.to = null
    this.blockName = 'stone'

    this.mode = 'stream'
    this.streamReverseX = false
    this.wallBandHeight = options.wallBandHeight || 3
    this.wallReserveBlocks = options.wallReserveBlocks || 128
    this.wallScaffoldBlockName = options.wallScaffoldBlockName || 'netherrack'
    this.wallScaffoldReserve = options.wallScaffoldReserve || 64
    this.wallSide = 'auto'
    this.wallNormalSign = null
    this.wallPlane = null
    this.wallBand = 0
    this.wallCheckpoint = null
    this.wallCurrentTarget = null
    this.wallScaffolds = new Map()
    this.wallLaneByBase = new Map()
    this.wallRampByBase = new Map()
    this.wallRampRoutes = new Map()
    this.wallVerified = 0

    this.index = 0
    this.total = 0
    this.runToken = 0

    this.placed = 0
    this.skipped = 0
    this.failed = 0
    this.noSupport = 0

    this.storagePositions = []
    this.storageCursor = 0
    this.refillCount = 0
    this.badBurstStreak = 0
    this.repairQueue = new Set()
    this.repairPass = 0
    this.repaired = 0
    this.repairCurrentIndex = null

    this.lastProgressAt = Date.now()
    this.lastProgressIndex = 0
    this.lastAlertKey = ''
    this.lastAlertAt = 0
    this.traveling = false

    this.watchdog = setInterval(() => {
      this.checkWatchdog()
    }, 5000)
    if (this.watchdog.unref) this.watchdog.unref()
  }

  touchProgress() {
    this.lastProgressAt = Date.now()
    this.lastProgressIndex = this.index
  }

  alertOwner(reason, pause = true) {
    const now = Date.now()
    const key = String(reason)

    if (
      key === this.lastAlertKey &&
      now - this.lastAlertAt < 15000
    ) {
      return
    }

    this.lastAlertKey = key
    this.lastAlertAt = now

    if (pause && ['RUNNING', 'REFILLING', 'PREPARING'].includes(this.state)) {
      this.state = 'PAUSED'
      this.stopMovement()
    }

    const alertIndex = this.repairCurrentIndex ?? this.index
    const target =
      this.mode === 'wall' && this.wallCurrentTarget
        ? this.wallCurrentTarget
        : this.targetAt(alertIndex)
    const pos = target
      ? target.x + ' ' + target.y + ' ' + target.z
      : 'unknown'

    this.reply(
      '[ALERT] ' + reason +
      ' | state=' + this.state +
      ' | block=' + this.blockName +
      ' | index=' + alertIndex + '/' + this.total +
      ' | target=' + pos
    )
  }

  checkWatchdog() {
    if (!['RUNNING', 'REFILLING', 'PREPARING'].includes(this.state)) return

    if (this.bot.entity) {
      const feet = this.bot.blockAt(
        this.bot.entity.position.floored()
      )

      if (feet && feet.name === 'water') {
        this.alertOwner(
          'Fell into water - movement stopped for safety',
          true
        )
        return
      }
    }

    if (this.traveling) {
      return
    }

    const idleMs = Date.now() - this.lastProgressAt

    if (idleMs >= this.stuckTimeoutMs) {
      this.alertOwner(
        'No progress for ' + Math.round(idleMs / 1000) + 's',
        true
      )
    }
  }

  async withTimeout(promise, ms, label) {
    let timer

    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(label + ' timeout after ' + ms + 'ms'))
          }, ms)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  reply(message) {
    console.log('[BUILDER] ' + message)
    try {
      this.replyFn(String(message))
    } catch (err) {
      console.log('[REPLY ERROR] ' + err.message)
    }
  }

  setReady(value) {
    this.ready = Boolean(value)

    if (this.ready) {
      this.configurePathfinder()
    } else {
      this.forceStop(false)
    }
  }

  configurePathfinder() {
    const movements = new Movements(this.bot)

    movements.canDig = false
    movements.allow1by1towers = false
    movements.allowParkour = false
    movements.allowSprinting = true
    movements.maxDropDown = 1
    movements.infiniteLiquidDropdownDistance = false
    movements.liquidCost = 100
    movements.scafoldingBlocks = []

    const water = this.bot.registry.blocksByName.water
    if (water) {
      movements.blocksToAvoid.add(water.id)
    }

    this.movements = movements
    this.bot.pathfinder.setMovements(movements)

    console.log('[BUILDER] FAST STREAM: sprint-safe row movement, forward-only placement')
  }

  normalizeBlockName(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/^minecraft:/, '')
      .replace(/[\s-]+/g, '_')
  }

  validateBlockName(name) {
    const clean = this.normalizeBlockName(name)
    return Boolean(
      this.bot.registry &&
      this.bot.registry.itemsByName[clean] &&
      this.bot.registry.blocksByName[clean]
    )
  }

  resolveBlockName(name) {
    const clean = this.normalizeBlockName(name)
    const candidates = [clean]

    if (clean && !clean.endsWith('s')) {
      candidates.push(clean + 's')
    }

    if (clean.endsWith('_plank')) {
      candidates.push(clean + 's')
    }

    for (const candidate of candidates) {
      if (this.validateBlockName(candidate)) {
        return candidate
      }
    }

    return null
  }

  parseXYZ(args) {
    if (args.length < 4) return null

    const x = Number(args[1])
    const y = Number(args[2])
    const z = Number(args[3])

    if (![x, y, z].every(Number.isFinite)) return null

    return {
      x: Math.trunc(x),
      y: Math.trunc(y),
      z: Math.trunc(z)
    }
  }

  dimensions() {
    if (!this.from || !this.to) return null

    const minX = Math.min(this.from.x, this.to.x)
    const maxX = Math.max(this.from.x, this.to.x)
    const minY = Math.min(this.from.y, this.to.y)
    const maxY = Math.max(this.from.y, this.to.y)
    const minZ = Math.min(this.from.z, this.to.z)
    const maxZ = Math.max(this.from.z, this.to.z)

    const dx = maxX - minX + 1
    const dy = maxY - minY + 1
    const dz = maxZ - minZ + 1

    return {
      minX, maxX, minY, maxY, minZ, maxZ,
      dx, dy, dz,
      total: dx * dy * dz
    }
  }

  targetAt(index) {
    const d = this.dimensions()
    if (!d) return null

    const perLayer = d.dx * d.dz
    const layerIndex = Math.floor(index / perLayer)
    const insideLayer = index % perLayer
    const zIndex = Math.floor(insideLayer / d.dx)
    const xOffset = insideLayer % d.dx

    const y = d.minY + layerIndex
    const z = d.minZ + zIndex
    const evenRow = zIndex % 2 === 0
    const increasingX = this.streamReverseX
      ? !evenRow
      : evenRow
    const x = increasingX
      ? d.minX + xOffset
      : d.maxX - xOffset

    return new Vec3(x, y, z)
  }

  statusText() {
    const pct = this.total > 0
      ? ((this.index / this.total) * 100).toFixed(1)
      : '0.0'

    const area = this.from && this.to
      ? this.from.x + ',' + this.from.y + ',' + this.from.z +
        ' -> ' + this.to.x + ',' + this.to.y + ',' + this.to.z
      : 'not set'

    return this.state +
      ' | block=' + this.blockName +
      ' | ' + this.index + '/' + this.total + ' (' + pct + '%)' +
      ' | placed=' + this.placed +
      ' skip=' + this.skipped +
      ' fail=' + this.failed +
      ' noSupport=' + this.noSupport +
      ' | stores=' + this.storagePositions.length +
      ' refill=' + this.refillCount +
      ' mode=' + this.mode.toUpperCase() +
      (this.mode === 'wall'
        ? ' band=' + this.wallBand +
          ' bandH=' + this.wallBandHeight +
          ' verified=' + this.wallVerified
        : '') +
      ' | ' + area
  }

  isStorageBlock(block) {
    if (!block) return false
    return (
      block.name === 'chest' ||
      block.name === 'trapped_chest' ||
      block.name === 'shulker_box' ||
      block.name.endsWith('_shulker_box')
    )
  }

  inventoryItemCount(itemName) {
    return this.bot.inventory.items()
      .filter(item => item.name === itemName)
      .reduce((sum, item) => sum + item.count, 0)
  }

  inventoryBlockCount() {
    return this.inventoryItemCount(this.blockName)
  }

  scaffoldBlockCount() {
    return this.inventoryItemCount(this.wallScaffoldBlockName)
  }

  inventoryItemCapacity(itemName) {
    const itemDef = this.bot.registry.itemsByName[itemName]
    if (!itemDef) return 0

    const stackSize = itemDef.stackSize || 64
    let capacity = this.bot.inventory.emptySlotCount() * stackSize

    for (const item of this.bot.inventory.items()) {
      if (item.name !== itemName) continue
      capacity += Math.max(0, stackSize - item.count)
    }

    return capacity
  }

  inventoryItemStackCount(itemName) {
    return this.bot.inventory.items()
      .filter(item => item && item.name === itemName)
      .length
  }

  async stashNonTargetItemsInEmptyStorage(
    token,
    targetItemName
  ) {
    if (!this.bot.entity) return false

    const nonTargetItems = () =>
      this.bot.inventory.items().filter(
        item => item && item.name !== targetItemName
      )

    if (nonTargetItems().length <= 0) return true

    const origin = this.bot.entity.position

    const orderedStorages = this.storagePositions
      .map((storage, index) => {
        const pos = storage.pos
        const dx = pos.x - origin.x
        const dz = pos.z - origin.z
        const dy = Math.abs(pos.y - origin.y)
        const horizontal = Math.sqrt((dx * dx) + (dz * dz))

        return {
          storage,
          index,
          dy,
          score: (dy * 12) + horizontal
        }
      })
      .filter(entry =>
        this.mode !== 'wall' || entry.dy <= 8
      )
      .sort((a, b) => a.score - b.score)

    let usedEmptyStorages = 0
    let depositedTotal = 0

    for (const entry of orderedStorages) {
      if (nonTargetItems().length <= 0) break

      if (
        token !== this.runToken ||
        this.state === 'STOPPED'
      ) {
        return false
      }

      const storage = entry.storage
      const pos = storage.pos
      const lockKey = pos.x + ',' + pos.y + ',' + pos.z
      let lockAcquired = false
      let container = null

      try {
        lockAcquired = await this.acquireStorageLockFn(lockKey)
        if (!lockAcquired) continue

        this.traveling = true
        this.touchProgress()

        try {
          await this.withTimeout(
            this.bot.pathfinder.goto(
              new GoalNear(pos.x, pos.y, pos.z, 2)
            ),
            this.mode === 'wall'
              ? Math.min(
                  Math.max(this.pathTimeoutMs, 12000),
                  20000
                )
              : this.pathTimeoutMs,
            'empty stash path'
          )
        } finally {
          this.traveling = false
          this.touchProgress()
        }

        const block = this.bot.blockAt(pos)
        if (!this.isStorageBlock(block)) continue

        container = await this.withTimeout(
          this.bot.openContainer(block),
          10000,
          'open empty stash storage'
        )
        await sleep(100)

        const end = container.inventoryStart || 0
        let occupied = 0

        for (let slot = 0; slot < end; slot++) {
          if (container.slots[slot]) occupied += 1
        }

        // Only use a truly empty chest/shulker for temporary stash.
        if (occupied > 0) continue

        usedEmptyStorages += 1

        this.reply(
          'STASH EMPTY STORAGE | target=' + targetItemName +
          ' -> ' + pos.x + ' ' + pos.y + ' ' + pos.z
        )

        const snapshot = nonTargetItems()

        for (const item of snapshot) {
          if (
            token !== this.runToken ||
            this.state === 'STOPPED'
          ) {
            return false
          }

          const current = this.bot.inventory.items().find(
            invItem =>
              invItem &&
              invItem.name === item.name &&
              invItem.metadata === item.metadata
          )

          if (!current) continue

          try {
            await this.withTimeout(
              container.deposit(
                current.type,
                null,
                current.count
              ),
              15000,
              'stash ' + current.name
            )

            depositedTotal += current.count
            this.touchProgress()
          } catch (err) {
            console.log(
              '[STASH ITEM FAILED] ' +
              current.name + ' x' + current.count +
              ' @ ' + pos.toString() +
              ' -> ' + err.message
            )

            // This empty storage may have become full. Continue with
            // another empty storage for anything still in inventory.
            break
          }
        }

        this.storageCursor = entry.index
      } catch (err) {
        console.log(
          '[STASH EMPTY STORAGE FAILED] ' +
          pos.toString() + ' -> ' + err.message
        )
      } finally {
        if (container) {
          try {
            container.close()
          } catch {}
        }

        if (lockAcquired) {
          try {
            await Promise.resolve(
              this.releaseStorageLockFn(lockKey)
            )
          } catch {}
        }
      }
    }

    const remaining = nonTargetItems()

    if (remaining.length > 0) {
      this.alertOwner(
        'STASH SHORTAGE | target=' + targetItemName +
        ' | no reachable empty chest/shulker for ' +
        remaining.reduce(
          (sum, item) => sum + item.count,
          0
        ) +
        ' remaining non-target item(s)',
        true
      )
      return false
    }

    this.reply(
      'STASH COMPLETE | target=' + targetItemName +
      ' | stored=' + depositedTotal +
      ' item(s) in ' + usedEmptyStorages +
      ' empty storage(s)'
    )

    return true
  }

  async reserveInventorySlotsForItem(
    token,
    itemName,
    requestedCount
  ) {
    const itemDef = this.bot.registry.itemsByName[itemName]
    if (!itemDef) return false

    const stackSize = itemDef.stackSize || 64
    const requested = Math.max(
      0,
      Math.ceil(Number(requestedCount) || 0)
    )

    if (requested <= 0) return true

    const currentCount = this.inventoryItemCount(itemName)
    const missingCount = Math.max(0, requested - currentCount)

    if (missingCount <= 0) {
      return true
    }

    const currentStacks = this.inventoryItemStackCount(itemName)
    const targetStacks = Math.ceil(requested / stackSize)

    // On this server/container flow, withdraw can require REAL empty
    // inventory slots even when partial stacks of the same item exist.
    // Reserve enough physical empty slots for the missing quantity.
    const requiredEmptySlots = Math.ceil(
      missingCount / stackSize
    )

    const emptySlots = this.bot.inventory.emptySlotCount()

    if (emptySlots >= requiredEmptySlots) {
      return true
    }

    this.reply(
      'MATERIAL SLOT PREP | ' + itemName +
      ' need=' + requested +
      ' have=' + currentCount +
      ' missing=' + missingCount +
      ' requiredEmpty=' + requiredEmptySlots +
      ' currentStacks=' + currentStacks +
      ' empty=' + emptySlots +
      ' | stashing all other items'
    )

    const stashed = await this.stashNonTargetItemsInEmptyStorage(
      token,
      itemName
    )

    if (!stashed) return false

    const emptyAfter = this.bot.inventory.emptySlotCount()

    if (emptyAfter < requiredEmptySlots) {
      this.alertOwner(
        'MATERIAL SLOT SHORTAGE | ' + itemName +
        ' missing=' + missingCount +
        ' requiredEmpty=' + requiredEmptySlots +
        ' emptyAfterStash=' + emptyAfter,
        true
      )
      return false
    }

    return true
  }

  containerItemCount(container, itemName) {
    let count = 0
    const end = container.inventoryStart || 0

    for (let slot = 0; slot < end; slot++) {
      const item = container.slots[slot]
      if (item && item.name === itemName) {
        count += item.count
      }
    }

    return count
  }

  containerBlockCount(container) {
    return this.containerItemCount(container, this.blockName)
  }

  captureStoragesNow() {
    if (!this.bot.entity) return []

    const origin = this.bot.entity.position.clone()

    const positions = this.bot.findBlocks({
      matching: block => this.isStorageBlock(block),
      point: origin,
      maxDistance: this.storageSearchRadius,
      count: this.storageMaxContainers
    })

    this.storagePositions = positions
      .map(pos => {
        const block = this.bot.blockAt(pos)
        return {
          pos: pos.clone(),
          name: block ? block.name : 'unknown',
          lastKnownCount: null
        }
      })
      .filter(entry => entry.name !== 'unknown')

    this.storageCursor = 0

    return this.exportStorages()
  }

  exportStorages() {
    return this.storagePositions.map(entry => ({
      x: entry.pos.x,
      y: entry.pos.y,
      z: entry.pos.z,
      name: entry.name || 'unknown'
    }))
  }

  importStorages(entries) {
    if (!Array.isArray(entries)) {
      this.storagePositions = []
      this.storageCursor = 0
      return
    }

    this.storagePositions = entries
      .filter(entry =>
        entry &&
        Number.isFinite(Number(entry.x)) &&
        Number.isFinite(Number(entry.y)) &&
        Number.isFinite(Number(entry.z))
      )
      .map(entry => ({
        pos: new Vec3(
          Number(entry.x),
          Number(entry.y),
          Number(entry.z)
        ),
        name: entry.name || 'unknown',
        lastKnownCount: null
      }))

    this.storageCursor = 0
  }

  async scanStorages(token) {
    if (!this.bot.entity) return

    const origin = this.bot.entity.position.clone()

    const positions = this.bot.findBlocks({
      matching: block => this.isStorageBlock(block),
      point: origin,
      maxDistance: this.storageSearchRadius,
      count: this.storageMaxContainers
    })

    if (token !== this.runToken || this.state === 'STOPPED') return

    this.storagePositions = positions
      .map(pos => {
        const block = this.bot.blockAt(pos)
        return {
          pos: pos.clone(),
          name: block ? block.name : 'unknown',
          lastKnownCount: null
        }
      })
      .filter(entry => entry.name !== 'unknown')

    this.storageCursor = 0
    this.touchProgress()

    this.reply(
      'Storage ready: remembered ' + this.storagePositions.length +
      ' chest/shulker within ' + this.storageSearchRadius + ' blocks'
    )
  }

  foreignInventoryItems() {
    const allowed = new Set([this.blockName])

    if (this.mode === 'wall') {
      allowed.add(this.wallScaffoldBlockName)
    }

    return this.bot.inventory.items().filter(
      item => item && !allowed.has(item.name)
    )
  }

  randomDropCandidates() {
    if (!this.bot.entity) return []

    const origin = this.bot.entity.position.floored()
    const candidates = []
    const seen = new Set()

    for (let attempt = 0; attempt < 40; attempt++) {
      const dx = Math.floor(Math.random() * 21) - 10
      const dz = Math.floor(Math.random() * 21) - 10
      const horizontal = Math.sqrt((dx * dx) + (dz * dz))

      if (horizontal < 5 || horizontal > 10) continue

      const x = origin.x + dx
      const z = origin.z + dz

      for (let dy = 2; dy >= -2; dy--) {
        const pos = new Vec3(x, origin.y + dy, z)
        const key = pos.x + ',' + pos.y + ',' + pos.z

        if (seen.has(key)) continue
        seen.add(key)

        if (this.isStandablePosition(pos)) {
          candidates.push(pos)
          break
        }
      }

      if (candidates.length >= 12) break
    }

    candidates.sort((a, b) => {
      const da = this.bot.entity.position.distanceTo(
        a.offset(0.5, 0, 0.5)
      )
      const db = this.bot.entity.position.distanceTo(
        b.offset(0.5, 0, 0.5)
      )
      return db - da
    })

    return candidates
  }

  async moveToRandomDropSpot(token) {
    const candidates = this.randomDropCandidates()

    for (const pos of candidates) {
      if (token !== this.runToken || this.state === 'STOPPED') return false

      try {
        this.traveling = true
        this.touchProgress()

        await this.withTimeout(
          this.bot.pathfinder.goto(
            new GoalBlock(pos.x, pos.y, pos.z)
          ),
          Math.max(this.pathTimeoutMs, 20000),
          'inventory clean path'
        )

        this.traveling = false
        this.touchProgress()

        console.log(
          '[CLEAN] random drop spot=' +
          pos.x + ' ' + pos.y + ' ' + pos.z
        )

        return true
      } catch (err) {
        this.traveling = false
        this.stopMovement()
        this.touchProgress()

        console.log(
          '[CLEAN PATH FAILED] ' +
          pos.x + ' ' + pos.y + ' ' + pos.z +
          ' -> ' + err.message
        )
      }
    }

    this.traveling = false
    return false
  }

  async moveNearStorageForClean(token) {
    if (!this.storagePositions.length) return false

    const startCursor = this.storageCursor

    for (let offset = 0; offset < this.storagePositions.length; offset++) {
      if (token !== this.runToken || this.state === 'STOPPED') return false

      const index =
        (startCursor + offset) % this.storagePositions.length
      const pos = this.storagePositions[index].pos

      this.traveling = true
      this.touchProgress()

      try {
        await this.withTimeout(
          this.bot.pathfinder.goto(
            new GoalNear(pos.x, pos.y, pos.z, 4)
          ),
          this.mode === 'wall'
            ? Math.max(this.pathTimeoutMs, 90000)
            : this.pathTimeoutMs,
          'clean staging path'
        )

        this.storageCursor = index
        this.touchProgress()
        return true
      } catch (err) {
        console.log(
          '[CLEAN STAGING FAILED] ' +
          pos.toString() + ' -> ' + err.message
        )
      } finally {
        this.traveling = false
        this.touchProgress()
      }
    }

    return false
  }

  async cleanInventoryBeforeRefill(token) {
    let foreign = this.foreignInventoryItems()
    if (!foreign.length) return true

    this.reply(
      'CLEAN inventory | dropping ' +
      foreign.reduce((sum, item) => sum + item.count, 0) +
      ' non-' + this.blockName + ' item(s)'
    )

    const moved = await this.moveToRandomDropSpot(token)

    if (token !== this.runToken || this.state === 'STOPPED') return false

    if (!moved) {
      this.alertOwner(
        'Cannot find safe random spot to drop unwanted inventory',
        true
      )
      return false
    }

    foreign = this.foreignInventoryItems()

    for (const item of foreign) {
      if (token !== this.runToken || this.state === 'STOPPED') return false

      try {
        console.log(
          '[CLEAN DROP] ' + item.name + ' x' + item.count
        )

        await this.withTimeout(
          this.bot.tossStack(item),
          5000,
          'drop ' + item.name
        )

        await sleep(100)
        this.touchProgress()
      } catch (err) {
        console.log(
          '[CLEAN DROP FAILED] ' +
          item.name + ' x' + item.count +
          ' -> ' + err.message
        )
      }
    }

    const remaining = this.foreignInventoryItems()

    if (remaining.length) {
      this.alertOwner(
        'Could not drop all unwanted inventory: ' +
        remaining.map(item => item.name + 'x' + item.count).join(','),
        true
      )
      return false
    }

    this.reply(
      'CLEAN complete | inventory ready for ' + this.blockName
    )

    return true
  }

  async refillFromStorages(token, lockRetry = 0) {
    if (!this.storagePositions.length) {
      this.alertOwner(
        'Inventory empty and no chest/shulker was remembered',
        true
      )
      return false
    }

    const itemDef = this.bot.registry.itemsByName[this.blockName]
    if (!itemDef) {
      this.alertOwner('Cannot resolve refill item: ' + this.blockName, true)
      return false
    }

    this.state = 'REFILLING'
    this.stopMovement()
    this.touchProgress()

    if (
      this.mode === 'wall' &&
      this.foreignInventoryItems().length > 0
    ) {
      const stagedForClean = await this.moveNearStorageForClean(token)

      if (!stagedForClean) {
        this.alertOwner(
          'Cannot return near storage before inventory clean',
          true
        )
        return false
      }
    }

    const cleaned = await this.cleanInventoryBeforeRefill(token)

    if (
      !cleaned ||
      token !== this.runToken ||
      this.state === 'STOPPED' ||
      this.state === 'PAUSED'
    ) {
      return false
    }

    const startCursor = this.storageCursor
    let busyStorages = 0

    const origin = this.bot.entity
      ? this.bot.entity.position
      : null

    const orderedStorages = this.storagePositions
      .map((storage, index) => {
        const pos = storage.pos
        const dx = origin ? (pos.x - origin.x) : 0
        const dz = origin ? (pos.z - origin.z) : 0
        const dy = origin ? Math.abs(pos.y - origin.y) : 0
        const horizontal = Math.sqrt((dx * dx) + (dz * dz))

        return {
          storage,
          index,
          dy,
          score: (dy * 12) + horizontal
        }
      })
      .filter(entry =>
        this.mode !== 'wall' ||
        !origin ||
        entry.dy <= 8
      )
      .sort((a, b) => a.score - b.score)

    if (this.mode === 'wall' && orderedStorages.length <= 0) {
      const have = this.inventoryBlockCount()
      this.alertOwner(
        'MATERIAL SHORTAGE | ' + this.blockName +
        ' have=' + have +
        ' | no reachable storage near current Y=' +
        (origin ? Math.floor(origin.y) : '?'),
        true
      )
      return false
    }

    for (const entry of orderedStorages) {
      if (token !== this.runToken || this.state === 'STOPPED') return false

      const index = entry.index
      const storage = entry.storage
      const pos = storage.pos
      const lockKey = pos.x + ',' + pos.y + ',' + pos.z
      let lockAcquired = false

      try {
        lockAcquired = await this.acquireStorageLockFn(lockKey)

        if (!lockAcquired) {
          busyStorages += 1
          console.log('[REFILL LOCKED] ' + lockKey + ' -> trying next storage')
          continue
        }

        this.reply(
          'REFILL ' + (index + 1) + '/' + this.storagePositions.length +
          ' -> ' + pos.x + ' ' + pos.y + ' ' + pos.z
        )

        this.traveling = true
        this.touchProgress()

        try {
          await this.withTimeout(
            this.bot.pathfinder.goto(
              new GoalNear(pos.x, pos.y, pos.z, 2)
            ),
            this.mode === 'wall'
              ? Math.max(this.pathTimeoutMs, 90000)
              : this.pathTimeoutMs,
            'refill path'
          )
        } finally {
          this.traveling = false
          this.touchProgress()
        }

        if (token !== this.runToken || this.state === 'STOPPED') return false

        const block = this.bot.blockAt(pos)
        if (!this.isStorageBlock(block)) {
          storage.lastKnownCount = 0
          continue
        }

        const container = await this.withTimeout(
          this.bot.openContainer(block),
          10000,
          'open storage'
        )
        await sleep(100)

        const available = this.containerBlockCount(container)
        storage.lastKnownCount = available

        if (available <= 0) {
          container.close()
          this.touchProgress()
          continue
        }

        const capacity = this.inventoryItemCapacity(
          this.blockName
        )

        if (capacity <= 0) {
          container.close()
          this.state = 'RUNNING'
          return this.inventoryBlockCount() > 0
        }

        const take = Math.min(available, capacity)

        await this.withTimeout(
          container.withdraw(
            itemDef.id,
            null,
            take
          ),
          15000,
          'withdraw storage'
        )

        storage.lastKnownCount = Math.max(0, available - take)
        container.close()

        this.refillCount += 1
        this.touchProgress()

        if (storage.lastKnownCount <= 0) {
          this.storageCursor =
            (index + 1) % this.storagePositions.length
        } else {
          this.storageCursor = index
        }

        const now = this.inventoryBlockCount()
        this.reply(
          'REFILLED +' + take + ' ' + this.blockName +
          ' | inventory=' + now +
          ' | refill#' + this.refillCount
        )

        this.state = 'RUNNING'
        return now > 0
      } catch (err) {
        this.stopMovement()
        this.touchProgress()
        console.log(
          '[REFILL FAILED] ' + pos.toString() + ' -> ' + err.message
        )
      } finally {
        if (lockAcquired) {
          try {
            await Promise.resolve(
              this.releaseStorageLockFn(lockKey)
            )
          } catch {}
        }
      }
    }

    this.storageCursor = startCursor

    if (busyStorages > 0 && lockRetry < 3) {
      this.reply(
        'REFILL WAIT | busy=' + busyStorages +
        ' retry=' + (lockRetry + 1) + '/3'
      )

      await sleep(1200 * (lockRetry + 1))

      if (token !== this.runToken || this.state === 'STOPPED') {
        return false
      }

      return this.refillFromStorages(
        token,
        lockRetry + 1
      )
    }

    const haveNow = this.inventoryBlockCount()
    this.alertOwner(
      'MATERIAL SHORTAGE | ' + this.blockName +
      ' have=' + haveNow +
      ' | usableStorage=' + orderedStorages.length +
      '/' + this.storagePositions.length +
      (busyStorages > 0
        ? ' | busy=' + busyStorages
        : ' | no usable supply found'),
      true
    )
    return false
  }

  async preloadSpecificItemFromStorages(
    token,
    itemName,
    requestedCount
  ) {
    const target = Math.max(
      0,
      Math.ceil(Number(requestedCount) || 0)
    )

    if (target <= 0) return true

    const itemDef = this.bot.registry.itemsByName[itemName]
    if (!itemDef) {
      this.alertOwner(
        'Cannot preload unknown item: ' + itemName,
        true
      )
      return false
    }

    let round = 0
    let busyRounds = 0

    while (
      this.inventoryItemCount(itemName) < target &&
      round < 4
    ) {
      if (
        token !== this.runToken ||
        this.state === 'STOPPED'
      ) {
        return false
      }

      let progress = false
      let busy = 0

      const origin = this.bot.entity
        ? this.bot.entity.position
        : null

      // For mandatory material preload, try the closest / same-height
      // storages first. This avoids wasting time on remembered chests
      // far below the build that currently have no reachable path.
      const orderedStorages = this.storagePositions
        .map((storage, index) => {
          const pos = storage.pos
          const dx = origin ? (pos.x - origin.x) : 0
          const dz = origin ? (pos.z - origin.z) : 0
          const dy = origin ? Math.abs(pos.y - origin.y) : 0
          const horizontal = Math.sqrt((dx * dx) + (dz * dz))

          return {
            storage,
            index,
            dy,
            score: (dy * 12) + horizontal
          }
        })
        .filter(entry =>
          this.mode !== 'wall' ||
          !origin ||
          entry.dy <= 8
        )
        .sort((a, b) => a.score - b.score)

      for (const entry of orderedStorages) {
        if (
          token !== this.runToken ||
          this.state === 'STOPPED'
        ) {
          return false
        }

        if (this.inventoryItemCount(itemName) >= target) {
          break
        }

        const index = entry.index
        const storage = entry.storage
        const pos = storage.pos
        const lockKey = pos.x + ',' + pos.y + ',' + pos.z
        let lockAcquired = false
        let container = null

        try {
          lockAcquired = await this.acquireStorageLockFn(lockKey)

          if (!lockAcquired) {
            busy += 1
            continue
          }

          this.state = 'PREPARING'
          this.traveling = true
          this.touchProgress()

          try {
            await this.withTimeout(
              this.bot.pathfinder.goto(
                new GoalNear(pos.x, pos.y, pos.z, 2)
              ),
              this.mode === 'wall'
                ? Math.min(
                    Math.max(this.pathTimeoutMs, 12000),
                    20000
                  )
                : this.pathTimeoutMs,
              'preload ' + itemName + ' path'
            )
          } finally {
            this.traveling = false
            this.touchProgress()
          }

          const block = this.bot.blockAt(pos)
          if (!this.isStorageBlock(block)) continue

          container = await this.withTimeout(
            this.bot.openContainer(block),
            10000,
            'open preload storage'
          )
          await sleep(100)

          const available = this.containerItemCount(
            container,
            itemName
          )

          const current = this.inventoryItemCount(itemName)
          const need = Math.max(0, target - current)

          console.log(
            '[PRELOAD STORAGE] ' + itemName +
            ' @ ' + pos.x + ',' + pos.y + ',' + pos.z +
            ' available=' + available +
            ' have=' + current +
            ' missing=' + need +
            ' emptySlots=' + this.bot.inventory.emptySlotCount()
          )

          if (available <= 0) continue

          const capacity = this.inventoryItemCapacity(itemName)
          const take = Math.min(
            available,
            need,
            capacity
          )

          if (take <= 0) continue

          await this.withTimeout(
            container.withdraw(
              itemDef.id,
              null,
              take
            ),
            15000,
            'preload withdraw ' + itemName
          )

          progress = true
          this.storageCursor = index
          this.touchProgress()

          this.reply(
            'PRELOAD ' + itemName +
            ' ' + this.inventoryItemCount(itemName) +
            '/' + target
          )
        } catch (err) {
          console.log(
            '[PRELOAD FAILED] ' +
            itemName + ' @ ' + pos.toString() +
            ' -> ' + err.message
          )
        } finally {
          if (container) {
            try {
              container.close()
            } catch {}
          }

          if (lockAcquired) {
            try {
              await Promise.resolve(
                this.releaseStorageLockFn(lockKey)
              )
            } catch {}
          }
        }
      }

      if (this.inventoryItemCount(itemName) >= target) {
        break
      }

      if (!progress && busy > 0 && busyRounds < 3) {
        busyRounds += 1
        await sleep(1000 * busyRounds)
      } else if (!progress) {
        break
      }

      round += 1
    }

    this.state = 'PREPARING'
    this.touchProgress()

    return this.inventoryItemCount(itemName) >= target
  }

  async returnItemToStorages(token, itemName, requestedCount) {
    let remaining = Math.max(
      0,
      Math.ceil(Number(requestedCount) || 0)
    )

    if (remaining <= 0) return 0

    const itemDef = this.bot.registry.itemsByName[itemName]
    if (!itemDef) return 0

    let deposited = 0

    const origin = this.bot.entity
      ? this.bot.entity.position
      : null

    const orderedStorages = this.storagePositions
      .map((storage, index) => {
        const pos = storage.pos
        const dx = origin ? (pos.x - origin.x) : 0
        const dz = origin ? (pos.z - origin.z) : 0
        const dy = origin ? Math.abs(pos.y - origin.y) : 0
        const horizontal = Math.sqrt((dx * dx) + (dz * dz))

        return {
          storage,
          index,
          dy,
          score: (dy * 12) + horizontal
        }
      })
      .filter(entry =>
        this.mode !== 'wall' ||
        !origin ||
        entry.dy <= 8
      )
      .sort((a, b) => a.score - b.score)

    for (const entry of orderedStorages) {
      if (remaining <= 0) break

      if (
        token !== this.runToken ||
        this.state === 'STOPPED'
      ) {
        break
      }

      const index = entry.index
      const storage = entry.storage
      const pos = storage.pos
      const lockKey = pos.x + ',' + pos.y + ',' + pos.z
      let lockAcquired = false
      let container = null

      try {
        lockAcquired = await this.acquireStorageLockFn(lockKey)
        if (!lockAcquired) continue

        this.traveling = true
        this.touchProgress()

        try {
          await this.withTimeout(
            this.bot.pathfinder.goto(
              new GoalNear(pos.x, pos.y, pos.z, 2)
            ),
            this.mode === 'wall'
              ? Math.max(this.pathTimeoutMs, 90000)
              : this.pathTimeoutMs,
            'material rebalance path'
          )
        } finally {
          this.traveling = false
          this.touchProgress()
        }

        const block = this.bot.blockAt(pos)
        if (!this.isStorageBlock(block)) continue

        container = await this.withTimeout(
          this.bot.openContainer(block),
          10000,
          'open rebalance storage'
        )
        await sleep(100)

        const stackSize = itemDef.stackSize || 64

        while (remaining > 0) {
          const availableInInventory =
            this.inventoryItemCount(itemName)

          const take = Math.min(
            remaining,
            availableInInventory,
            stackSize
          )

          if (take <= 0) break

          try {
            await this.withTimeout(
              container.deposit(
                itemDef.id,
                null,
                take
              ),
              15000,
              'deposit ' + itemName
            )
          } catch (err) {
            console.log(
              '[REBALANCE STORAGE FULL] ' +
              pos.toString() + ' -> ' + err.message
            )
            break
          }

          deposited += take
          remaining -= take
          this.storageCursor = index
          this.touchProgress()
        }

        if (deposited > 0) {
          this.reply(
            'REBALANCE stored ' + deposited +
            ' ' + itemName +
            ' back to storage'
          )
        }
      } catch (err) {
        console.log(
          '[REBALANCE FAILED] ' +
          itemName + ' @ ' + pos.toString() +
          ' -> ' + err.message
        )
      } finally {
        if (container) {
          try {
            container.close()
          } catch {}
        }

        if (lockAcquired) {
          try {
            await Promise.resolve(
              this.releaseStorageLockFn(lockKey)
            )
          } catch {}
        }
      }
    }

    this.state = 'PREPARING'
    this.touchProgress()
    return deposited
  }

  async preloadTaskMaterials(
    token,
    mainRequested,
    scaffoldRequested
  ) {
    const mainNeed = Math.max(
      0,
      Math.ceil(Number(mainRequested) || 0)
    )
    const scaffoldNeed = Math.max(
      0,
      Math.ceil(Number(scaffoldRequested) || 0)
    )

    if (mainNeed <= 0 && scaffoldNeed <= 0) return true

    if (this.foreignInventoryItems().length > 0) {
      if (this.mode === 'wall') {
        const staged = await this.moveNearStorageForClean(token)
        if (!staged) {
          this.alertOwner(
            'Cannot reach storage area before material clean',
            true
          )
          return false
        }
      }

      const cleaned = await this.cleanInventoryBeforeRefill(token)
      if (!cleaned) return false
      this.state = 'PREPARING'
    }

    this.reply(
      'PRELOAD MATERIALS | main=' + mainNeed + ' ' +
      this.blockName +
      ' | temp=' + scaffoldNeed + ' ' +
      this.wallScaffoldBlockName
    )

    // Reserve real inventory slots before loading temporary
    // wall material. If slots are short, reserveInventorySlotsForItem()
    // stashes every non-target item into reachable EMPTY storage first.
    const scaffoldTarget = scaffoldNeed

    if (scaffoldTarget > 0) {
      const slotsReady = await this.reserveInventorySlotsForItem(
        token,
        this.wallScaffoldBlockName,
        scaffoldTarget
      )

      if (!slotsReady) {
        const haveScaffold = this.scaffoldBlockCount()
        this.alertOwner(
          'MATERIAL SLOT SHORTAGE | ' +
          this.wallScaffoldBlockName +
          ' need=' + scaffoldTarget +
          ' have=' + haveScaffold +
          ' | cannot reserve enough inventory slots',
          true
        )
        return false
      }

      const scaffoldReady = await this.preloadSpecificItemFromStorages(
        token,
        this.wallScaffoldBlockName,
        scaffoldTarget
      )

      if (!scaffoldReady) {
        const haveScaffold = this.scaffoldBlockCount()
        this.alertOwner(
          'MATERIAL SHORTAGE | ' + this.wallScaffoldBlockName +
          ' need=' + scaffoldTarget +
          ' have=' + haveScaffold +
          ' missing=' + Math.max(0, scaffoldTarget - haveScaffold) +
          ' | temporary wall access',
          true
        )
        return false
      }
    }

    const mainPossible =
      this.inventoryBlockCount() +
      this.inventoryItemCapacity(this.blockName)

    const mainTarget = Math.min(
      mainNeed,
      mainPossible
    )

    if (mainTarget > 0) {
      const mainReady = await this.preloadInventoryForTask(
        token,
        mainTarget
      )

      if (!mainReady) return false
    }

    const mainCarried = this.inventoryBlockCount()
    const scaffoldCarried = this.scaffoldBlockCount()

    this.reply(
      'PRELOAD READY | main=' +
      mainCarried + '/' + mainNeed +
      ' ' + this.blockName +
      ' | temp=' +
      scaffoldCarried + '/' + scaffoldNeed +
      ' ' + this.wallScaffoldBlockName
    )

    if (mainCarried < mainNeed) {
      this.reply(
        'PRELOAD CAPACITY | main task exceeds carry capacity; ' +
        'mid-task main refill remains enabled'
      )
    }

    if (scaffoldCarried < scaffoldNeed) {
      this.alertOwner(
        'MATERIAL SHORTAGE | ' + this.wallScaffoldBlockName +
        ' need=' + scaffoldNeed +
        ' have=' + scaffoldCarried +
        ' missing=' + Math.max(0, scaffoldNeed - scaffoldCarried),
        true
      )
      return false
    }

    this.state = 'PREPARING'
    this.touchProgress()
    return true
  }

  async preloadInventoryForTask(token, requestedCount) {
    const requested = Math.max(
      0,
      Math.ceil(Number(requestedCount) || 0)
    )

    if (requested <= 0) return true

    const itemDef = this.bot.registry.itemsByName[this.blockName]

    if (!itemDef) {
      this.alertOwner(
        'Cannot preload unknown item: ' + this.blockName,
        true
      )
      return false
    }

    const stackSize = itemDef.stackSize || 64
    const theoreticalMax = 36 * stackSize
    const carryTarget = Math.min(requested, theoreticalMax)

    this.reply(
      'PRELOAD PLAN | need=' + requested +
      ' carryTarget=' + carryTarget +
      ' reserveIncluded=yes'
    )

    let attempts = 0
    const maxAttempts = Math.max(
      4,
      this.storagePositions.length + 4
    )

    while (
      this.inventoryBlockCount() < carryTarget &&
      attempts < maxAttempts
    ) {
      if (
        token !== this.runToken ||
        this.state === 'STOPPED'
      ) {
        return false
      }

      const before = this.inventoryBlockCount()
      const ok = await this.refillFromStorages(token)

      if (!ok) {
        return false
      }

      this.state = 'PREPARING'
      this.touchProgress()

      const after = this.inventoryBlockCount()

      this.reply(
        'PRELOAD ' + after + '/' + carryTarget +
        ' ' + this.blockName
      )

      if (after <= before) break

      attempts += 1

      if (
        this.bot.inventory.emptySlotCount() <= 0 &&
        after < carryTarget
      ) {
        break
      }
    }

    const carried = this.inventoryBlockCount()

    if (carried < carryTarget) {
      this.alertOwner(
        'MATERIAL SHORTAGE | ' + this.blockName +
        ' need=' + carryTarget +
        ' have=' + carried +
        ' missing=' + Math.max(0, carryTarget - carried),
        true
      )
      return false
    }

    if (requested > theoreticalMax) {
      this.reply(
        'PRELOAD FULL | task=' + requested +
        ' exceeds inventory max=' + theoreticalMax +
        ' | mid-task refill fallback enabled'
      )
    } else {
      this.reply(
        'PRELOAD READY | carrying=' + carried +
        ' / planned=' + requested
      )
    }

    this.state = 'PREPARING'
    this.touchProgress()
    return true
  }

  async handleCommand(message) {
    const raw = String(message || '').trim()
    if (!raw) return

    const args = raw.split(/\s+/)
    const command = args[0].toLowerCase()

    if (command === 'help' || command === 'ช่วย') {
      this.reply('mode stream|wall | band N | side auto|+|- | from X Y Z | to X Y Z | block NAME | มา = /tpa owner | เริ่ม | พัก | ต่อ | หยุด | status')
      return
    }

    if (command === 'mode') {
      const requested = String(args[1] || '').toLowerCase()

      if (!requested) {
        this.reply('Mode = ' + this.mode)
        return
      }

      if (!['stream', 'wall'].includes(requested)) {
        this.reply('Usage: mode stream|wall')
        return
      }

      this.mode = requested
      this.wallPlane = null
      this.wallNormalSign = null
      this.reply('Mode = ' + this.mode.toUpperCase())
      return
    }

    if (command === 'band') {
      const value = Number(args[1])

      if (!Number.isFinite(value) || value < 1 || value > 4) {
        this.reply('Usage: band 1-4')
        return
      }

      this.wallBandHeight = Math.trunc(value)
      this.reply('Wall band height = ' + this.wallBandHeight)
      return
    }

    if (command === 'side') {
      const value = String(args[1] || '').toLowerCase()

      if (!['auto', '+', '-'].includes(value)) {
        this.reply('Usage: side auto|+|-')
        return
      }

      this.wallSide = value
      this.wallNormalSign = null
      this.reply('Wall side = ' + this.wallSide)
      return
    }

    if (command === 'from' || command === 'pos1') {
      const pos = this.parseXYZ(args)
      if (!pos) {
        this.reply('Usage: from X Y Z')
        return
      }

      this.from = pos
      this.reply('FROM = ' + pos.x + ' ' + pos.y + ' ' + pos.z)
      return
    }

    if (command === 'to' || command === 'pos2') {
      const pos = this.parseXYZ(args)
      if (!pos) {
        this.reply('Usage: to X Y Z')
        return
      }

      this.to = pos
      this.reply('TO = ' + pos.x + ' ' + pos.y + ' ' + pos.z)
      return
    }

    if (command === 'block') {
      if (!args[1]) {
        this.reply('Block = ' + this.blockName)
        return
      }

      const requested = args.slice(1).join(' ')
      const name = this.resolveBlockName(requested)

      if (!name) {
        this.reply('Unknown item/block: ' + requested)
        return
      }

      this.blockName = name
      this.reply('Block = ' + this.blockName)
      return
    }

    if (command === 'status' || command === 'สถานะ') {
      this.reply(this.statusText())
      return
    }

    if (command === 'มา' || command === 'come' || command === 'tp' || command === 'tpa') {
      await this.comeToOwner(args)
      return
    }

    if (command === 'เริ่ม' || command === 'start') {
      await this.start()
      return
    }

    if (command === 'พัก' || command === 'pause') {
      this.pause()
      return
    }

    if (command === 'ต่อ' || command === 'resume') {
      this.resume()
      return
    }

    if (command === 'หยุด' || command === 'stop') {
      this.forceStop(true)
      return
    }

    const directBlock = this.resolveBlockName(raw)
    if (directBlock) {
      this.blockName = directBlock
      this.reply('Block = ' + this.blockName)
      return
    }

    this.reply('Unknown command. Use: help')
  }

  async comeToOwner() {
    if (!this.ready) {
      this.reply('Bot is not ready yet.')
      return
    }

    if (this.state === 'RUNNING') {
      this.state = 'PAUSED'
      this.stopMovement()
    }

    this.bot.chat('/tpa ' + this.owner)
    this.reply('TPA sent to ' + this.owner)
  }

  async start(options = {}) {
    if (!this.ready) {
      this.reply('Bot is not ready on the game server yet.')
      return
    }

    const d = this.dimensions()
    if (!d) {
      this.reply('Set FROM and TO first.')
      return
    }

    if (!this.validateBlockName(this.blockName)) {
      this.reply('Invalid block: ' + this.blockName)
      return
    }

    if (
      this.state === 'RUNNING' ||
      this.state === 'PREPARING' ||
      this.state === 'REFILLING'
    ) {
      this.reply('Builder is busy: ' + this.state)
      return
    }

    this.runToken += 1
    const token = this.runToken

    this.state = 'PREPARING'
    this.stopMovement()
    this.touchProgress()
    this.badBurstStreak = 0
    this.lastAlertKey = ''

    const useExistingStorages =
      options && options.useExistingStorages === true

    if (useExistingStorages && this.storagePositions.length > 0) {
      this.reply(
        'PREP ' + this.blockName +
        ' | using shared storage snapshot=' +
        this.storagePositions.length
      )
      this.touchProgress()
    } else {
      this.reply(
        'PREP ' + this.blockName +
        ' | scanning all chest/shulker first'
      )

      await this.scanStorages(token)

      if (token !== this.runToken || this.state === 'STOPPED') return
    }

    const preloadMainTarget = Math.max(
      0,
      Math.ceil(Number(options.preloadMainTarget) || 0)
    )
    const preloadScaffoldTarget = Math.max(
      0,
      Math.ceil(Number(options.preloadScaffoldTarget) || 0)
    )

    if (
      preloadMainTarget > 0 ||
      preloadScaffoldTarget > 0
    ) {
      const preloaded = await this.preloadTaskMaterials(
        token,
        preloadMainTarget,
        preloadScaffoldTarget
      )

      if (
        !preloaded ||
        token !== this.runToken ||
        this.state === 'STOPPED' ||
        this.state === 'PAUSED'
      ) {
        return
      }
    }

    if (this.mode === 'stream' && this.bot.entity) {
      const midpointX = (d.minX + d.maxX) / 2
      this.streamReverseX =
        this.bot.entity.position.x > midpointX

      console.log(
        '[STREAM START EDGE] ' +
        (this.streamReverseX ? 'MAX_X' : 'MIN_X') +
        ' botX=' +
        this.bot.entity.position.x.toFixed(2) +
        ' slice=' + d.minX + '..' + d.maxX
      )
    } else {
      this.streamReverseX = false
    }

    this.index = 0
    this.total = d.total
    this.placed = 0
    this.skipped = 0
    this.failed = 0
    this.noSupport = 0
    this.refillCount = 0
    this.repairQueue.clear()
    this.repairPass = 0
    this.repaired = 0
    this.repairCurrentIndex = null
    this.wallCheckpoint = null
    this.wallCurrentTarget = null
    this.wallBand = 0
    this.wallVerified = 0
    this.traveling = false
    this.state = 'RUNNING'
    this.touchProgress()

    this.reply(
      'START ' + this.blockName +
      ' | total=' + this.total +
      ' | mode=' + this.mode.toUpperCase() +
      ' | stores=' + this.storagePositions.length +
      ' | ' + d.minX + ' ' + d.minY + ' ' + d.minZ +
      ' -> ' + d.maxX + ' ' + d.maxY + ' ' + d.maxZ
    )

    const runner = this.mode === 'wall'
      ? this.runWall(token)
      : this.run(token)

    runner.catch(err => {
      if (token !== this.runToken) return
      this.state = 'ERROR'
      console.log('[BUILDER ERROR] ' + (err.stack || err.message))
      this.alertOwner('Builder error: ' + err.message, false)
    })
  }

  pause() {
    if (this.state !== 'RUNNING') {
      this.reply('Builder is not running.')
      return
    }

    this.state = 'PAUSED'
    this.stopMovement()
    this.reply('PAUSED | ' + this.index + '/' + this.total)
  }

  resume() {
    if (this.state !== 'PAUSED') {
      this.reply('Builder is not paused.')
      return
    }

    this.state = 'RUNNING'
    this.touchProgress()
    this.badBurstStreak = 0
    this.reply('RESUMED | ' + this.index + '/' + this.total)
  }

  forceStop(announce = true) {
    this.runToken += 1
    this.traveling = false
    this.state = 'STOPPED'
    this.stopMovement()

    if (announce) {
      this.reply('STOPPED | ' + this.index + '/' + this.total)
    }
  }

  stopMovement() {
    try {
      if (this.bot.pathfinder) {
        this.bot.pathfinder.setGoal(null)
      }
    } catch {}

    try {
      this.bot.clearControlStates()
    } catch {}
  }

  async placeNoMove(target, support) {
    try {
      if (typeof this.bot._placeBlockWithOptions === 'function') {
        await this.bot._placeBlockWithOptions(
          support.block,
          support.face,
          { forceLook: 'ignore', swingArm: false, showHand: false }
        )
      } else {
        await this.bot.placeBlock(support.block, support.face)
      }

      const after = this.bot.blockAt(target)
      if (after && !this.isAir(after)) {
        return 'PLACED'
      }

      return 'FAILED'
    } catch (err) {
      console.log(
        '[STREAM PLACE FAILED] ' +
        target.x + ' ' + target.y + ' ' + target.z +
        ' -> ' + err.message
      )
      return 'FAILED'
    }
  }

  async waitForStreamStartSupport(
    token,
    target,
    timeoutMs = 30000
  ) {
    const deadline = Date.now() + timeoutMs
    let lastLog = 0

    while (Date.now() < deadline) {
      if (token !== this.runToken || this.state === 'STOPPED') {
        return false
      }

      const support = this.findSupport(target)
      const stands = this.safeStandCandidates(target)

      if (support && stands.length > 0) {
        console.log(
          '[STREAM START READY] target=' +
          target.x + ' ' + target.y + ' ' + target.z +
          ' stands=' + stands.length
        )
        return true
      }

      if (Date.now() - lastLog >= 3000) {
        lastLog = Date.now()
        console.log(
          '[STREAM START WAIT] target=' +
          target.x + ' ' + target.y + ' ' + target.z +
          ' waiting for neighbour/support'
        )
      }

      this.touchProgress()
      await sleep(350)
    }

    return false
  }

  async placeStreamChunk(token) {
    const d = this.dimensions()
    if (!d) return { processed: 0, placed: 0, skipped: 0, status: 'INVALID' }

    let processed = 0
    let placed = 0
    let skipped = 0

    const rowRemaining = d.dx - (this.index % d.dx)
    const firstTarget = this.targetAt(this.index)
    if (!firstTarget) {
      return { processed: 0, placed: 0, skipped: 0, status: 'DONE' }
    }

    const firstCurrent = this.bot.blockAt(firstTarget)
    if (!firstCurrent || this.isAir(firstCurrent)) {
      if (this.inventoryBlockCount() <= 0) {
        return { processed: 0, placed: 0, skipped: 0, status: 'OUT_OF_BLOCKS' }
      }

      try {
        await this.moveIntoPlaceRange(firstTarget, token)
      } catch (err) {
        console.log(
          '[STREAM PATH FAILED] ' +
          firstTarget.x + ' ' + firstTarget.y + ' ' + firstTarget.z +
          ' -> ' + err.message
        )
        return { processed: 0, placed: 0, skipped: 0, status: 'PATH_FAILED' }
      }
    }

    for (let offset = 0; offset < rowRemaining; offset++) {
      if (token !== this.runToken || this.state === 'STOPPED') {
        return { processed, placed, skipped, status: 'STOPPED' }
      }

      const target = this.targetAt(this.index + processed)
      if (!target) break

      const current = this.bot.blockAt(target)
      if (current && !this.isAir(current)) {
        skipped += 1
        processed += 1
        continue
      }

      let distance = this.bot.entity.position.distanceTo(
        target.offset(0.5, 0.5, 0.5)
      )

      if (
        distance > 4.45 ||
        this.botIntersectsBlock(target) ||
        this.bot.entity.position.y < target.y + 0.85
      ) {
        const moved = await this.moveToSafeStand(target, token)

        if (!moved) {
          return { processed, placed, skipped, status: 'PATH_FAILED' }
        }

        distance = this.bot.entity.position.distanceTo(
          target.offset(0.5, 0.5, 0.5)
        )

        if (distance > 4.45 || this.botIntersectsBlock(target)) {
          return { processed, placed, skipped, status: 'PATH_FAILED' }
        }
      }

      if (this.inventoryBlockCount() <= 0) {
        return { processed, placed, skipped, status: 'OUT_OF_BLOCKS' }
      }

      let support = this.findSupport(target)

      if (!support) {
        return { processed, placed, skipped, status: 'NO_SUPPORT' }
      }

      const item = this.itemInInventory()
      if (!item) {
        return { processed, placed, skipped, status: 'OUT_OF_BLOCKS' }
      }

      if (!this.bot.heldItem || this.bot.heldItem.name !== this.blockName) {
        await this.bot.equip(item, 'hand')
      }

      let result = 'FAILED'

      for (let attempt = 1; attempt <= 3; attempt++) {
        support = this.findSupport(target)
        if (!support) {
          result = 'NO_SUPPORT'
          break
        }

        result = await this.placeNoMove(target, support)
        if (result === 'PLACED') break

        if (attempt < 3) {
          const moved = await this.moveToSafeStand(target, token)
          if (!moved) {
            await sleep(200 * attempt)
          } else {
            await sleep(100)
          }
        }
      }

      if (result !== 'PLACED') {
        return { processed, placed, skipped, status: result }
      }

      placed += 1
      processed += 1
      this.touchProgress()
    }

    return { processed, placed, skipped, status: 'OK' }
  }

  async placeBurst(token) {
    const first = this.targetAt(this.index)
    if (!first) return []

    const firstBlock = this.bot.blockAt(first)

    if (firstBlock && !this.isAir(firstBlock)) {
      return ['SKIP']
    }

    const firstSupport = this.findSupport(first)
    if (!firstSupport) {
      return ['NO_SUPPORT']
    }

    if (this.inventoryBlockCount() <= 0) {
      return ['OUT_OF_BLOCKS']
    }

    try {
      await this.moveIntoPlaceRange(first, token)
    } catch (err) {
      if (token !== this.runToken) return []
      console.log(
        '[BURST PATH FAILED] ' +
        first.x + ' ' + first.y + ' ' + first.z +
        ' -> ' + err.message
      )
      return ['FAILED']
    }

    if (token !== this.runToken || this.state === 'STOPPED') return []

    const available = this.inventoryBlockCount()
    const batch = []
    let placementCount = 0

    const d = this.dimensions()
    const rowRemaining = d
      ? d.dx - (this.index % d.dx)
      : this.burstSize
    const maxBatch = Math.min(this.burstSize, rowRemaining)

    for (
      let offset = 0;
      offset < maxBatch && this.index + offset < this.total;
      offset++
    ) {
      const target = this.targetAt(this.index + offset)
      const current = this.bot.blockAt(target)

      if (current && !this.isAir(current)) {
        batch.push({ target, preset: 'SKIP' })
        continue
      }

      const distance = this.bot.entity.position.distanceTo(
        target.offset(0.5, 0.5, 0.5)
      )

      if (distance > 4.45) {
        break
      }

      const support = this.findSupport(target)
      if (!support) {
        batch.push({ target, preset: 'NO_SUPPORT' })
        continue
      }

      if (placementCount >= available) break

      placementCount += 1
      batch.push({ target, support, preset: null })
    }

    if (!batch.length) {
      return ['FAILED']
    }

    if (placementCount > 0) {
      const item = this.itemInInventory()
      if (!item) return ['OUT_OF_BLOCKS']

      if (!this.bot.heldItem || this.bot.heldItem.name !== this.blockName) {
        await this.bot.equip(item, 'hand')
      }
    }

    const jobs = batch.map(entry => {
      if (entry.preset) return Promise.resolve(entry.preset)
      return this.placeNoMove(entry.target, entry.support)
    })

    const results = await Promise.all(jobs)

    if (this.placeDelayTicks > 0) {
      await this.bot.waitForTicks(this.placeDelayTicks)
    }

    return results
  }

  detectWallPlane() {
    const d = this.dimensions()
    if (!d || d.dy < 2) return null

    let widthAxis
    let fixedAxis
    let fixed
    let widthMin
    let widthMax

    if (d.dz === 1 && d.dx >= 1) {
      widthAxis = 'x'
      fixedAxis = 'z'
      fixed = d.minZ
      widthMin = d.minX
      widthMax = d.maxX
    } else if (d.dx === 1 && d.dz >= 1) {
      widthAxis = 'z'
      fixedAxis = 'x'
      fixed = d.minX
      widthMin = d.minZ
      widthMax = d.maxZ
    } else {
      return null
    }

    return {
      widthAxis,
      fixedAxis,
      fixed,
      widthMin,
      widthMax,
      widthLength: widthMax - widthMin + 1,
      minY: d.minY,
      maxY: d.maxY,
      height: d.dy,
      total: (widthMax - widthMin + 1) * d.dy
    }
  }

  wallPos(plane, width, y, normalOffset = 0) {
    if (plane.widthAxis === 'x') {
      return new Vec3(
        width,
        y,
        plane.fixed + (normalOffset * this.wallNormalSign)
      )
    }

    return new Vec3(
      plane.fixed + (normalOffset * this.wallNormalSign),
      y,
      width
    )
  }

  wallWidthOf(plane, pos) {
    return plane.widthAxis === 'x' ? pos.x : pos.z
  }

  chooseWallNormalSign(plane) {
    if (this.wallSide === '+') return 1
    if (this.wallSide === '-') return -1

    const centerWidth = Math.floor(
      (plane.widthMin + plane.widthMax) / 2
    )

    const samples = [
      plane.widthMin,
      centerWidth,
      plane.widthMax
    ]

    const scoreSide = sign => {
      const previous = this.wallNormalSign
      this.wallNormalSign = sign
      let score = 0

      for (const width of samples) {
        // Judge the side by the REAL service-lane floor at baseY-1,
        // not by how much empty air exists beside the wall.
        const floor = this.wallLaneFloorPos(
          plane,
          width,
          plane.minY
        )
        const stand = floor.offset(0, 1, 0)
        const floorBlock = this.bot.blockAt(floor)
        const feetBlock = this.bot.blockAt(stand)
        const headBlock = this.bot.blockAt(stand.offset(0, 1, 0))

        if (
          floorBlock &&
          !this.isAir(floorBlock) &&
          floorBlock.boundingBox !== 'empty' &&
          floorBlock.name !== 'water' &&
          floorBlock.name !== 'lava'
        ) {
          score += 6
        }

        if (this.isStandablePosition(stand)) {
          score += 12
        }

        if (
          feetBlock &&
          headBlock &&
          this.isAir(feetBlock) &&
          this.isAir(headBlock)
        ) {
          score += 2
        }
      }

      // Tie-break toward the side where the bot is already standing.
      if (this.bot.entity) {
        const p = this.bot.entity.position
        const normalCoord = plane.fixedAxis === 'z'
          ? p.z
          : p.x
        const laneCoord = plane.fixed + sign

        score += Math.max(
          0,
          6 - Math.abs(normalCoord - laneCoord)
        )
      }

      this.wallNormalSign = previous
      return score
    }

    const plus = scoreSide(1)
    const minus = scoreSide(-1)
    const chosen = plus >= minus ? 1 : -1

    console.log(
      '[WALL SIDE AUTO] plus=' + plus.toFixed(1) +
      ' minus=' + minus.toFixed(1) +
      ' chosen=' + (chosen > 0 ? '+' : '-')
    )

    return chosen
  }

  wallScaffoldKey(pos) {
    return pos.x + ',' + pos.y + ',' + pos.z
  }

  rememberWallScaffold(pos, type, bandBase) {
    const key = this.wallScaffoldKey(pos)

    this.wallScaffolds.set(key, {
      pos: pos.clone(),
      type,
      bandBase
    })

    const map = type === 'ramp'
      ? this.wallRampByBase
      : this.wallLaneByBase

    if (!map.has(bandBase)) map.set(bandBase, [])
    map.get(bandBase).push(pos.clone())
  }

  wallDirectSupport(plane, target) {
    const supportPos = plane.fixedAxis === 'z'
      ? target.offset(0, 0, -this.wallNormalSign)
      : target.offset(-this.wallNormalSign, 0, 0)

    const block = this.bot.blockAt(supportPos)

    if (
      !block ||
      this.isAir(block) ||
      block.boundingBox === 'empty'
    ) {
      return null
    }

    const face = plane.fixedAxis === 'z'
      ? new Vec3(0, 0, this.wallNormalSign)
      : new Vec3(this.wallNormalSign, 0, 0)

    return { block, face }
  }

  async placeReliable(target, support) {
    try {
      if (typeof this.bot._placeBlockWithOptions === 'function') {
        await this.bot._placeBlockWithOptions(
          support.block,
          support.face,
          {
            forceLook: true,
            swingArm: 'right',
            showHand: false
          }
        )
      } else {
        await this.bot.placeBlock(
          support.block,
          support.face
        )
      }

      const after = this.bot.blockAt(target)

      if (after && !this.isAir(after)) {
        return 'PLACED'
      }

      return 'FAILED'
    } catch (err) {
      // Some server placements succeed but the blockUpdate event arrives
      // late or is dropped. Give the world cache a short grace period and
      // confirm the target block before declaring the placement failed.
      try {
        await sleep(700)
      } catch {}

      const afterError = this.bot.blockAt(target)

      if (afterError && !this.isAir(afterError)) {
        console.log(
          '[RELIABLE PLACE RECOVERED] ' +
          target.x + ' ' + target.y + ' ' + target.z +
          ' after=' + afterError.name +
          ' | original=' + err.message
        )
        return 'PLACED'
      }

      console.log(
        '[RELIABLE PLACE FAILED] ' +
        target.x + ' ' + target.y + ' ' + target.z +
        ' -> ' + err.message
      )
      return 'FAILED'
    }
  }

  async placeWallScaffoldBlock(pos, plane, type, bandBase, token) {
    if (token !== this.runToken) return false

    const existing = this.bot.blockAt(pos)
    if (existing && !this.isAir(existing)) return true

    const useWallFaceFirst =
      type === 'ramp' || type === 'seed'

    let support = useWallFaceFirst
      ? (this.wallDirectSupport(plane, pos) || this.findSupport(pos))
      : (this.findSupport(pos) || this.wallDirectSupport(plane, pos))

    if (!support) return false

    let result = 'FAILED'

    for (let attempt = 1; attempt <= 3; attempt++) {
      const item = this.itemInInventoryByName(
        this.wallScaffoldBlockName
      )
      if (!item) return false

      if (
        !this.bot.heldItem ||
        this.bot.heldItem.name !== this.wallScaffoldBlockName
      ) {
        await this.bot.equip(item, 'hand')
        await sleep(75)
      }

      support = useWallFaceFirst
        ? (this.wallDirectSupport(plane, pos) || this.findSupport(pos))
        : (this.findSupport(pos) || this.wallDirectSupport(plane, pos))

      if (!support) break

      result = await this.placeReliable(pos, support)
      if (result === 'PLACED') break

      await sleep(180 * attempt)
    }

    if (result !== 'PLACED') return false

    this.rememberWallScaffold(pos, type, bandBase)
    this.touchProgress()
    return true
  }

  wallLaneFloorPos(plane, width, baseY) {
    return this.wallPos(plane, width, baseY - 1, 1)
  }

  wallLaneStandPos(plane, width, baseY) {
    return this.wallLaneFloorPos(plane, width, baseY).offset(0, 1, 0)
  }

  async moveToWallLane(plane, width, baseY, token, timeoutMs = 30000) {
    const stand = this.wallLaneStandPos(plane, width, baseY)

    if (!this.isStandablePosition(stand)) {
      throw new Error(
        'Wall lane is not standable at ' +
        stand.x + ' ' + stand.y + ' ' + stand.z
      )
    }

    const closeEnough = () => {
      if (!this.bot.entity) return false

      const p = this.bot.entity.position
      const expectedNormal = plane.fixedAxis === 'z'
        ? plane.fixed + (this.wallNormalSign * 1) + 0.5
        : plane.fixed + (this.wallNormalSign * 1) + 0.5

      const normalDelta = plane.fixedAxis === 'z'
        ? Math.abs(p.z - expectedNormal)
        : Math.abs(p.x - expectedNormal)

      const widthDelta = plane.widthAxis === 'x'
        ? Math.abs(p.x - (width + 0.5))
        : Math.abs(p.z - (width + 0.5))

      return (
        Math.abs(p.y - baseY) <= 0.7 &&
        normalDelta <= 0.85 &&
        widthDelta <= 1.35
      )
    }

    const distance = this.bot.entity
      ? this.bot.entity.position.distanceTo(stand.offset(0.5, 0, 0.5))
      : 999

    if (distance < 0.9 || closeEnough()) return true

    this.traveling = true
    this.touchProgress()

    let exactError = null

    try {
      try {
        await this.withTimeout(
          this.bot.pathfinder.goto(
            new GoalBlock(stand.x, stand.y, stand.z)
          ),
          distance > 10
            ? Math.max(timeoutMs, 90000)
            : Math.min(timeoutMs, 12000),
          'wall lane exact path'
        )

        if (closeEnough()) {
          this.touchProgress()
          return true
        }
      } catch (err) {
        exactError = err
        this.stopMovement()

        console.log(
          '[WALL LANE EXACT FAILED] ' +
          stand.toString() + ' -> ' + err.message
        )
      }

      // Exact GoalBlock is too strict on a 1-block-wide service lane.
      // Stop one block around the requested width and validate that the
      // bot is still on the correct lane/level.
      await this.withTimeout(
        this.bot.pathfinder.goto(
          new GoalNear(
            stand.x,
            stand.y,
            stand.z,
            1
          )
        ),
        distance > 10
          ? Math.max(timeoutMs, 90000)
          : Math.max(timeoutMs, 20000),
        'wall lane near path'
      )

      if (closeEnough()) {
        this.touchProgress()
        return true
      }

      // GoalNear may stop on the adjacent block and report success.
      // If we are already very close to the real lane, do one precise
      // manual step onto the lane instead of failing the whole worker.
      const laneFloor = stand.offset(0, -1, 0)
      const manuallyAligned = await this.manualStepToBootstrapFloor(
        laneFloor,
        token
      )

      if (manuallyAligned && closeEnough()) {
        console.log(
          '[WALL LANE MANUAL ALIGN] ' +
          stand.x + ' ' + stand.y + ' ' + stand.z
        )
        this.touchProgress()
        return true
      }

      throw new Error(
        'Reached near wall lane but not on valid lane position'
      )
    } catch (err) {
      this.stopMovement()

      throw new Error(
        'wall lane path failed at ' +
        stand.x + ' ' + stand.y + ' ' + stand.z +
        ' | exact=' + (exactError ? exactError.message : 'n/a') +
        ' | near=' + err.message
      )
    } finally {
      this.traveling = false
      this.touchProgress()
    }
  }

  wallLaneAnchorPossible(plane, width, baseY) {
    const lane = this.wallLaneFloorPos(plane, width, baseY)
    const current = this.bot.blockAt(lane)

    if (current && !this.isAir(current)) return true

    if (this.wallDirectSupport(plane, lane)) return true

    const below = this.bot.blockAt(lane.offset(0, -1, 0))
    return Boolean(
      below &&
      !this.isAir(below) &&
      below.boundingBox !== 'empty'
    )
  }

  async ensureWallLane(plane, baseY, token, previousBase = null) {
    const widths = []
    for (let w = plane.widthMin; w <= plane.widthMax; w++) {
      widths.push(w)
    }

    const botWidth = this.bot.entity
      ? Math.round(
          plane.widthAxis === 'x'
            ? this.bot.entity.position.x - 0.5
            : this.bot.entity.position.z - 0.5
        )
      : plane.widthMin

    let anchorIndex = widths.reduce((best, width, index) => {
      if (!this.wallLaneAnchorPossible(plane, width, baseY)) {
        return best
      }

      if (best < 0) return index

      return Math.abs(width - botWidth) <
        Math.abs(widths[best] - botWidth)
        ? index
        : best
    }, -1)

    let ordered = []

    if (anchorIndex >= 0) {
      ordered.push(widths[anchorIndex])

      for (let step = 1; step < widths.length; step++) {
        const right = anchorIndex + step
        const left = anchorIndex - step
        if (right < widths.length) ordered.push(widths[right])
        if (left >= 0) ordered.push(widths[left])
      }
    } else if (previousBase === null) {
      const localBootstrapWidth = Math.max(
        plane.widthMin,
        Math.min(plane.widthMax, botWidth)
      )
      const localBootstrapFloor = this.wallLaneFloorPos(
        plane,
        localBootstrapWidth,
        baseY
      )

      try {
        const bootstrapped = await this.ensureWallBootstrapBridge(
          plane,
          baseY,
          token,
          localBootstrapFloor
        )

        if (
          bootstrapped &&
          this.wallLaneAnchorPossible(
            plane,
            localBootstrapWidth,
            baseY
          )
        ) {
          console.log(
            '[WALL LANE LOCAL WALKWAY] width=' +
            localBootstrapWidth +
            ' Y=' + baseY +
            ' slice=' + plane.widthMin + '..' + plane.widthMax
          )

          return this.ensureWallLane(
            plane,
            baseY,
            token,
            previousBase
          )
        }
      } catch (err) {
        console.log(
          '[WALL LANE LOCAL WALKWAY FAILED] slice=' +
          plane.widthMin + '..' + plane.widthMax +
          ' Y=' + baseY + ' -> ' + err.message
        )
      }

      let externalAnchor = null

      const existingLaneAt = width => {
        const lane = this.wallLaneFloorPos(
          plane,
          width,
          baseY
        )
        const block = this.bot.blockAt(lane)

        return Boolean(
          block &&
          !this.isAir(block) &&
          block.boundingBox !== 'empty' &&
          this.isStandablePosition(lane.offset(0, 1, 0))
        )
      }

      // Preserve the good two-bot behavior: do not invent a new
      // bootstrap path. Wait for the neighbouring slice to expose
      // one REAL service-lane block, then extend from it.
      const adjacentDeadline = Date.now() + 15000

      while (
        externalAnchor === null &&
        Date.now() < adjacentDeadline
      ) {
        const adjacent = [
          plane.widthMax + 1,
          plane.widthMin - 1
        ]

        for (const width of adjacent) {
          if (existingLaneAt(width)) {
            externalAnchor = width
            break
          }
        }

        if (externalAnchor === null) {
          await sleep(350)
        }
      }

      // Fallback only if the neighbour is late/missing: use an
      // existing lane farther away. Never treat empty air as an anchor.
      if (externalAnchor === null) {
        for (let distance = 2; distance <= 64; distance++) {
          const candidates = [
            plane.widthMax + distance,
            plane.widthMin - distance
          ]

          const possible = candidates.filter(existingLaneAt)

          if (possible.length) {
            externalAnchor = possible.sort(
              (a, b) =>
                Math.abs(a - botWidth) -
                Math.abs(b - botWidth)
            )[0]
            break
          }
        }
      }

      if (externalAnchor === null) {
        throw new Error(
          'No EXISTING service-lane anchor at Y=' + baseY +
          ' after waiting for neighbour'
        )
      }

      if (externalAnchor < plane.widthMin) {
        for (
          let width = externalAnchor;
          width <= plane.widthMax;
          width++
        ) {
          ordered.push(width)
        }
      } else {
        for (
          let width = externalAnchor;
          width >= plane.widthMin;
          width--
        ) {
          ordered.push(width)
        }
      }

      console.log(
        '[WALL LANE CHAIN] existing=' +
        externalAnchor +
        ' -> slice=' +
        plane.widthMin + '..' + plane.widthMax +
        ' Y=' + baseY
      )
    } else {
      throw new Error(
        'No anchor for upper service lane at Y=' + baseY
      )
    }

    let lastReadyWidth = null

    for (const width of ordered) {
      if (token !== this.runToken || this.state === 'STOPPED') {
        return false
      }

      const lane = this.wallLaneFloorPos(
        plane,
        width,
        baseY
      )
      const current = this.bot.blockAt(lane)

      if (current && !this.isAir(current)) {
        lastReadyWidth = width
        continue
      }

      const lanePlacePoint = lane.offset(0.5, 0.5, 0.5)
      const placeDistance = this.bot.entity
        ? this.bot.entity.position.distanceTo(lanePlacePoint)
        : 999

      if (previousBase !== null) {
        if (placeDistance > 4.2) {
          let moved = false

          for (const lowerWidth of [
            width,
            width - 1,
            width + 1
          ]) {
            try {
              await this.moveToWallLane(
                plane,
                lowerWidth,
                previousBase,
                token,
                30000
              )
              moved = true
              break
            } catch {}
          }

          if (!moved) {
            throw new Error(
              'Cannot reach lower lane to build upper lane near width=' +
              width + ' Y=' + baseY
            )
          }
        }
      } else if (lastReadyWidth !== null) {
        try {
          await this.moveToWallLane(
            plane,
            lastReadyWidth,
            baseY,
            token,
            30000
          )
        } catch {}
      } else if (placeDistance > 4.2) {
        try {
          await this.moveToSafeStand(lane, token)
        } catch {}
      }

      let ok = await this.placeWallScaffoldBlock(
        lane,
        plane,
        'lane',
        baseY,
        token
      )

      if (!ok) {
        for (const other of [width - 1, width + 1]) {
          const otherLane = this.wallLaneFloorPos(
            plane,
            other,
            baseY
          )
          const otherBlock = this.bot.blockAt(otherLane)

          if (otherBlock && !this.isAir(otherBlock)) {
            ok = await this.placeWallScaffoldBlock(
              lane,
              plane,
              'lane',
              baseY,
              token
            )
            if (ok) break
          }
        }
      }

      if (!ok) {
        throw new Error(
          'Cannot build service lane at ' +
          lane.x + ' ' + lane.y + ' ' + lane.z
        )
      }

      lastReadyWidth = width
    }

    return true
  }

  wallBootstrapOnLaneSide(plane, pos) {
    if (plane.fixedAxis === 'z') {
      const laneZ = plane.fixed + this.wallNormalSign
      return this.wallNormalSign > 0
        ? pos.z >= laneZ
        : pos.z <= laneZ
    }

    const laneX = plane.fixed + this.wallNormalSign
    return this.wallNormalSign > 0
      ? pos.x >= laneX
      : pos.x <= laneX
  }

  findWallBootstrapAnchor(plane, targetFloor, maxRadius = 64) {
    for (let radius = 0; radius <= maxRadius; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const dzAbs = radius - Math.abs(dx)
        const dzValues = dzAbs === 0
          ? [0]
          : [-dzAbs, dzAbs]

        for (const dz of dzValues) {
          const floor = new Vec3(
            targetFloor.x + dx,
            targetFloor.y,
            targetFloor.z + dz
          )

          if (!this.wallBootstrapOnLaneSide(plane, floor)) {
            continue
          }

          const block = this.bot.blockAt(floor)

          if (
            !block ||
            this.isAir(block) ||
            block.boundingBox === 'empty'
          ) {
            continue
          }

          const stand = floor.offset(0, 1, 0)

          if (this.isStandablePosition(stand)) {
            return floor
          }
        }
      }
    }

    return null
  }

  async findReachableWallWalkwayAnchor(
    plane,
    targetFloor,
    token,
    maxBridge = 12
  ) {
    if (!this.bot.entity) return null

    const p = this.bot.entity.position
    const origin = new Vec3(
      Math.floor(p.x),
      targetFloor.y,
      Math.floor(p.z)
    )
    const candidates = []
    const seen = new Set()

    for (let radius = 0; radius <= 10; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) {
            continue
          }

          const floor = new Vec3(
            origin.x + dx,
            targetFloor.y,
            origin.z + dz
          )
          const key = floor.x + ',' + floor.y + ',' + floor.z
          if (seen.has(key)) continue
          seen.add(key)

          // Existing walkways may be on either side of the wall.
          // At baseY-1 the route is below the first wall row, so it is
          // safe to cross under the wall plane to reach the service lane.
          const block = this.bot.blockAt(floor)
          if (
            !block ||
            this.isAir(block) ||
            block.boundingBox === 'empty'
          ) {
            continue
          }

          const stand = floor.offset(0, 1, 0)
          if (!this.isStandablePosition(stand)) continue

          const route = this.wallBootstrapRoute(
            plane,
            floor,
            targetFloor
          )

          if (route.length > maxBridge) continue

          const dxBot = (floor.x + 0.5) - p.x
          const dzBot = (floor.z + 0.5) - p.z

          candidates.push({
            floor,
            bridge: route.length,
            botDistance: Math.sqrt(
              (dxBot * dxBot) + (dzBot * dzBot)
            )
          })
        }
      }
    }

    candidates.sort((a, b) =>
      a.bridge - b.bridge ||
      a.botDistance - b.botDistance
    )

    for (const candidate of candidates.slice(0, 16)) {
      if (token !== this.runToken || this.state === 'STOPPED') {
        return null
      }

      if (candidate.botDistance <= 1.6) {
        console.log(
          '[WALL WALKWAY] using current walkway at ' +
          candidate.floor.x + ',' +
          candidate.floor.y + ',' +
          candidate.floor.z +
          ' bridge=' + candidate.bridge
        )
        return candidate.floor
      }

      const moved = await this.moveToBootstrapFloor(
        candidate.floor,
        token,
        7000
      )

      if (moved) {
        console.log(
          '[WALL WALKWAY] reachable walkway at ' +
          candidate.floor.x + ',' +
          candidate.floor.y + ',' +
          candidate.floor.z +
          ' bridge=' + candidate.bridge
        )
        return candidate.floor
      }
    }

    return null
  }

  wallBootstrapRoute(plane, anchor, targetFloor) {
    const route = []
    let x = anchor.x
    let z = anchor.z

    const pushX = targetX => {
      const step = targetX >= x ? 1 : -1
      while (x !== targetX) {
        x += step
        route.push(new Vec3(x, targetFloor.y, z))
      }
    }

    const pushZ = targetZ => {
      const step = targetZ >= z ? 1 : -1
      while (z !== targetZ) {
        z += step
        route.push(new Vec3(x, targetFloor.y, z))
      }
    }

    // Move onto the service-lane side first, then travel along wall width.
    // This keeps the temporary bridge out of the main wall plane.
    if (plane.fixedAxis === 'z') {
      pushZ(targetFloor.z)
      pushX(targetFloor.x)
    } else {
      pushX(targetFloor.x)
      pushZ(targetFloor.z)
    }

    return route
  }

  async manualStepToBootstrapFloor(floor, token) {
    if (!this.bot.entity) return false

    const stand = floor.offset(0, 1, 0)
    const start = this.bot.entity.position
    const startDx = (stand.x + 0.5) - start.x
    const startDz = (stand.z + 0.5) - start.z
    const startHorizontal = Math.sqrt(
      (startDx * startDx) + (startDz * startDz)
    )

    // Manual stepping is only a local fallback for an adjacent block
    // that pathfinder has not cached yet.
    if (
      startHorizontal > 1.8 ||
      Math.abs(start.y - stand.y) > 0.6
    ) {
      return false
    }

    try {
      await this.bot.lookAt(
        new Vec3(
          stand.x + 0.5,
          start.y + 1.0,
          stand.z + 0.5
        ),
        true
      )
    } catch {}

    this.bot.setControlState('sprint', false)
    this.bot.setControlState('jump', false)
    this.bot.setControlState('forward', true)

    const deadline = Date.now() + 2200

    try {
      while (Date.now() < deadline) {
        if (token !== this.runToken || this.state === 'STOPPED') {
          return false
        }

        const p = this.bot.entity.position
        const dx = (stand.x + 0.5) - p.x
        const dz = (stand.z + 0.5) - p.z
        const horizontal = Math.sqrt((dx * dx) + (dz * dz))

        if (
          horizontal <= 0.45 &&
          Math.abs(p.y - stand.y) <= 0.55
        ) {
          console.log(
            '[WALL BOOTSTRAP MANUAL STEP] reached ' +
            stand.x + ' ' + stand.y + ' ' + stand.z
          )
          return true
        }

        await sleep(75)
      }

      return false
    } finally {
      this.bot.setControlState('forward', false)
      this.bot.setControlState('jump', false)
      this.bot.setControlState('sprint', false)
      this.touchProgress()
    }
  }

  async moveToBootstrapFloor(floor, token, timeoutMs = 30000) {
    if (token !== this.runToken || this.state === 'STOPPED') {
      return false
    }

    const stand = floor.offset(0, 1, 0)

    if (!this.isStandablePosition(stand)) {
      return false
    }

    this.traveling = true
    this.touchProgress()

    try {
      await this.withTimeout(
        this.bot.pathfinder.goto(
          new GoalBlock(stand.x, stand.y, stand.z)
        ),
        timeoutMs,
        'wall bootstrap path'
      )

      return true
    } catch (err) {
      console.log(
        '[WALL BOOTSTRAP MOVE FAILED] ' +
        stand.x + ' ' + stand.y + ' ' + stand.z +
        ' -> ' + err.message
      )

      const manual = await this.manualStepToBootstrapFloor(
        floor,
        token
      )

      if (manual) return true
      return false
    } finally {
      this.traveling = false
      this.touchProgress()
    }
  }

  async ensureWallBootstrapBridge(
    plane,
    baseY,
    token,
    targetFloor
  ) {
    const targetBlock = this.bot.blockAt(targetFloor)

    if (
      targetBlock &&
      !this.isAir(targetBlock) &&
      targetBlock.boundingBox !== 'empty' &&
      this.isStandablePosition(targetFloor.offset(0, 1, 0))
    ) {
      const moved = await this.moveToBootstrapFloor(
        targetFloor,
        token,
        60000
      )

      if (moved) return true
    }

    const anchor = await this.findReachableWallWalkwayAnchor(
      plane,
      targetFloor,
      token,
      12
    )

    if (!anchor) {
      throw new Error(
        'No reachable existing walkway within 12 blocks of ' +
        targetFloor.x + ' ' +
        targetFloor.y + ' ' +
        targetFloor.z
      )
    }

    const route = this.wallBootstrapRoute(
      plane,
      anchor,
      targetFloor
    )

    console.log(
      '[WALL BOOTSTRAP] anchor=' +
      anchor.x + ',' + anchor.y + ',' + anchor.z +
      ' target=' +
      targetFloor.x + ',' + targetFloor.y + ',' + targetFloor.z +
      ' blocks=' + route.length
    )

    let previousFloor = anchor

    for (const floor of route) {
      if (token !== this.runToken || this.state === 'STOPPED') {
        return false
      }

      const stand = floor.offset(0, 1, 0)
      const feetBlock = this.bot.blockAt(stand)
      const headBlock = this.bot.blockAt(stand.offset(0, 1, 0))

      if (
        (feetBlock && !this.isAir(feetBlock) && feetBlock.boundingBox !== 'empty') ||
        (headBlock && !this.isAir(headBlock) && headBlock.boundingBox !== 'empty')
      ) {
        throw new Error(
          'Bootstrap route blocked at ' +
          stand.x + ' ' + stand.y + ' ' + stand.z
        )
      }

      let floorBlock = this.bot.blockAt(floor)

      if (!floorBlock || this.isAir(floorBlock)) {
        const placed = await this.placeWallScaffoldBlock(
          floor,
          plane,
          'bootstrap',
          baseY,
          token
        )

        if (!placed) {
          throw new Error(
            'Cannot place bootstrap netherrack at ' +
            floor.x + ' ' + floor.y + ' ' + floor.z +
            ' from ' +
            previousFloor.x + ' ' +
            previousFloor.y + ' ' +
            previousFloor.z
          )
        }

        const confirmed = await this.waitBlockConfirmed(
          floor,
          1800
        )

        if (!confirmed) {
          throw new Error(
            'Bootstrap block not confirmed at ' +
            floor.x + ' ' + floor.y + ' ' + floor.z
          )
        }

        floorBlock = this.bot.blockAt(floor)
      }

      if (
        !floorBlock ||
        this.isAir(floorBlock) ||
        floorBlock.boundingBox === 'empty'
      ) {
        throw new Error(
          'Bootstrap floor invalid at ' +
          floor.x + ' ' + floor.y + ' ' + floor.z
        )
      }

      const moved = await this.moveToBootstrapFloor(
        floor,
        token,
        30000
      )

      if (!moved) {
        throw new Error(
          'Cannot step onto bootstrap block at ' +
          floor.x + ' ' + floor.y + ' ' + floor.z
        )
      }

      previousFloor = floor
    }

    return true
  }

  async ensureWallSeedAnchor(plane, baseY, token) {
    // Preserve the behavior that worked well for W2/W3:
    // if ANY target in the bottom row already has a real block or
    // a valid adjacent support, do not force an extra seed placement.
    for (let width = plane.widthMin; width <= plane.widthMax; width++) {
      const target = this.wallPos(
        plane,
        width,
        baseY,
        0
      )
      const current = this.bot.blockAt(target)

      if (current && !this.isAir(current)) {
        return true
      }

      if (this.findSupport(target)) {
        return true
      }
    }

    // Only an entirely unsupported slice needs a temporary foundation.
    // Put netherrack UNDER the first wall block so the service lane
    // remains free for the bot to stand on.
    const seedWidth = plane.widthMin
    const firstTarget = this.wallPos(
      plane,
      seedWidth,
      baseY,
      0
    )
    const foundation = firstTarget.offset(0, -1, 0)
    const existing = this.bot.blockAt(foundation)

    if (!existing || this.isAir(existing)) {
      const laneWidth = Math.min(
        plane.widthMax,
        seedWidth + 1
      )

      await this.moveToWallLane(
        plane,
        laneWidth,
        baseY,
        token,
        30000
      )

      const seedOk = await this.placeWallScaffoldBlock(
        foundation,
        plane,
        'seed',
        baseY,
        token
      )

      if (!seedOk) {
        throw new Error(
          'Cannot create seed foundation at ' +
          foundation.x + ' ' +
          foundation.y + ' ' +
          foundation.z
        )
      }

      const confirmed = await this.waitBlockConfirmed(
        foundation,
        1800
      )

      if (!confirmed) {
        throw new Error(
          'Seed foundation not confirmed at ' +
          foundation.x + ' ' +
          foundation.y + ' ' +
          foundation.z
        )
      }
    }

    if (!this.findSupport(firstTarget)) {
      throw new Error(
        'Seed foundation did not create support for first wall block'
      )
    }

    this.reply(
      'WALL SEED READY | foundation=' +
      foundation.x + ' ' +
      foundation.y + ' ' +
      foundation.z
    )

    return true
  }

  rampCheckpointReached(checkpoint) {
    if (!this.bot.entity) return false

    const p = this.bot.entity.position
    const dx = p.x - (checkpoint.x + 0.5)
    const dz = p.z - (checkpoint.z + 0.5)
    const horizontal = Math.sqrt((dx * dx) + (dz * dz))

    return (
      p.y >= checkpoint.y - 0.25 &&
      horizontal <= 1.35
    )
  }

  async manualClimbCheckpoint(checkpoint, token) {
    if (!this.bot.entity) return false

    try {
      await this.bot.lookAt(
        checkpoint.offset(0.5, 0.35, 0.5),
        true
      )
    } catch {}

    this.bot.setControlState('sprint', false)
    this.bot.setControlState('forward', true)
    this.bot.setControlState('jump', true)

    const deadline = Date.now() + 3500

    try {
      while (Date.now() < deadline) {
        if (token !== this.runToken || this.state === 'STOPPED') {
          return false
        }

        if (this.rampCheckpointReached(checkpoint)) {
          return true
        }

        await sleep(100)
      }

      return this.rampCheckpointReached(checkpoint)
    } finally {
      this.bot.setControlState('forward', false)
      this.bot.setControlState('jump', false)
      this.touchProgress()
    }
  }

  async waitBlockConfirmed(pos, timeoutMs = 1800) {
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      const block = this.bot.blockAt(pos)

      if (
        block &&
        !this.isAir(block) &&
        block.boundingBox === 'block'
      ) {
        return true
      }

      if (typeof this.bot.waitForTicks === 'function') {
        await this.bot.waitForTicks(1)
      } else {
        await sleep(50)
      }
    }

    return false
  }

  async waitRampConfirmed(steps, finalTarget, timeoutMs = 2200) {
    const positions = [...steps]

    if (
      finalTarget &&
      !positions.some(pos =>
        pos.x === finalTarget.x &&
        pos.y === finalTarget.y &&
        pos.z === finalTarget.z
      )
    ) {
      positions.push(finalTarget)
    }

    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i]
      const confirmed = await this.waitBlockConfirmed(
        pos,
        timeoutMs
      )

      if (!confirmed) {
        console.log(
          '[WALL RAMP CACHE] unconfirmed #' + (i + 1) +
          ' at ' + pos.x + ' ' + pos.y + ' ' + pos.z
        )
        return false
      }
    }

    console.log(
      '[WALL RAMP CACHE] confirmed=' + positions.length
    )

    return true
  }

  async alignToRampFoot(plane, startWidth, currentBase, token) {
    if (!this.bot.entity) return false

    const foot = this.wallLaneStandPos(
      plane,
      startWidth,
      currentBase
    )

    const deadline = Date.now() + 8000

    this.stopMovement()
    this.traveling = true
    this.touchProgress()

    try {
      while (Date.now() < deadline) {
        if (token !== this.runToken || this.state === 'STOPPED') {
          return false
        }

        const p = this.bot.entity.position
        const dx = (foot.x + 0.5) - p.x
        const dz = (foot.z + 0.5) - p.z
        const horizontal = Math.sqrt((dx * dx) + (dz * dz))

        if (
          horizontal <= 0.15 &&
          Math.abs(p.y - foot.y) <= 0.35
        ) {
          return true
        }

        try {
          await this.bot.lookAt(
            new Vec3(
              foot.x + 0.5,
              p.y + 1.0,
              foot.z + 0.5
            ),
            true
          )
        } catch {}

        this.bot.setControlState('sprint', false)
        this.bot.setControlState('jump', false)
        this.bot.setControlState('forward', true)

        await sleep(75)
      }

      return false
    } finally {
      this.bot.setControlState('forward', false)
      this.bot.setControlState('jump', false)
      this.bot.setControlState('sprint', false)
      this.traveling = false
      this.touchProgress()
    }
  }

  async ascendWallRamp(
    plane,
    currentBase,
    nextBase,
    token,
    steps,
    finalTarget = null
  ) {
    if (!steps || !steps.length) return true
    if (!this.bot.entity) return false

    for (let i = 0; i < steps.length; i++) {
      const block = this.bot.blockAt(steps[i])

      if (!block || this.isAir(block)) {
        throw new Error(
          'Ramp step missing before climb #' + (i + 1) +
          ' at ' +
          steps[i].x + ' ' + steps[i].y + ' ' + steps[i].z
        )
      }
    }

    const finalBlock = finalTarget || steps[steps.length - 1]
    const finalBlockState = this.bot.blockAt(finalBlock)

    if (!finalBlockState || this.isAir(finalBlockState)) {
      throw new Error(
        'Ramp final target missing at ' +
        finalBlock.x + ' ' + finalBlock.y + ' ' + finalBlock.z
      )
    }

    const finalStand = finalBlock.offset(0, 1, 0)

    this.wallRampRoutes.set(nextBase, {
      final: {
        x: finalBlock.x,
        y: finalBlock.y,
        z: finalBlock.z
      },
      steps: steps.map(step => ({
        x: step.x,
        y: step.y,
        z: step.z
      }))
    })

    console.log(
      '[WALL RAMP TARGET] Y=' + currentBase + '->' + nextBase +
      ' final=' +
      finalBlock.x + ',' + finalBlock.y + ',' + finalBlock.z +
      ' start=' + this.bot.entity.position.toString()
    )

    this.stopMovement()
    this.traveling = true
    this.touchProgress()

    const startedAt = Date.now()
    const deadline = startedAt + 16000
    let wiggleLeft = true
    let stuckTicks = 0

    try {
      while (Date.now() < deadline) {
        if (token !== this.runToken || this.state === 'STOPPED') {
          return false
        }

        const p = this.bot.entity.position
        const feet = p.floored()

        // Once the bot reaches the new band height and is actually
        // standing on a solid block, the climb is complete.
        if (
          p.y >= nextBase - 0.12 &&
          this.isStandablePosition(feet)
        ) {
          console.log(
            '[WALL RAMP ASCEND OK] Y=' + p.y.toFixed(2) +
            ' pos=' + p.toString()
          )
          return true
        }

        // Keep the camera horizontal. Only yaw matters for walking.
        try {
          await this.bot.lookAt(
            new Vec3(
              finalStand.x + 0.5,
              p.y + 1.0,
              finalStand.z + 0.5
            ),
            true
          )
        } catch {}

        this.bot.setControlState('sprint', false)
        this.bot.setControlState('forward', true)

        // Jump only when the physics engine says the bot is grounded.
        // As soon as it leaves the ground, release jump until the next landing.
        const onGround = Boolean(this.bot.entity.onGround)
        this.bot.setControlState('jump', onGround)

        const vel = this.bot.entity.velocity || new Vec3(0, 0, 0)
        const horizontalVelocity = Math.hypot(
          vel.x || 0,
          vel.z || 0
        )

        if (
          Date.now() - startedAt > 300 &&
          horizontalVelocity < 0.02
        ) {
          stuckTicks += 1
        } else {
          stuckTicks = 0
        }

        // Four near-zero horizontal-velocity ticks means the bot is
        // genuinely pushing into an edge. Only then perform a small wiggle.
        if (stuckTicks >= 4) {
          const side = wiggleLeft ? 'left' : 'right'
          wiggleLeft = !wiggleLeft

          console.log(
            '[WALL RAMP STUCK] vel=' +
            horizontalVelocity.toFixed(3) +
            ' wiggle=' + side
          )

          this.bot.setControlState(side, true)
          this.bot.setControlState('jump', Boolean(this.bot.entity.onGround))
          await sleep(220)
          this.bot.setControlState(side, false)

          stuckTicks = 0
          this.touchProgress()
        }

        this.touchProgress()
        await sleep(50)
      }

      const p = this.bot.entity.position
      console.log(
        '[WALL RAMP ASCEND FAIL] target=' +
        finalBlock.x + ',' + finalBlock.y + ',' + finalBlock.z +
        ' finalPos=' + p.toString()
      )

      return (
        p.y >= nextBase - 0.12 &&
        this.isStandablePosition(p.floored())
      )
    } finally {
      this.bot.setControlState('forward', false)
      this.bot.setControlState('jump', false)
      this.bot.setControlState('left', false)
      this.bot.setControlState('right', false)
      this.bot.setControlState('sprint', false)
      this.traveling = false
      this.touchProgress()
    }
  }

  async buildWallRamp(plane, currentBase, nextBase, token) {
    const delta = nextBase - currentBase
    if (delta <= 0) return true

    if (plane.widthLength < delta + 1) {
      throw new Error(
        'Wall slice is too narrow for ramp; width=' +
        plane.widthLength + ' delta=' + delta
      )
    }

    const currentWidth = this.bot.entity
      ? Math.round(
          plane.widthAxis === 'x'
            ? this.bot.entity.position.x - 0.5
            : this.bot.entity.position.z - 0.5
        )
      : plane.widthMin

    const clampedCurrent = Math.max(
      plane.widthMin,
      Math.min(plane.widthMax, currentWidth)
    )

    let startWidth
    let direction

    if (clampedCurrent + delta <= plane.widthMax) {
      startWidth = clampedCurrent
      direction = 1
    } else if (clampedCurrent - delta >= plane.widthMin) {
      startWidth = clampedCurrent
      direction = -1
    } else if (plane.widthMin + delta <= plane.widthMax) {
      startWidth = plane.widthMin
      direction = 1
    } else {
      startWidth = plane.widthMax
      direction = -1
    }

    const steps = []

    // Stay at the foot of the staircase while constructing all steps.
    // This avoids standing inside the block currently being placed.
    await this.moveToWallLane(
      plane,
      startWidth,
      currentBase,
      token,
      30000
    )

    const aligned = await this.alignToRampFoot(
      plane,
      startWidth,
      currentBase,
      token
    )

    if (!aligned) {
      throw new Error(
        'Cannot align to ramp foot at width=' +
        startWidth + ' Y=' + currentBase
      )
    }

    // Build every stair first. With band <= 4 every wall face remains
    // inside normal Minecraft placement reach from this base position.
    for (let level = 1; level <= delta; level++) {
      if (token !== this.runToken || this.state === 'STOPPED') return false

      const width = startWidth + (direction * level)
      const stepY = (currentBase - 1) + level
      const step = this.wallPos(
        plane,
        width,
        stepY,
        1
      )

      steps.push(step)

      const wallSupport = this.wallDirectSupport(
        plane,
        step
      )

      if (!wallSupport) {
        throw new Error(
          'No verified wall support for ramp at ' +
          step.x + ' ' + step.y + ' ' + step.z
        )
      }

      const existing = this.bot.blockAt(step)

      if (!existing || this.isAir(existing)) {
        const stepOk = await this.placeWallScaffoldBlock(
          step,
          plane,
          'ramp',
          nextBase,
          token
        )

        if (!stepOk) {
          throw new Error(
            'Cannot place wall-attached ramp at ' +
            step.x + ' ' + step.y + ' ' + step.z
          )
        }
      }
    }

    let finalTarget = steps[steps.length - 1]

    const landingWidth =
      this.wallWidthOf(plane, finalTarget) + direction

    if (
      landingWidth >= plane.widthMin &&
      landingWidth <= plane.widthMax
    ) {
      const landing = this.wallPos(
        plane,
        landingWidth,
        nextBase - 1,
        1
      )

      const landingBlock = this.bot.blockAt(landing)

      if (!landingBlock || this.isAir(landingBlock)) {
        const landingOk = await this.placeWallScaffoldBlock(
          landing,
          plane,
          'ramp',
          nextBase,
          token
        )

        if (landingOk) {
          finalTarget = landing
        }
      } else {
        finalTarget = landing
      }
    }

    this.reply(
      'WALL RAMP BUILT | Y=' + currentBase +
      ' -> ' + nextBase +
      ' steps=' + steps.length +
      ' landing=' +
      finalTarget.x + ',' + finalTarget.y + ',' + finalTarget.z
    )

    const cacheReady = await this.waitRampConfirmed(
      steps,
      finalTarget,
      2200
    )

    if (!cacheReady) {
      throw new Error(
        'Ramp block cache not confirmed before climb Y=' +
        currentBase + ' -> ' + nextBase
      )
    }

    const realigned = await this.alignToRampFoot(
      plane,
      startWidth,
      currentBase,
      token
    )

    if (!realigned) {
      throw new Error(
        'Cannot re-align to ramp foot before climb at width=' +
        startWidth + ' Y=' + currentBase
      )
    }

    const climbed = await this.ascendWallRamp(
      plane,
      currentBase,
      nextBase,
      token,
      steps,
      finalTarget
    )

    if (!climbed) {
      throw new Error(
        'Could not ascend remembered wall ramp Y=' +
        currentBase + ' -> ' + nextBase
      )
    }

    this.reply(
      'WALL RAMP READY | Y=' + currentBase +
      ' -> ' + nextBase
    )

    return true
  }

  wallBandTargets(plane, baseY) {
    const topY = Math.min(
      plane.maxY,
      baseY + this.wallBandHeight - 1
    )

    const targets = []
    let row = 0

    for (let y = baseY; y <= topY; y++) {
      if (row % 2 === 0) {
        for (let w = plane.widthMin; w <= plane.widthMax; w++) {
          targets.push(this.wallPos(plane, w, y, 0))
        }
      } else {
        for (let w = plane.widthMax; w >= plane.widthMin; w--) {
          targets.push(this.wallPos(plane, w, y, 0))
        }
      }

      row += 1
    }

    return targets
  }

  wallBandAirCount(plane, baseY) {
    return this.wallBandTargets(plane, baseY)
      .filter(pos => {
        const block = this.bot.blockAt(pos)
        return !block || this.isAir(block)
      }).length
  }

  wallLaneMissingCount(plane, baseY) {
    let count = 0

    for (let w = plane.widthMin; w <= plane.widthMax; w++) {
      const block = this.bot.blockAt(
        this.wallLaneFloorPos(plane, w, baseY)
      )

      if (!block || this.isAir(block)) count += 1
    }

    return count
  }

  async waitForWallResume(token) {
    while (this.state === 'PAUSED') {
      await sleep(250)

      if (token !== this.runToken || this.state === 'STOPPED') {
        return false
      }
    }

    return token === this.runToken && this.state !== 'STOPPED'
  }

  async returnToWallCheckpoint(token) {
    const cp = this.wallCheckpoint

    if (!cp || !cp.stand) return true
    if (token !== this.runToken || this.state === 'STOPPED') return false

    const stand = new Vec3(
      cp.stand.x,
      cp.stand.y,
      cp.stand.z
    )

    if (!this.isStandablePosition(stand)) {
      return false
    }

    this.traveling = true
    this.touchProgress()

    try {
      await this.withTimeout(
        this.bot.pathfinder.goto(
          new GoalBlock(stand.x, stand.y, stand.z)
        ),
        90000,
        'return to wall checkpoint'
      )

      this.touchProgress()
      return true
    } catch (err) {
      console.log('[WALL RETURN FAILED] ' + err.message)
      return false
    } finally {
      this.traveling = false
      this.touchProgress()
    }
  }

  async ensureWallInventory(required, plane, baseY, token) {
    const desired = Math.max(
      required,
      required + this.wallReserveBlocks
    )

    if (this.inventoryBlockCount() >= desired) return true

    const currentPos = this.bot.entity
      ? this.bot.entity.position.floored()
      : null

    this.wallCheckpoint = {
      bandBase: baseY,
      index: this.index,
      stand: currentPos
        ? { x: currentPos.x, y: currentPos.y, z: currentPos.z }
        : null
    }

    this.reply(
      'WALL REFILL PRECHECK | bandY=' + baseY +
      ' need=' + desired +
      ' have=' + this.inventoryBlockCount()
    )

    const maxAttempts = Math.max(
      2,
      this.storagePositions.length + 1
    )

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (token !== this.runToken || this.state === 'STOPPED') return false

      if (this.inventoryBlockCount() >= desired) break

      const before = this.inventoryBlockCount()
      const refilled = await this.refillFromStorages(token)

      if (!refilled) break

      const after = this.inventoryBlockCount()
      if (after <= before) break
    }

    if (this.inventoryBlockCount() < required) {
      this.state = 'RUNNING'
      this.alertOwner(
        'WAITING_FOR_SUPPLY: wall band needs ' + required +
        ' ' + this.blockName +
        ', have ' + this.inventoryBlockCount(),
        true
      )
      return false
    }

    this.state = 'RUNNING'

    if (this.wallCheckpoint && this.wallCheckpoint.stand) {
      const returned = await this.returnToWallCheckpoint(token)

      if (!returned) {
        this.alertOwner(
          'Cannot return to wall checkpoint after refill',
          true
        )
        return false
      }
    }

    return true
  }

  async placeWallTarget(target, plane, baseY, token) {
    if (token !== this.runToken) return 'FAILED'

    const current = this.bot.blockAt(target)
    if (current && !this.isAir(current)) return 'SKIP'

    if (this.inventoryBlockCount() <= 0) return 'OUT_OF_BLOCKS'

    const width = this.wallWidthOf(plane, target)
    const stand = this.wallLaneStandPos(plane, width, baseY)

    let distance = this.bot.entity
      ? this.bot.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5))
      : 999

    const yDiff = this.bot.entity
      ? Math.abs(this.bot.entity.position.y - stand.y)
      : 999

    if (
      distance > 4.25 ||
      yDiff > 0.7 ||
      this.botIntersectsBlock(target)
    ) {
      await this.moveToWallLane(
        plane,
        width,
        baseY,
        token,
        30000
      )

      distance = this.bot.entity.position.distanceTo(
        target.offset(0.5, 0.5, 0.5)
      )

      if (distance > 4.45 || this.botIntersectsBlock(target)) {
        return 'PATH_FAILED'
      }
    }

    let support = this.findSupport(target)
    if (!support) return 'NO_SUPPORT'

    for (let attempt = 1; attempt <= 3; attempt++) {
      const item = this.itemInInventory()
      if (!item) return 'OUT_OF_BLOCKS'

      if (!this.bot.heldItem || this.bot.heldItem.name !== this.blockName) {
        await this.bot.equip(item, 'hand')
        await sleep(50)
      }

      support = this.findSupport(target)
      if (!support) return 'NO_SUPPORT'

      const result = await this.placeNoMove(target, support)
      if (result === 'PLACED') return 'PLACED'

      const alternativeWidth = width < plane.widthMax
        ? width + 1
        : Math.max(plane.widthMin, width - 1)

      try {
        await this.moveToWallLane(
          plane,
          alternativeWidth,
          baseY,
          token,
          20000
        )
      } catch {}

      await sleep(120 * attempt)
    }

    return 'FAILED'
  }

  async verifyWallBand(plane, baseY, token) {
    for (let pass = 1; pass <= 3; pass++) {
      const holes = this.wallBandTargets(plane, baseY)
        .filter(pos => {
          const block = this.bot.blockAt(pos)
          return !block || this.isAir(block)
        })

      if (!holes.length) {
        this.wallVerified += 1
        this.reply(
          'WALL VERIFY OK | bandY=' + baseY +
          ' pass=' + pass
        )
        return true
      }

      this.reply(
        'WALL VERIFY | bandY=' + baseY +
        ' holes=' + holes.length +
        ' pass=' + pass
      )

      let fixed = 0

      for (const target of holes) {
        if (token !== this.runToken || this.state === 'STOPPED') return false

        this.wallCurrentTarget = target

        while (this.state === 'PAUSED') {
          await sleep(250)
          if (token !== this.runToken || this.state === 'STOPPED') return false
        }

        if (this.inventoryBlockCount() <= 0) {
          const ok = await this.ensureWallInventory(
            holes.length,
            plane,
            baseY,
            token
          )
          if (!ok) return false
        }

        try {
          const result = await this.placeWallTarget(
            target,
            plane,
            baseY,
            token
          )

          if (result === 'PLACED' || result === 'SKIP') fixed += 1
        } catch (err) {
          console.log(
            '[WALL VERIFY PLACE FAILED] ' +
            target.toString() + ' -> ' + err.message
          )
        }
      }

      if (fixed === 0) break
    }

    const remaining = this.wallBandTargets(plane, baseY)
      .filter(pos => {
        const block = this.bot.blockAt(pos)
        return !block || this.isAir(block)
      })

    if (remaining.length) {
      const first = remaining[0]

      this.alertOwner(
        'WALL band blocked: ' + remaining.length +
        ' holes remain at bandY=' + baseY +
        ' first=' + first.x + ',' + first.y + ',' + first.z,
        true
      )

      return false
    }

    this.wallVerified += 1
    return true
  }

  async digWallScaffold(pos) {
    const key = this.wallScaffoldKey(pos)
    const tracked = this.wallScaffolds.get(key)

    if (!tracked) return true

    const block = this.bot.blockAt(pos)

    if (!block || this.isAir(block)) {
      this.wallScaffolds.delete(key)
      return true
    }

    if (block.name !== this.wallScaffoldBlockName) {
      console.log(
        '[WALL CLEANUP SKIP] changed block at ' +
        pos.x + ' ' + pos.y + ' ' + pos.z +
        ' now=' + block.name
      )
      return false
    }

    const feet = this.bot.entity
      ? this.bot.entity.position.floored()
      : null

    if (
      feet &&
      feet.x === pos.x &&
      feet.z === pos.z &&
      feet.y === pos.y + 1
    ) {
      return false
    }

    try {
      await this.withTimeout(
        this.bot.dig(block, true),
        8000,
        'wall scaffold cleanup'
      )

      this.wallScaffolds.delete(key)
      this.touchProgress()
      return true
    } catch (err) {
      console.log(
        '[WALL CLEANUP FAILED] ' +
        pos.x + ' ' + pos.y + ' ' + pos.z +
        ' -> ' + err.message
      )
      return false
    }
  }

  async cleanupWallScaffolds(plane, token) {
    if (!this.wallScaffolds.size) return true

    this.reply(
      'WALL CLEANUP START | temp=' + this.wallScaffolds.size
    )

    const bases = []

    for (
      let baseY = plane.minY;
      baseY <= plane.maxY;
      baseY += this.wallBandHeight
    ) {
      bases.push(baseY)
    }

    for (let i = bases.length - 1; i >= 1; i--) {
      if (token !== this.runToken || this.state === 'STOPPED') return false

      const upperBase = bases[i]
      const lowerBase = bases[i - 1]
      const middleWidth = Math.floor(
        (plane.widthMin + plane.widthMax) / 2
      )

      try {
        await this.moveToWallLane(
          plane,
          middleWidth,
          lowerBase,
          token,
          60000
        )
      } catch (err) {
        console.log(
          '[WALL CLEANUP DESCEND FAILED] ' + err.message
        )
        break
      }

      const upperBlocks = Array.from(this.wallScaffolds.values())
        .filter(entry => entry.bandBase === upperBase)
        .sort((a, b) => b.pos.y - a.pos.y)

      for (const entry of upperBlocks) {
        if (token !== this.runToken || this.state === 'STOPPED') return false

        const width = this.wallWidthOf(plane, entry.pos)
        const safeWidth = Math.max(
          plane.widthMin,
          Math.min(plane.widthMax, width)
        )

        const distance = this.bot.entity
          ? this.bot.entity.position.distanceTo(
              entry.pos.offset(0.5, 0.5, 0.5)
            )
          : 999

        if (distance > 4.2) {
          try {
            await this.moveToWallLane(
              plane,
              safeWidth,
              lowerBase,
              token,
              30000
            )
          } catch {}
        }

        await this.digWallScaffold(entry.pos)
      }
    }

    const baseEntries = Array.from(this.wallScaffolds.values())
      .filter(entry => entry.bandBase === plane.minY)

    for (const entry of baseEntries) {
      if (token !== this.runToken || this.state === 'STOPPED') return false

      const width = this.wallWidthOf(plane, entry.pos)
      const outsideStand = this.wallPos(
        plane,
        width,
        plane.minY,
        2
      )

      if (this.isStandablePosition(outsideStand)) {
        try {
          this.traveling = true
          await this.withTimeout(
            this.bot.pathfinder.goto(
              new GoalBlock(
                outsideStand.x,
                outsideStand.y,
                outsideStand.z
              )
            ),
            30000,
            'wall base cleanup path'
          )
        } catch {}
        finally {
          this.traveling = false
          this.touchProgress()
        }
      }

      await this.digWallScaffold(entry.pos)
    }

    const remaining = this.wallScaffolds.size

    this.reply(
      'WALL CLEANUP END | remaining=' + remaining
    )

    return remaining === 0
  }

  async runWall(token) {
    const plane = this.detectWallPlane()

    if (!plane) {
      this.alertOwner(
        'WALL mode requires a vertical plane: X fixed or Z fixed, Y must vary',
        true
      )
      return
    }

    if (plane.widthLength < 2) {
      this.alertOwner(
        'WALL slice must be at least 2 blocks wide for service access',
        true
      )
      return
    }

    this.wallPlane = plane
    this.wallNormalSign = this.chooseWallNormalSign(plane)

    const effectiveBandHeight = Math.min(
      this.wallBandHeight,
      Math.max(1, plane.widthLength - 1)
    )

    this.wallBandHeight = effectiveBandHeight
    this.wallBand = 0
    this.wallVerified = 0
    this.wallScaffolds.clear()
    this.wallLaneByBase.clear()
    this.wallRampByBase.clear()
    this.wallRampRoutes.clear()

    this.reply(
      'WALL PREFLIGHT | width=' + plane.widthLength +
      ' height=' + plane.height +
      ' band=' + this.wallBandHeight +
      ' side=' + (this.wallNormalSign > 0 ? '+' : '-') +
      ' stores=' + this.storagePositions.length
    )

    let previousBase = null
    let bandNumber = 0

    for (
      let baseY = plane.minY;
      baseY <= plane.maxY;
      baseY += this.wallBandHeight
    ) {
      if (token !== this.runToken || this.state === 'STOPPED') return

      while (this.state === 'PAUSED') {
        await sleep(250)
        if (token !== this.runToken || this.state === 'STOPPED') return
      }

      bandNumber += 1
      this.wallBand = bandNumber

      const targets = this.wallBandTargets(plane, baseY)
      const air = this.wallBandAirCount(plane, baseY)
      const laneMissing = this.wallLaneMissingCount(plane, baseY)
      const required = air
      const rampNeed = previousBase === null
        ? 0
        : (this.wallBandHeight + 1)
      const tempNeed = laneMissing + rampNeed + 1

      if (this.scaffoldBlockCount() < tempNeed) {
        this.alertOwner(
          'TEMP supply too low for band Y=' + baseY +
          ': need=' + tempNeed +
          ' ' + this.wallScaffoldBlockName +
          ', have=' + this.scaffoldBlockCount(),
          true
        )
        return
      }

      let inventoryReady = false

      while (!inventoryReady) {
        inventoryReady = await this.ensureWallInventory(
          required,
          plane,
          baseY,
          token
        )

        if (inventoryReady) break

        if (token !== this.runToken || this.state === 'STOPPED') return

        if (this.state === 'PAUSED') {
          const resumed = await this.waitForWallResume(token)
          if (!resumed) return
          continue
        }

        return
      }

      if (previousBase === null) {
        // First band starts from the ground/service area.
        try {
          await this.ensureWallLane(
            plane,
            baseY,
            token,
            null
          )
        } catch (err) {
          if (this.wallSide !== 'auto') {
            throw err
          }

          const failedSign = this.wallNormalSign
          this.wallNormalSign = -failedSign

          console.log(
            '[WALL SIDE AUTO RETRY] first side=' +
            (failedSign > 0 ? '+' : '-') +
            ' failed at Y=' + baseY +
            ' -> trying ' +
            (this.wallNormalSign > 0 ? '+' : '-') +
            ' | ' + err.message
          )

          this.reply(
            'WALL SIDE AUTO RETRY | ' +
            (failedSign > 0 ? '+' : '-') +
            ' -> ' +
            (this.wallNormalSign > 0 ? '+' : '-')
          )

          await this.ensureWallLane(
            plane,
            baseY,
            token,
            null
          )
        }
      } else {
        // For later bands: build and remember the staircase first,
        // climb it step-by-step, then extend the new lane from the
        // top stair block.
        await this.buildWallRamp(
          plane,
          previousBase,
          baseY,
          token
        )

        await this.ensureWallLane(
          plane,
          baseY,
          token,
          baseY
        )
      }

      await this.ensureWallSeedAnchor(
        plane,
        baseY,
        token
      )

      const middleWidth = Math.floor(
        (plane.widthMin + plane.widthMax) / 2
      )

      await this.moveToWallLane(
        plane,
        middleWidth,
        baseY,
        token,
        60000
      )

      this.reply(
        'WALL BAND START | ' + bandNumber +
        ' Y=' + baseY +
        ' air=' + air +
        ' total=' + targets.length
      )

      for (const target of targets) {
        if (token !== this.runToken || this.state === 'STOPPED') return

        while (this.state === 'PAUSED') {
          await sleep(250)
          if (token !== this.runToken || this.state === 'STOPPED') return
        }

        if (this.inventoryBlockCount() <= 0) {
          let refilledForBand = false

          while (!refilledForBand) {
            refilledForBand = await this.ensureWallInventory(
              Math.max(
                1,
                targets.length - (this.index % targets.length)
              ),
              plane,
              baseY,
              token
            )

            if (refilledForBand) break

            if (token !== this.runToken || this.state === 'STOPPED') return

            if (this.state === 'PAUSED') {
              const resumed = await this.waitForWallResume(token)
              if (!resumed) return
              continue
            }

            return
          }
        }

        this.wallCurrentTarget = target
        let result

        try {
          result = await this.placeWallTarget(
            target,
            plane,
            baseY,
            token
          )
        } catch (err) {
          console.log(
            '[WALL PLACE ERROR] ' +
            target.toString() + ' -> ' + err.message
          )
          result = 'FAILED'
        }

        if (result === 'PLACED') {
          this.placed += 1
        } else if (result === 'SKIP') {
          this.skipped += 1
        } else if (result === 'NO_SUPPORT') {
          this.noSupport += 1
        } else {
          this.failed += 1
        }

        this.index += 1
        this.touchProgress()

        if (
          this.index % this.progressEvery === 0 ||
          this.index === this.total
        ) {
          this.reply(this.statusText())
        }
      }

      let verified = false

      while (!verified) {
        verified = await this.verifyWallBand(
          plane,
          baseY,
          token
        )

        if (verified) break

        if (token !== this.runToken || this.state === 'STOPPED') return

        if (this.state === 'PAUSED') {
          const resumed = await this.waitForWallResume(token)
          if (!resumed) return
          continue
        }

        return
      }

      previousBase = baseY
    }

    if (token !== this.runToken) return

    const cleaned = await this.cleanupWallScaffolds(
      plane,
      token
    )

    if (token !== this.runToken) return

    this.state = 'DONE'
    this.stopMovement()

    this.reply(
      'WALL DONE | verifiedBands=' + this.wallVerified +
      ' cleanup=' + (cleaned ? 'OK' : 'PARTIAL') +
      ' tempScaffold=' + this.wallScaffolds.size +
      ' | ' + this.statusText()
    )
  }

  async run(token) {
    while (this.index < this.total) {
      if (token !== this.runToken || this.state === 'STOPPED') return

      while (this.state === 'PAUSED') {
        await sleep(250)
        if (token !== this.runToken || this.state === 'STOPPED') return
      }

      if (this.inventoryBlockCount() <= 0) {
        const refilled = await this.refillFromStorages(token)

        if (token !== this.runToken || this.state === 'STOPPED') return

        if (!refilled) {
          if (this.state !== 'PAUSED') {
            this.alertOwner(
              'Cannot continue: no refill source available',
              true
            )
          }
          continue
        }
      }

      const beforeIndex = this.index
      const chunk = await this.placeStreamChunk(token)

      if (token !== this.runToken || this.state === 'STOPPED') return

      if (chunk.processed > 0) {
        this.index += chunk.processed
        this.placed += chunk.placed
        this.skipped += chunk.skipped
        this.badBurstStreak = 0
        this.touchProgress()

        if (
          this.index % this.progressEvery < chunk.processed ||
          this.index === this.total
        ) {
          this.reply(this.statusText())
        }
      }

      if (chunk.status === 'OUT_OF_BLOCKS') {
        continue
      }

      if (chunk.status === 'OK' && chunk.processed > 0) {
        continue
      }

      if (
        chunk.status === 'PATH_FAILED' ||
        chunk.status === 'FAILED' ||
        chunk.status === 'NO_SUPPORT'
      ) {
        // A worker slice can start one block beyond another worker's edge.
        // On an empty platform the neighbour may need a few seconds to
        // create the first reachable/supporting block. Do not pause at
        // index 0 before giving that shared edge time to appear.
        if (
          this.mode === 'stream' &&
          this.index === 0 &&
          beforeIndex === 0 &&
          (
            chunk.status === 'PATH_FAILED' ||
            chunk.status === 'NO_SUPPORT'
          )
        ) {
          const firstTarget = this.targetAt(0)

          if (firstTarget) {
            this.stopMovement()

            const startReady = await this.waitForStreamStartSupport(
              token,
              firstTarget,
              120000
            )

            if (startReady) {
              this.badBurstStreak = 0
              continue
            }
          }
        }

        if (chunk.status === 'NO_SUPPORT') this.noSupport += 1
        else this.failed += 1

        if (this.index === beforeIndex) {
          this.badBurstStreak += 1
        } else {
          this.badBurstStreak = 1
        }

        if (this.badBurstStreak >= 3) {
          this.alertOwner(
            'STREAM blocked at current cell: ' + chunk.status,
            true
          )
          continue
        }

        this.stopMovement()
        await sleep(400 * this.badBurstStreak)
        continue
      }

      if (chunk.processed === 0 && chunk.status === 'OK') {
        this.badBurstStreak += 1

        if (this.badBurstStreak >= 3) {
          this.alertOwner(
            'STREAM made no forward progress',
            true
          )
        } else {
          await sleep(250)
        }
      }
    }

    if (token !== this.runToken) return

    this.repairQueue.clear()
    this.repairCurrentIndex = null
    this.state = 'DONE'
    this.stopMovement()
    this.reply('DONE | ' + this.statusText())
  }

  async repairLocalRange(token, startIndex, endIndex) {
    const pending = Array.from(this.repairQueue)
      .filter(i => i >= startIndex && i < endIndex)
      .sort((a, b) => a - b)

    if (!pending.length) return true

    console.log(
      '[LOCAL REPAIR] range=' + startIndex + '-' + (endIndex - 1) +
      ' holes=' + pending.length
    )

    for (let pass = 1; pass <= 2; pass++) {
      let repairedThisPass = 0

      for (const targetIndex of pending) {
        if (!this.repairQueue.has(targetIndex)) continue
        if (token !== this.runToken || this.state === 'STOPPED') return false

        while (this.state === 'PAUSED') {
          await sleep(250)
          if (token !== this.runToken || this.state === 'STOPPED') return false
        }

        this.repairCurrentIndex = targetIndex
        const target = this.targetAt(targetIndex)
        if (!target) {
          this.repairQueue.delete(targetIndex)
          continue
        }

        const current = this.bot.blockAt(target)
        if (current && !this.isAir(current)) {
          this.repairQueue.delete(targetIndex)
          this.repaired += 1
          repairedThisPass += 1
          this.touchProgress()
          continue
        }

        if (this.inventoryBlockCount() <= 0) {
          const refilled = await this.refillFromStorages(token)
          if (!refilled) {
            this.repairCurrentIndex = null
            return false
          }
          this.state = 'RUNNING'
        }

        const result = await this.placeAt(target, token)

        if (result === 'PLACED' || result === 'SKIP') {
          this.repairQueue.delete(targetIndex)
          this.repaired += 1
          repairedThisPass += 1
          this.touchProgress()
        }
      }

      if (Array.from(this.repairQueue).every(
        i => i < startIndex || i >= endIndex
      )) {
        console.log('[LOCAL REPAIR] complete')
        this.repairCurrentIndex = null
        return true
      }

      if (repairedThisPass === 0) break
    }

    const left = Array.from(this.repairQueue)
      .filter(i => i >= startIndex && i < endIndex).length

    console.log('[LOCAL REPAIR] deferred holes=' + left)
    this.repairCurrentIndex = null
    return true
  }

  async repairMissing(token) {
    if (!this.repairQueue.size) return true

    this.repairPass = 0

    while (this.repairQueue.size > 0 && this.repairPass < 4) {
      if (token !== this.runToken || this.state === 'STOPPED') return false

      this.repairPass += 1
      const pending = Array.from(this.repairQueue).sort((a, b) => a - b)
      let repairedThisPass = 0

      this.reply(
        'REPAIR PASS ' + this.repairPass +
        ' | holes=' + pending.length
      )

      for (const targetIndex of pending) {
        if (token !== this.runToken || this.state === 'STOPPED') return false

        while (this.state === 'PAUSED') {
          await sleep(250)
          if (token !== this.runToken || this.state === 'STOPPED') return false
        }

        this.repairCurrentIndex = targetIndex
        const target = this.targetAt(targetIndex)
        if (!target) {
          this.repairQueue.delete(targetIndex)
          continue
        }

        const current = this.bot.blockAt(target)
        if (current && !this.isAir(current)) {
          this.repairQueue.delete(targetIndex)
          this.repaired += 1
          repairedThisPass += 1
          this.touchProgress()
          continue
        }

        if (this.inventoryBlockCount() <= 0) {
          const refilled = await this.refillFromStorages(token)

          if (token !== this.runToken || this.state === 'STOPPED') return false

          if (!refilled) {
            this.repairCurrentIndex = null
            return false
          }

          this.state = 'RUNNING'
        }

        const result = await this.placeAt(target, token)

        if (result === 'PLACED' || result === 'SKIP') {
          this.repairQueue.delete(targetIndex)
          this.repaired += 1
          repairedThisPass += 1
          this.touchProgress()
        } else if (result === 'OUT_OF_BLOCKS') {
          continue
        }
      }

      this.repairCurrentIndex = null

      if (!this.repairQueue.size) {
        this.reply(
          'REPAIR COMPLETE | repaired=' + this.repaired
        )
        return true
      }

      if (repairedThisPass === 0) {
        const first = Array.from(this.repairQueue)[0]
        this.repairCurrentIndex = first
        this.alertOwner(
          'Repair stopped: ' + this.repairQueue.size +
          ' holes still cannot be placed',
          true
        )
        return false
      }
    }

    if (this.repairQueue.size > 0) {
      const first = Array.from(this.repairQueue)[0]
      this.repairCurrentIndex = first
      this.alertOwner(
        'Repair limit reached: ' + this.repairQueue.size +
        ' holes remain',
        true
      )
      return false
    }

    this.repairCurrentIndex = null
    return true
  }

  itemInInventoryByName(itemName) {
    return this.bot.inventory.items().find(
      item => item.name === itemName
    ) || null
  }

  itemInInventory() {
    return this.itemInInventoryByName(this.blockName)
  }

  isAir(block) {
    return !block || AIR.has(block.name)
  }

  findSupport(target) {
    const choices = [
      { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
      { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) },
      { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
      { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
      { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
      { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) }
    ]

    const found = []

    for (const choice of choices) {
      const pos = target.plus(choice.offset)
      const block = this.bot.blockAt(pos)

      if (
        block &&
        !this.isAir(block) &&
        block.boundingBox !== 'empty'
      ) {
        const distance = this.bot.entity
          ? this.bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5))
          : 999

        found.push({
          block,
          face: choice.face,
          distance
        })
      }
    }

    found.sort((a, b) => a.distance - b.distance)
    return found[0] || null
  }

  botIntersectsBlock(target) {
    if (!this.bot.entity) return false

    const p = this.bot.entity.position

    const minX = p.x - 0.3
    const maxX = p.x + 0.3
    const minY = p.y
    const maxY = p.y + 1.8
    const minZ = p.z - 0.3
    const maxZ = p.z + 0.3

    return (
      maxX > target.x &&
      minX < target.x + 1 &&
      maxY > target.y &&
      minY < target.y + 1 &&
      maxZ > target.z &&
      minZ < target.z + 1
    )
  }

  isStandablePosition(pos) {
    const below = this.bot.blockAt(pos.offset(0, -1, 0))
    const feet = this.bot.blockAt(pos)
    const head = this.bot.blockAt(pos.offset(0, 1, 0))

    if (!below || !feet || !head) return false

    if (
      below.name === 'water' ||
      below.name === 'lava' ||
      feet.name === 'water' ||
      feet.name === 'lava' ||
      head.name === 'water' ||
      head.name === 'lava'
    ) {
      return false
    }

    const solidBelow =
      !this.isAir(below) &&
      below.boundingBox !== 'empty'

    const freeFeet =
      this.isAir(feet) ||
      feet.boundingBox === 'empty'

    const freeHead =
      this.isAir(head) ||
      head.boundingBox === 'empty'

    return solidBelow && freeFeet && freeHead
  }

  preferredRowStandCandidates(target) {
    const d = this.dimensions()
    if (!d || !this.bot.entity) return []

    const zIndex = target.z - d.minZ
    const direction = zIndex % 2 === 0 ? 1 : -1
    const standY = target.y + 1
    const out = []

    const offsets = [3, 2, 1]

    for (const back of offsets) {
      const x = target.x - (direction * back)

      if (x < d.minX || x > d.maxX) continue

      const pos = new Vec3(x, standY, target.z)

      if (!this.isStandablePosition(pos)) continue

      const reach = pos.offset(0.5, 0, 0.5).distanceTo(
        target.offset(0.5, 0.5, 0.5)
      )

      if (reach <= 4.1) {
        out.push(pos)
      }
    }

    return out
  }

  safeStandCandidates(target) {
    if (!this.bot.entity) return []

    const candidates = []
    const standY = target.y + 1

    for (let radius = 1; radius <= 3; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue

          const pos = new Vec3(
            target.x + dx,
            standY,
            target.z + dz
          )

          if (!this.isStandablePosition(pos)) continue

          const reachDistance = pos.offset(0.5, 0, 0.5).distanceTo(
            target.offset(0.5, 0.5, 0.5)
          )

          if (reachDistance > 4.1) continue

          candidates.push(pos)
        }
      }
    }

    const current = this.bot.entity.position.floored()

    candidates.sort((a, b) => {
      let da = this.bot.entity.position.distanceTo(a.offset(0.5, 0, 0.5))
      let db = this.bot.entity.position.distanceTo(b.offset(0.5, 0, 0.5))

      if (a.equals(current)) da += 100
      if (b.equals(current)) db += 100

      return da - db
    })

    return candidates
  }

  async moveToSafeStand(target, token) {
    const preferred = this.preferredRowStandCandidates(target)
    const fallback = this.safeStandCandidates(target)

    const seen = new Set()
    const candidates = []

    for (const pos of [...preferred, ...fallback]) {
      const key = pos.x + ',' + pos.y + ',' + pos.z
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(pos)
    }

    const startDistance = this.bot.entity
      ? this.bot.entity.position.distanceTo(
          target.offset(0.5, 0.5, 0.5)
        )
      : 0

    const longTravel = startDistance > 10
    if (longTravel) {
      this.traveling = true
      this.touchProgress()
      console.log(
        '[TRAVEL] target=' +
        target.x + ' ' + target.y + ' ' + target.z +
        ' distance=' + startDistance.toFixed(1)
      )
    }

    try {
      for (const pos of candidates.slice(0, 8)) {
        if (token !== this.runToken) throw new Error('Stopped')

        try {
          this.touchProgress()

          await this.withTimeout(
            this.bot.pathfinder.goto(
              new GoalBlock(pos.x, pos.y, pos.z)
            ),
            longTravel
              ? Math.max(this.pathTimeoutMs, 30000)
              : Math.max(this.pathTimeoutMs, 15000),
            longTravel ? 'travel safe stand path' : 'safe stand path'
          )

          if (token !== this.runToken) throw new Error('Stopped')

          const distance = this.bot.entity.position.distanceTo(
            target.offset(0.5, 0.5, 0.5)
          )

          if (
            distance <= 4.45 &&
            !this.botIntersectsBlock(target) &&
            this.findSupport(target)
          ) {
            this.touchProgress()
            return true
          }
        } catch (err) {
          this.stopMovement()
          this.touchProgress()
          console.log(
            '[SAFE STAND FAILED] ' +
            pos.x + ' ' + pos.y + ' ' + pos.z +
            ' -> ' + err.message
          )
        }
      }

      return false
    } finally {
      if (longTravel) {
        this.traveling = false
        this.touchProgress()
      }
    }
  }

  async moveIntoPlaceRange(target, token) {
    if (!this.bot.entity) throw new Error('No bot entity')

    const distance = this.bot.entity.position.distanceTo(
      target.offset(0.5, 0.5, 0.5)
    )

    if (
      distance <= 4.45 &&
      this.findSupport(target) &&
      !this.botIntersectsBlock(target) &&
      this.bot.entity.position.y >= target.y + 0.85
    ) {
      return
    }

    if (token !== this.runToken) throw new Error('Stopped')

    const moved = await this.moveToSafeStand(target, token)

    if (moved) return

    throw new Error(
      'No safe stand near target ' +
      target.x + ' ' + target.y + ' ' + target.z
    )
  }

  async placeAt(target, token) {
    if (token !== this.runToken) return 'FAILED'

    let current = this.bot.blockAt(target)

    if (current && !this.isAir(current)) {
      return 'SKIP'
    }

    const item = this.itemInInventory()
    if (!item) return 'OUT_OF_BLOCKS'

    try {
      await this.moveIntoPlaceRange(target, token)
    } catch (err) {
      if (token !== this.runToken) return 'FAILED'

      console.log(
        '[PATH FAILED] ' +
        target.x + ' ' + target.y + ' ' + target.z +
        ' -> ' + err.message
      )
      return 'FAILED'
    }

    if (token !== this.runToken) return 'FAILED'

    current = this.bot.blockAt(target)
    if (current && !this.isAir(current)) {
      return 'SKIP'
    }

    const support = this.findSupport(target)
    if (!support) {
      console.log(
        '[NO SUPPORT] ' +
        target.x + ' ' + target.y + ' ' + target.z
      )
      return 'NO_SUPPORT'
    }

    const freshItem = this.itemInInventory()
    if (!freshItem) return 'OUT_OF_BLOCKS'

    try {
      if (!this.bot.heldItem || this.bot.heldItem.name !== this.blockName) {
        await this.bot.equip(freshItem, 'hand')
      }

      if (typeof this.bot._placeBlockWithOptions === 'function') {
        await this.bot._placeBlockWithOptions(
          support.block,
          support.face,
          { forceLook: 'ignore', swingArm: false, showHand: false }
        )
      } else {
        await this.bot.placeBlock(support.block, support.face)
      }

      if (this.placeDelayTicks > 0) {
        await this.bot.waitForTicks(this.placeDelayTicks)
      }

      const after = this.bot.blockAt(target)
      if (after && !this.isAir(after)) {
        return 'PLACED'
      }

      return 'FAILED'
    } catch (err) {
      console.log(
        '[PLACE FAILED] ' +
        target.x + ' ' + target.y + ' ' + target.z +
        ' -> ' + err.message
      )
      return 'FAILED'
    }
  }
}

module.exports = Builder

