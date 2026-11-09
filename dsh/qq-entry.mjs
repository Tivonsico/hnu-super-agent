import { join } from 'node:path'

export const desktopMarker = '// HNU Agent desktop Framework'
export const stockEntries = ['./application.asar/app_launcher/index.js', './application/app_launcher/index.js', './app_launcher/index.js']

export function desktopEntry(spec, original, { binary, runtime, framework }) {
  const stock = stockEntries.includes(spec.main)
  if (!stock && spec.main !== './loadNapCat.js') throw new Error('QQ 启动入口已经变化')
  const base = stock ? [
    "const path = require('node:path');",
    "require(path.join(__dirname, 'app_launcher/index.js'));",
    'setImmediate(() => {',
    '  if (global.launcher && global.launcher.installPathPkgJson) global.launcher.installPathPkgJson.main = ' + JSON.stringify(spec.main) + ';',
    '});', '',
  ].join('\n') : original
  if (base.startsWith(desktopMarker)) return base
  if (!stock && !base.includes('const loadNapcat = process.argv.includes(')) throw new Error('QQ 启动入口已经变化')
  return [
    desktopMarker,
    'if (process.execPath === ' + JSON.stringify(binary) + ') {',
    '  process.env.NAPCAT_WORKDIR = ' + JSON.stringify(runtime) + ';',
    '  process.env.NAPCAT_DISABLE_BYPASS = "1";',
    '  require(' + JSON.stringify(join(framework, 'napcat.cjs')) + ');',
    '}', '', base,
  ].join('\n')
}
