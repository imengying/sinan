import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// WCAG 2.1 AA asks for 4.5:1 on body text and 3:1 on large text. The light theme
// carries nearly the whole interface, so every text colour it paints is held to
// the 4.5:1 body threshold here.
//
// Theming in this project runs through two blocks: `styles.css` `:root` declares
// the light tokens and `control-center/control-center.css` `:root[data-theme=dark]`
// redeclares every token and repaints the selectors that carry a literal. A rule
// the dark block never repaints keeps its light literal, so darkening that
// literal for the light theme would leave it darker on a dark surface. Each such
// rule therefore repeats its original colour in the dark block, and the last two
// tests below hold that arrangement in place.

const PANEL = '#ffffff'
const PAGE = '#f4f6f3'
const DARK_PAGE = '#151c18'
const DARK_SURFACE = '#202b24'
const THEME = 'control-center/control-center.css'
const THRESHOLD = 4.5

// `border-color:` and `background-color:` must not be read as text colours.
const COLOR = /(?<![-\w])color\s*:\s*(#[0-9a-fA-F]{3,8})(?=[;\s}])/g
const TOKEN_USE = /(?<![-\w])color\s*:\s*var\(\s*(--[\w-]+)/g
const BACKGROUND = /(?:^|[;{\s])background(?:-color)?\s*:\s*([^;}]+)/gi
const RULE = /([^{}]+)\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g

const source = fileURLToPath(new URL('../src', import.meta.url))
const stylesheets = (function collect(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...collect(path))
    else if (entry.endsWith('.css')) found.push(path)
  }
  return found
})(source)

const relative = (path: string) => path.replace(/\\/g, '/').split('/src/')[1]
const read = (path: string) => readFileSync(path, 'utf8')

function expand(value: string): string | null {
  const raw = value.trim()
  if (!/^#[0-9a-fA-F]{3,8}$/.test(raw)) return null
  let digits = raw.slice(1)
  if (digits.length === 3 || digits.length === 4) digits = [...digits].map(d => d + d).join('')
  if (digits.length === 8) digits = digits.slice(0, 6)
  return digits.length === 6 ? `#${digits.toLowerCase()}` : null
}

function luminance(colour: string): number {
  const channel = (value: number) => {
    const scaled = value / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  const [red, green, blue] = [1, 3, 5].map(i => channel(parseInt(colour.slice(i, i + 2), 16)))
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

// Whitespace collapses but descendant combinators survive: removing every space
// would turn `.user-row small` into `.user-rowsmall`, a different selector.
function norm(selector: string): string {
  return selector.replace(/\s+/g, ' ').replace(/\s*([>+~])\s*/g, '$1').trim()
}

function isDark(selector: string): boolean {
  return selector.includes('data-theme')
}

// `:root` custom properties, so `background: var(--green)` resolves to a surface
// instead of falling through to the page colour.
const lightTokens = (function collect(): Map<string, string> {
  const out = new Map<string, string>()
  for (const path of stylesheets) {
    if (relative(path) === 'display/display.css') continue
    for (const [, selector, body] of read(path).matchAll(RULE)) {
      const name = selector.replace(/\s+/g, ' ').trim()
      if (!/^:root(\s*\[data-density=\w+\])?$/.test(name) || name.includes('data-theme')) continue
      for (const [, key, value] of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) {
        const colour = expand(value)
        if (colour) out.set(key, colour)
      }
    }
  }
  return out
})()

function ownBackground(body: string): string | null | undefined {
  BACKGROUND.lastIndex = 0
  const match = BACKGROUND.exec(body)
  if (!match) return null
  const value = match[1].trim()
  if (/gradient|color-mix|url\(/i.test(value)) return undefined
  const head = value.split(/\s/)[0]
  const token = /^var\(\s*(--[\w-]+)/.exec(head)
  return token ? lightTokens.get(token[1]) ?? undefined : expand(head)
}

// The contrast pass appends its companions after this marker, so the original
// dark block can be told apart from them.
const COMPANION_MARKER = 'Light-theme contrast pass'

function themeSections(): { original: string; companions: string } {
  const css = read(join(source, THEME))
  const at = css.indexOf(COMPANION_MARKER)
  return at === -1
    ? { original: css, companions: '' }
    : { original: css.slice(0, at), companions: css.slice(at) }
}

/** Selectors the original dark block repaints with a colour. */
function darkRepaints(): Set<string> {
  const out = new Set<string>()
  for (const [, head, body] of themeSections().original.matchAll(RULE)) {
    if (!/(?<![-\w])color\s*:/.test(body)) continue
    for (const part of head.split(',')) {
      const name = part.replace(':root[data-theme=dark]', '')
      if (name.trim()) out.add(norm(name))
    }
  }
  return out
}

test('every literal light-theme text colour reaches the WCAG AA body threshold', () => {
  const failures: string[] = []
  let checked = 0

  for (const path of stylesheets) {
    if (relative(path) === 'display/display.css') continue // theme-scoped, see below
    const name = relative(path)
    for (const [, rawSelector, body] of read(path).matchAll(RULE)) {
      const selector = rawSelector.replace(/\s+/g, ' ').trim()
      if (isDark(selector) || selector.includes('.server-display')) continue
      const background = ownBackground(body)
      if (background === undefined) continue
      const surfaces = background ? [background] : [PANEL, PAGE]

      COLOR.lastIndex = 0
      for (const [, raw] of body.matchAll(COLOR)) {
        const colour = expand(raw)
        if (!colour) continue
        const worst = Math.min(...surfaces.map(surface => contrast(colour, surface)))
        checked += 1
        if (worst < THRESHOLD) {
          failures.push(`${name} ${selector} ${colour} is ${worst.toFixed(2)}:1 on ${surfaces.join(' and ')}`)
        }
      }
    }
  }

  expect(checked).toBeGreaterThan(80)
  expect(failures).toEqual([])
})

test('every shared token used as a text colour reaches the threshold in the light theme', () => {

  const used = new Set<string>()
  for (const path of stylesheets) {
    if (relative(path) === 'display/display.css') continue
    for (const [, selector, body] of read(path).matchAll(RULE)) {
      const name = selector.replace(/\s+/g, ' ').trim()
      if (isDark(name) || name.includes('.server-display')) continue
      TOKEN_USE.lastIndex = 0
      for (const [, token] of body.matchAll(TOKEN_USE)) used.add(token)
    }
  }

  const failures: string[] = []
  for (const token of [...used].sort()) {
    const colour = lightTokens.get(token)
    if (!colour) continue
    const worst = Math.min(contrast(colour, PANEL), contrast(colour, PAGE))
    if (worst < THRESHOLD) failures.push(`${token} ${colour} is ${worst.toFixed(2)}:1`)
  }

  expect([...used].length).toBeGreaterThan(3)
  expect(failures).toEqual([])
})

test('the dark theme never receives a colour darker than the light one it preserves', () => {
  // The contrast pass darkens light-theme literals for the light surface. The
  // dark block repeats the pre-pass value for every rule it does not repaint, so
  // the dark appearance is unchanged. This holds that arrangement: a companion
  // is never darker than the light value it sits beside, which is what would
  // happen if a literal were darkened again without updating its companion.
  const companions = new Map<string, string>()
  for (const [, selector, body] of themeSections().companions.matchAll(RULE)) {
    const colour = expand(/color\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(body)?.[1] ?? '')
    if (!colour) continue
    for (const part of selector.split(',')) {
      const name = norm(part.replace(':root[data-theme=dark]', ''))
      if (name) companions.set(name, colour)
    }
  }

  const repainted = darkRepaints()
  const failures: string[] = []
  let paired = 0

  for (const path of stylesheets) {
    if (relative(path) === 'display/display.css') continue
    const name = relative(path)
    for (const [, rawSelector, body] of read(path).matchAll(RULE)) {
      const selector = rawSelector.replace(/\s+/g, ' ').trim()
      if (isDark(selector) || selector.includes('.server-display')) continue
      COLOR.lastIndex = 0
      const literals = [...body.matchAll(COLOR)]
        .map(([, raw]) => expand(raw))
        .filter((value): value is string => Boolean(value))
      if (!literals.length) continue

      for (const part of selector.split(',')) {
        const key = norm(part)
        if (!key || repainted.has(key)) continue
        const companion = companions.get(key)
        if (!companion) continue
        paired += 1
        for (const literal of literals) {
          if (luminance(companion) < luminance(literal)) {
            failures.push(`${name} ${key}: dark ${companion} is darker than light ${literal}`)
          }
        }
      }
    }
  }

  expect(paired).toBeGreaterThan(50)
  expect(failures).toEqual([])
})
test('the theme-scoped display stylesheet carries no literal text colour', () => {
  // `display.css` paints the server dashboard for both themes, so a hardcoded
  // value can only ever be correct in one of them. Tones go through a paired
  // custom property instead, which is what `--d-poor-bar` was added for.
  const literals: string[] = []
  for (const [, selector, body] of read(join(source, 'display/display.css')).matchAll(RULE)) {
    COLOR.lastIndex = 0
    for (const [, raw] of body.matchAll(COLOR)) {
      const colour = expand(raw)
      if (colour) literals.push(`${selector.replace(/\s+/g, ' ').trim()} ${colour}`)
    }
  }
  expect(literals).toEqual([])
})

test('the quality tone scale resolves through paired theme tokens', () => {
  const css = read(join(source, 'display/display.css'))
  const darkStart = css.indexOf('[data-theme="dark"]')
  expect(darkStart).toBeGreaterThan(0)

  for (const tone of ['good', 'fair', 'warning', 'poor', 'danger']) {
    expect(css).toContain(`.d-quality-${tone} { color: var(`)
  }

  const poor = /--d-poor-bar:\s*(#[0-9a-f]{6})/i
  const lightValue = poor.exec(css.slice(0, darkStart))?.[1]
  const darkValue = poor.exec(css.slice(darkStart))?.[1]
  expect(lightValue).toBeDefined()
  expect(darkValue).toBeDefined()
  // One shared value cannot serve a near-white and a near-black card.
  expect(lightValue).not.toBe(darkValue)
  expect(contrast(lightValue as string, '#f8fafb')).toBeGreaterThanOrEqual(THRESHOLD)
  expect(contrast(darkValue as string, '#161d1e')).toBeGreaterThanOrEqual(THRESHOLD)
})
test('the offline overlay dims colour as well as text', () => {
  // A translucent wash barely desaturates a saturated fill, so the meter bars
  // used to punch through at full strength while the text behind them was
  // destroyed, which read as a rendering fault rather than an inactive card.
  const css = read(join(source, 'display/display.css'))
  const rule = /\.d-offline-overlay\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  expect(rule).toContain('backdrop-filter')
  expect(rule).toMatch(/backdrop-filter:[^;]*saturate\(/)
})