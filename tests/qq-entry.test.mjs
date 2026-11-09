import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { desktopEntry, desktopMarker, stockEntries } from '../dsh/qq-entry.mjs'

test('a fresh QQ entry loads the Framework before the normal QQ launcher across version labels', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hnu-qq-entry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'app_launcher'))
  writeFileSync(join(dir, 'app_launcher/index.js'), '')
  for (const version of ['7.0.2-53644', '7.0.3-54395', '8.1.0-99999']) {
    for (const main of stockEntries) {
      const paths = { binary: '/Applications/QQ.app/Contents/MacOS/QQ', runtime: join(dir, 'runtime'), framework: dir }
      const code = desktopEntry({ version, main }, '', paths)
      const calls = []
      const context = { process: { execPath: paths.binary, env: {} }, __dirname: dir, global: { launcher: { installPathPkgJson: {} } }, setImmediate,
        require(path) {
          if (path === 'node:path') return createRequire(import.meta.url)(path)
          calls.push(path)
        } }
      runInNewContext(code, context)
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(calls, [join(dir, 'napcat.cjs'), join(dir, 'app_launcher/index.js')])
      assert.equal(context.global.launcher.installPathPkgJson.main, main)
      assert.equal(context.process.env.NAPCAT_WORKDIR, paths.runtime)
    }
  }
})

test('existing desktop entries are idempotent and unknown loaders are rejected', () => {
  const paths = { binary: '/QQ', runtime: '/runtime', framework: '/framework' }
  const existing = desktopMarker + '\nexisting hook'
  assert.equal(desktopEntry({ main: './loadNapCat.js' }, existing, paths), existing)
  const repaired = desktopEntry({ main: stockEntries[0] }, existing, paths)
  assert.notEqual(repaired, existing)
  assert.match(repaired, /installPathPkgJson.main = "\.\/application.asar\/app_launcher\/index.js"/)
  assert.throws(() => desktopEntry({ main: './other-loader.js' }, '', paths), /入口已经变化/)
  assert.throws(() => desktopEntry({ main: './loadNapCat.js' }, 'unknown loader', paths), /入口已经变化/)
})
