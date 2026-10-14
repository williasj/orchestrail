// Single-file WebUI for Orchestrail admin -- no external deps.
//
// The browser-facing assets (app.js, styles.css, markup.html) are stored as
// real static files under web/assets/ rather than TypeScript template literals.
// This is deliberate: embedding JS inside a TS template literal causes tsc to
// process escape sequences (\n, \*, backticks, etc.) at compile time, silently
// corrupting the served script. Real .js/.css/.html files are passed through
// verbatim, so what you write is exactly what the browser receives.
//
// Assets are read once at module load and assembled into UI_HTML.

import * as fs   from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Assets live next to this module under web/assets/. In production this resolves
// to dist/web/assets/; in dev (tsx) it resolves to src/web/assets/.
const ASSETS_DIR = path.join(__dirname, 'web', 'assets')

function readAsset(name: string): string {
  const p = path.join(ASSETS_DIR, name)
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (e) {
    console.error(`[ui] Failed to read asset ${name} from ${p}:`, e instanceof Error ? e.message : String(e))
    return ''
  }
}

const STYLES = readAsset('styles.css')
const MARKUP = readAsset('markup.html')
const APP_JS = readAsset('app.js')

export const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orchestrail</title>
<style>
${STYLES}
</style>
</head>
<body>
${MARKUP}<script>
${APP_JS}
</script>
</body>
</html>
`
