const assert = require('node:assert/strict')
const test = require('node:test')
const { createContentHarness } = require('./helpers/content-harness')

// Before the first real settings read has been applied, the controller knows
// nothing about the user. Everything it does in that window must leave the
// stylesheet's fail-closed state untouched: no analysis against the default
// trigger list, no default blur or preview projected onto media, and the
// early-blur shim must keep covering trigger words.

const clean = { shouldBlur: false, matchedWords: [], matchedInputWords: [] }
const ANALYSIS_DEBOUNCE_MS = 200
const HOVER_HIT_TEST_INTERVAL_MS = 30

function recordAnalyses(env) {
    const analyses = []
    env.context.chrome.runtime.sendMessage = async (message) => {
        if (message.type === 'PB_ANALYZE_WORDS') analyses.push([...message.words])
        return clean
    }
    return analyses
}

function childListRecord(target, ...addedNodes) {
    return { type: 'childList', target, addedNodes, removedNodes: [] }
}

async function flushAnalysis(env) {
    for (let round = 0; round < 6; round++) {
        await env.settle()
        await env.runTimers(ANALYSIS_DEBOUNCE_MS)
    }
}

test('a URL change before the settings read cannot analyse the page with the default trigger list', async () => {
    // Arrange: an SPA normalises its URL and keeps rendering while the
    // settings read is still outstanding. The user's real triggers are unknown.
    const env = createContentHarness()
    const analyses = recordAnalyses(env)
    const image = env.image()
    env.text('a dog in the garden')
    env.context.location.href = 'https://example.com/safe/normalized'

    // Act
    env.dispatchMutations([childListRecord(env.body, image)])
    await flushAnalysis(env)

    // Assert
    assert.equal(analyses.length, 0, 'no analysis may run against DEFAULTS')
    assert.equal(env.controller.mode, 'ALWAYS_BLUR')
    assert.equal(env.controller.protectionApplied, false)
    assert.notEqual(image.style.getPropertyValue('filter'), 'none', 'media must stay blurred')
})

test('media that arrive before the settings read keep the stylesheet blur and never preview', async () => {
    // Arrange: the user stores a strong blur and no hover preview. Media is
    // parsed before DOMContentLoaded and the storage read.
    const env = createContentHarness()
    recordAnalyses(env)
    const image = env.image()
    env.document.elementsFromPoint = () => [image, env.body, env.html]

    // Act: the parser inserts the image, the pointer rests on it.
    env.dispatchMutations([childListRecord(env.body, image)])
    env.document.dispatchEvent({ type: 'pointermove', clientX: 50, clientY: 50 })
    await env.runTimers(HOVER_HIT_TEST_INTERVAL_MS)

    // Assert: nothing is projected; protection.css's 40px stays in force.
    assert.equal(image.style.getPropertyValue('filter'), '', 'no default blur may override the stylesheet')
    assert.equal(image.classList.contains('phobia-preview'), false)

    // Act: the real settings arrive.
    env.storage.getWithDefaults = async () => ({
        ...env.Policy.DEFAULTS, blurIsAlwaysOn: true, wordCoverEnabled: false,
        blurValueAmount: 100, previewEnabled: false,
    })
    await env.readAndApplySettings()
    env.document.dispatchEvent({ type: 'pointermove', clientX: 51, clientY: 50 })
    await env.runTimers(HOVER_HIT_TEST_INTERVAL_MS)

    // Assert: the user's strength is applied and the disabled preview stays off.
    assert.equal(image.style.getPropertyValue('filter'), 'blur(100px)')
    assert.equal(image.classList.contains('phobia-preview'), false)
})

test('shadow roots that stream in before the settings read adopt the protection stylesheet without default projection', () => {
    // Arrange: declarative shadow DOM parsed before the settings read.
    const env = createContentHarness()
    const host = env.body.appendChild(env.document.createElement('div'))
    const root = host.attachShadow({ mode: 'open' })
    const image = root.appendChild(new env.context.HTMLImageElement())

    // Act
    env.dispatchMutations([childListRecord(env.body, host)])

    // Assert: the root is protected by its stylesheet, media is left to it.
    assert.equal(root.adoptedStyleSheets.length, 1, 'early discovery must keep the shadow stylesheet')
    assert.equal(image.style.getPropertyValue('filter'), '')
    assert.equal(env.controller.protectionApplied, false)
})

test('early-blur covers trigger words until the controller applies the first settings read', async () => {
    // Arrange: manifest order (early-blur.js before js.js) with a settings read
    // that resolves only after both scripts have run, as on a real page.
    let resolveRead
    const env = createContentHarness({
        earlyBlur: true,
        getWithDefaults: () => new Promise((resolve) => { resolveRead = resolve }),
    })
    recordAnalyses(env)
    const settings = { ...env.Policy.DEFAULTS, targetWords: ['spider'], wordCoverEnabled: true }
    const paragraph = env.body.appendChild(env.document.createElement('p'))
    paragraph.appendChild(env.document.createTextNode('a spider on the wall'))

    // Act: the storage read settles while DOMContentLoaded is still pending.
    resolveRead(settings)
    await env.settle()

    // Assert: the shim covers the word and projects the blur strength.
    assert.equal(env.controller.protectionApplied, false)
    const earlyCovers = paragraph.querySelectorAll('.phobia-word-cover')
    assert.equal(earlyCovers.length, 1, 'early-blur must cover trigger words before the controller takes over')
    assert.equal(earlyCovers[0].textContent, 'spider')
    const blurPixels = `${env.Policy.computeBlurPixels(settings.blurValueAmount)}px`
    assert.equal(env.html.style.getPropertyValue(env.Policy.CSS_VARS.blurNs), blurPixels)

    // Act: DOMContentLoaded lets the controller apply the shared read.
    await env.readAndApplySettings()

    // Assert: the word stays covered, now by the controller's own cover.
    const covers = paragraph.querySelectorAll('.phobia-word-cover')
    assert.equal(covers.length, 1)
    assert.equal(covers[0].textContent, 'spider')
    assert.equal(env.controller._wordCoverManager.ownsWrapper(covers[0]), true)
    assert.equal(env.controller.protectionApplied, true)
})

test('early-blur still covers words streamed in after its settings read while the controller waits', async () => {
    // Arrange
    let resolveRead
    const env = createContentHarness({
        earlyBlur: true,
        getWithDefaults: () => new Promise((resolve) => { resolveRead = resolve }),
    })
    recordAnalyses(env)
    const settings = { ...env.Policy.DEFAULTS, targetWords: ['spider'], wordCoverEnabled: true }
    resolveRead(settings)
    await env.settle()

    // Act: the parser streams another paragraph before DOMContentLoaded.
    const paragraph = env.body.appendChild(env.document.createElement('p'))
    paragraph.appendChild(env.document.createTextNode('another spider'))
    env.dispatchMutations([childListRecord(env.body, paragraph)])

    // Assert
    assert.equal(env.controller.protectionApplied, false)
    assert.equal(paragraph.querySelectorAll('.phobia-word-cover').length, 1)
})
