// computeBlurPixels maps the 0-100 slider onto blur pixels with the 1.3.1 curve
// 101^(v/100) - 1: about 2px at 25, 9px at 50, 31px at 75 and exactly 100px at 100.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { createContentHarness } = require('./helpers/content-harness')

const context = vm.createContext({})
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/shared-policy.js'), 'utf8'), context)
const { computeBlurPixels } = context.PhobiaBlockerPolicy

test('the blur slider gives useful low and middle strengths while retaining a strong maximum', () => {
    assert.equal(computeBlurPixels(0), 0)
    for (const [value, minimum, maximum] of [[25, 2, 3], [50, 8, 10], [75, 28, 35]]) {
        const pixels = computeBlurPixels(value)
        assert.ok(pixels >= minimum && pixels <= maximum, `${value} produced ${pixels}px`)
    }
    assert.equal(computeBlurPixels(100), 100)
})

test('each slider step increases blur without discontinuities or invalid CSS values', () => {
    let previous = computeBlurPixels(0)
    for (let value = 1; value <= 100; value++) {
        const pixels = computeBlurPixels(value)
        assert.ok(Number.isFinite(pixels) && pixels > previous, `invalid step at ${value}`)
        // The steepest step is the last one, about 4.5px from 99 to 100.
        assert.ok(pixels - previous < 5, `abrupt step at ${value}`)
        previous = pixels
    }
})

test('blur computation bounds saved out-of-range values and defaults invalid inputs', () => {
    assert.equal(computeBlurPixels(-1), 0)
    assert.equal(computeBlurPixels(150), 100)
    for (const value of [undefined, null, '50', NaN, Infinity, -Infinity]) {
        const pixels = computeBlurPixels(value)
        // Anything non-finite falls back to the default slider value 50, about 9px.
        assert.ok(pixels >= 8 && pixels <= 10, `${String(value)} produced ${pixels}px`)
    }
})

// setSettings re-styles registered media without a new policy application. The
// hover preview must restore the strength current at that time, not the one the
// node was first blurred with.
test('existing media updates to the gentler strength immediately and restores it after preview', async () => {
    const env = createContentHarness()
    const image = env.image()
    const settings = { ...env.Policy.DEFAULTS, blurIsAlwaysOn: true, wordCoverEnabled: false, previewEnabled: true, previewBlurStrength: 5, blurValueAmount: 100 }
    await env.controller.applyProtectionMode('ALWAYS_BLUR', settings)
    assert.equal(image.style.getPropertyValue('filter'), 'blur(100px)')

    env.controller.setSettings({ ...settings, blurValueAmount: 50 })
    const fullFilter = image.style.getPropertyValue('filter')
    const pixels = Number(fullFilter.match(/^blur\(([\d.]+)px\)$/)?.[1])
    assert.ok(pixels >= 8 && pixels <= 10, `existing image retained ${fullFilter}`)

    const node = env.controller.getVisualNode(image)
    node.showPreview()
    assert.equal(image.style.getPropertyValue('filter'), 'blur(5px)')
    node.hidePreview()
    assert.equal(image.style.getPropertyValue('filter'), fullFilter)
    env.controller.setSettings({ ...settings, blurValueAmount: 0 })
    assert.equal(image.style.getPropertyValue('filter'), 'blur(0px)')
})
