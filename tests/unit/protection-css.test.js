// Static checks of css/protection.css, the stylesheet that keeps media blurred
// before any script runs: iframes must carry its blur and must stay clickable
// while blurred, and the early-blur shim must not take over pointer events.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '../..')
const read = file => fs.readFileSync(path.join(repoRoot, file), 'utf8')

// Flat rules only: a nested block such as @media would be split wrongly, and
// protection.css has none.
// Splits a stylesheet into { selector, body } pairs; comments are dropped first.
function cssRules(css) {
    return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .map(([, selector, body]) => ({ selector: selector.trim(), body: body.trim() }))
}

const iframeRules = cssRules(read('css/protection.css')).filter(rule => /\biframe\b/.test(rule.selector))

test('protection.css blurs iframes by default', () => {
    assert.ok(iframeRules.some(rule => /filter:\s*blur\(/.test(rule.body)),
        'an iframe selector must carry the default blur filter')
})

test('protection.css never disables pointer events on iframes', () => {
    // Embedded players and forms must stay usable while blurred. Only the
    // top-frame img/video pre-scan rule may suspend pointer events.
    assert.ok(iframeRules.length > 0)
    for (const rule of iframeRules) {
        assert.doesNotMatch(rule.body, /pointer-events:\s*none/,
            `${rule.selector} must not disable iframe pointer events`)
    }
})

// The click lock on unregistered media belongs to the stylesheet and ends when the
// controller marks background-ready; a second owner in the shim could outlive it.
test('the early-blur shim leaves pointer events to the stylesheet', () => {
    assert.doesNotMatch(read('js/early-blur.js'), /pointer-events/)
})
