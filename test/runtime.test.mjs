import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dsh-keypool-runtime-'))
process.env.DSH_KEYPOOL_CONFIG = join(dir, 'route-pool.json')

const {
  configFilePath,
  normalizeStoredConfig,
  readStoredConfig,
  statusSnapshot,
  storedConfigError,
  writeStoredConfig,
  noteActiveRoute,
  noteCooling,
  noteFailure,
  noteSwitch,
} = await import('../lib/runtime.js')

const GOOD = {
  pools: [
    {
      name: 'manual',
      routes: [
        { provider: 'vendor-a', model: 'model-1' },
        { provider: 'vendor-b', model: 'model-2' },
      ],
    },
  ],
  cooldownMs: 30_000,
  maxSwitchesPerTurn: 2,
}

test('configFilePath honours DSH_KEYPOOL_CONFIG', () => {
  assert.equal(configFilePath(), process.env.DSH_KEYPOOL_CONFIG)
})

test('write/read round-trips a normalized pool config', () => {
  const saved = writeStoredConfig(GOOD)
  assert.equal(saved.pools.length, 1)
  assert.equal(saved.pools[0].routes.length, 2)
  const onDisk = JSON.parse(readFileSync(process.env.DSH_KEYPOOL_CONFIG, 'utf8'))
  assert.equal(onDisk.cooldownMs, 30_000)
  const read = readStoredConfig()
  assert.deepEqual(read, saved)
  assert.equal(storedConfigError(), undefined)
})

test('invalid documents are rejected and leave the file untouched', () => {
  assert.throws(() => normalizeStoredConfig({ pools: [] }), /at least one pool/)
  assert.throws(() => normalizeStoredConfig(null), /JSON object/)
  assert.throws(() => writeStoredConfig({ pools: [{ routes: [{ provider: 'a', model: 'x' }] }] }), /at least one pool/)
  // The previous valid config is still what the behavior row reads.
  assert.equal(readStoredConfig().pools.length, 1)
})

test('an unreadable file is reported and reads as absent', () => {
  writeFileSync(process.env.DSH_KEYPOOL_CONFIG, '{ not json', 'utf8')
  assert.equal(readStoredConfig(), undefined)
  assert.match(storedConfigError(), /not valid JSON|Unexpected|JSON/)
})

test('a missing file reads as absent without an error', () => {
  process.env.DSH_KEYPOOL_CONFIG = join(dir, 'absent.json')
  assert.equal(readStoredConfig(), undefined)
  assert.equal(storedConfigError(), undefined)
  assert.equal(existsSync(process.env.DSH_KEYPOOL_CONFIG), false)
})

test('a UTF-8 BOM written by a hand editor is tolerated', () => {
  const previous = process.env.DSH_KEYPOOL_CONFIG
  const file = join(dir, 'bom.json')
  process.env.DSH_KEYPOOL_CONFIG = file
  try {
    writeFileSync(file, `\uFEFF${JSON.stringify(GOOD)}`, 'utf8')
    const read = readStoredConfig()
    assert.notEqual(read, undefined)
    assert.equal(read.pools[0].routes.length, 2)
    assert.equal(storedConfigError(), undefined)
  } finally {
    process.env.DSH_KEYPOOL_CONFIG = previous
  }
})

test('the optional codes list is normalized and keeps only usable strings', () => {
  const previous = process.env.DSH_KEYPOOL_CONFIG
  const file = join(dir, 'codes.json')
  process.env.DSH_KEYPOOL_CONFIG = file
  try {
    writeFileSync(file, JSON.stringify({ ...GOOD, codes: ['AUTH', 7, ' ', 'RATE_LIMIT'] }), 'utf8')
    const read = readStoredConfig()
    assert.deepEqual(read.codes, ['AUTH', 'RATE_LIMIT'])
    const saved = writeStoredConfig({ ...GOOD, codes: ['AUTH'] })
    assert.deepEqual(saved.codes, ['AUTH'])
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).codes, ['AUTH'])
    // A document without codes keeps the key absent so the row config still applies.
    writeStoredConfig(GOOD)
    assert.equal('codes' in readStoredConfig(), false)
  } finally {
    process.env.DSH_KEYPOOL_CONFIG = previous
  }
})

test('status snapshot reports active route, cooling and switches newest first', () => {
  noteActiveRoute('vendor-b', 'model-2')
  const until = Date.now() + 60_000
  noteCooling('vendor-a', until)
  noteSwitch('vendor-a/model-1', 'vendor-b/model-2', 'QUOTA')
  noteFailure('vendor-a', 'QUOTA: insufficient quota')
  const snapshot = statusSnapshot()
  assert.deepEqual(snapshot.active, { provider: 'vendor-b', model: 'model-2', at: snapshot.active.at })
  assert.equal(snapshot.cooling.length, 1)
  assert.equal(snapshot.cooling[0].provider, 'vendor-a')
  assert.ok(snapshot.cooling[0].remainingMs > 0)
  assert.equal(snapshot.switches[0].from, 'vendor-a/model-1')
  assert.equal(snapshot.switches[0].to, 'vendor-b/model-2')
  assert.equal(snapshot.lastFailure.provider, 'vendor-a')
})

test('expired cooling entries are pruned from the snapshot', () => {
  noteCooling('vendor-c', Date.now() - 1)
  const snapshot = statusSnapshot()
  assert.equal(snapshot.cooling.some((entry) => entry.provider === 'vendor-c'), false)
})

test('the optional preferFirst flag is normalized and persisted', () => {
  const on = writeStoredConfig({ ...GOOD, preferFirst: true })
  assert.equal(on.preferFirst, true)
  assert.equal(JSON.parse(readFileSync(process.env.DSH_KEYPOOL_CONFIG, 'utf8')).preferFirst, true)
  assert.equal(readStoredConfig().preferFirst, true)
  // A document without the flag keeps it off.
  const off = writeStoredConfig(GOOD)
  assert.equal(off.preferFirst, false)
  assert.equal(JSON.parse(readFileSync(process.env.DSH_KEYPOOL_CONFIG, 'utf8')).preferFirst, false)
})
