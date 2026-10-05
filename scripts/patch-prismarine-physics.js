const fs = require('fs')
const path = require('path')

const target = path.join(
  __dirname,
  '..',
  'node_modules',
  'prismarine-physics',
  'index.js'
)

if (!fs.existsSync(target)) {
  console.log('[STEPFIX] prismarine-physics not installed; skip')
  process.exit(0)
}

let text = fs.readFileSync(target, 'utf8')

const patchedWidth = 'playerHalfWidth: 0.30001'
const patchedHeight = 'playerHeight: 1.80001'

if (text.includes(patchedWidth) && text.includes(patchedHeight)) {
  console.log('[STEPFIX] already applied')
  process.exit(0)
}

const original =
  '    playerHalfWidth: 0.3,\n' +
  '    playerHeight: 1.8,'

const replacement =
  '    // 1.21.x collision epsilon: avoid exact server/client hitbox boundary\n' +
  '    playerHalfWidth: 0.30001,\n' +
  '    playerHeight: 1.80001,'

if (!text.includes(original)) {
  console.error('[STEPFIX] expected prismarine-physics constants not found')
  process.exit(1)
}

text = text.replace(original, replacement)
fs.writeFileSync(target, text)
console.log('[STEPFIX] applied 1.21.x collision epsilon')
