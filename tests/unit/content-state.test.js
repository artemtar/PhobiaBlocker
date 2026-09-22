const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createContentHarness } = require('./helpers/content-harness')

const clean = { shouldBlur: false, matchedWords: [], matchedInputWords: [] }

test('a visual update cannot supersede an unapplied protection enable', async () => {
    const env = createContentHarness()
    await env.controller.applyProtectionMode('DISABLED', { ...env.Policy.DEFAULTS, phobiaBlockerEnabled: false })
    const reads = []
    env.storage.getWithDefaults = () => new Promise(resolve => reads.push(resolve))
    const enabling = env.readAndApplySettings()
    const visual = env.readAndApplySettings({ visualOnly: true })
    reads[0]({ ...env.Policy.DEFAULTS, wordCoverEnabled: false, phobiaBlockerEnabled: true })
    reads[1]({ ...env.Policy.DEFAULTS, wordCoverEnabled: false, phobiaBlockerEnabled: true, blurValueAmount: 70 })
    await Promise.all([enabling, visual])
    assert.equal(env.controller.mode, 'ANALYZE')
    assert.equal(env.controller.settings.blurValueAmount, 70)
})

test('a superseding visual update applies newly loaded target words', async () => {
    const env = createContentHarness()
    await env.controller.applyProtectionMode('ANALYZE', { ...env.Policy.DEFAULTS, targetWords: ['spider'], wordCoverEnabled: false })
    const before = env.controller._policyGeneration
    const reads = []
    env.storage.getWithDefaults = () => new Promise(resolve => reads.push(resolve))
    const targets = env.readAndApplySettings()
    const visual = env.readAndApplySettings({ visualOnly: true })
    reads.forEach(resolve => resolve({ ...env.Policy.DEFAULTS, targetWords: ['snake'], wordCoverEnabled: false }))
    await Promise.all([targets, visual])
    assert.ok(env.controller._policyGeneration > before, 'new target words must invalidate the old analysis')
    assert.deepEqual([...env.controller._wordCoverManager._targets], ['snake'])
})

test('a genuine visual-only change preserves the completed analysis', async () => {
    const env = createContentHarness()
    const settings = { ...env.Policy.DEFAULTS, wordCoverEnabled: false }
    await env.controller.applyProtectionMode('ANALYZE', settings)
    const before = env.controller._policyGeneration
    env.storage.getWithDefaults = async () => ({ ...settings, blurValueAmount: 70 })
    await env.readAndApplySettings({ visualOnly: true })
    assert.equal(env.controller._policyGeneration, before)
    assert.equal(env.controller.settings.blurValueAmount, 70)
})

test('media changes stay blurred until the new text verdict is committed', () => {
    const env = createContentHarness()
    const image = env.image()
    image.setAttribute('src', 'safe.jpg')
    env.controller.mode = 'ANALYZE'
    env.controller._analysisPending = false
    env.controller._pageAnalysisResult = clean
    env.controller._registerMedia(env.document)
    env.controller._applyResultToNode(env.controller.getVisualNode(image), clean)
    const text = env.text('spider')
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [text], removedNodes: [] }])
    assert.equal(env.controller._analysisPending, true)
    assert.match(image.style.getPropertyValue('filter'), /^blur\(/)
    image.setAttribute('src', 'spider.jpg')
    env.controller._handleMutations([{ type: 'attributes', target: image, attributeName: 'src' }])
    assert.match(image.style.getPropertyValue('filter'), /^blur\(/)
})

test('an explicit reveal is still honored during pending analysis', () => {
    const env = createContentHarness()
    const image = env.image()
    image.setAttribute('src', 'safe.jpg')
    env.controller._registerMedia(env.document)
    env.controller.rememberExplicitReveal(image)
    env.controller._analysisPending = true
    env.controller._applyResultToNode(env.controller.getVisualNode(image), clean)
    assert.equal(image.style.getPropertyValue('filter'), 'none')
})

test('settings reapplication keeps a root background hidden', async () => {
    const env = createContentHarness()
    env.body.style.setProperty('background-image', 'url("trigger.jpg")')
    const settings = { ...env.Policy.DEFAULTS, blurIsAlwaysOn: true, wordCoverEnabled: false }
    await env.controller.applyProtectionMode('ALWAYS_BLUR', settings)
    assert.equal(env.body.style.getPropertyValue('background-image'), 'none')
    await env.controller.applyProtectionMode('ALWAYS_BLUR', { ...settings, wordCoverEnabled: true })
    assert.equal(env.body.style.getPropertyValue('background-image'), 'none')
    assert.equal(env.body.style.getPropertyPriority('background-image'), 'important')
})

test('root backgrounds never become hover previews or filter the page', () => {
    const env = createContentHarness()
    env.body.style.setProperty('background-image', 'url("wallpaper.jpg")')
    env.body.style.setProperty('filter', 'contrast(1.2)')
    env.controller._scanBackgrounds(env.document, { full: true })
    env.controller._hoverPoint = { x: 50, y: 50 }
    env.document.elementsFromPoint = () => [env.body, env.html]
    env.controller._updateHoverPreview()
    assert.equal(env.body.style.getPropertyValue('filter'), 'contrast(1.2)')
    assert.equal(env.controller._hoverNode, null)
    const node = env.controller.getVisualNode(env.body)
    node.showPreview()
    node.hidePreview()
    assert.equal(env.body.style.getPropertyValue('filter'), 'contrast(1.2)')
})

test('removing the last trigger schedules another page analysis', () => {
    const env = createContentHarness()
    const text = env.text('spider')
    env.controller.mode = 'ANALYZE'
    env.controller._analysisPending = false
    env.controller._pageAnalysisResult = { shouldBlur: true, matchedWords: ['spider'], matchedInputWords: ['spider'] }
    env.controller._pageTextIndex.build(env.body)
    env.body.removeChild(text)
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [], removedNodes: [text] }])
    assert.equal(env.controller._pageTextIndex.getTokenCount('spider'), 0)
    assert.equal(env.controller._analysisPending, true)
    assert.ok(env.controller._analysisTimer, 'removal must invalidate the previous verdict')
})

test('removing vocabulary from a clear page neither re-blurs media nor re-analyzes', () => {
    const env = createContentHarness()
    const image = env.image()
    const text = env.text('garden')
    env.controller.mode = 'ANALYZE'
    env.controller._analysisPending = false
    env.controller._pageAnalysisResult = clean
    env.controller._pageTextIndex.build(env.body)
    env.controller._registerMedia(env.document)
    env.controller._applyResultToNode(env.controller.getVisualNode(image), clean)
    env.body.removeChild(text)
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [], removedNodes: [text] }])
    assert.equal(env.controller._pageTextIndex.getTokenCount('garden'), 0)
    assert.equal(env.controller._analysisPending, false)
    assert.equal(env.controller._analysisTimer, null)
    assert.equal(image.style.getPropertyValue('filter'), 'none')
})

test('removing a trigger during analysis rejects its stale verdict and analyzes the remaining page', async () => {
    const env = createContentHarness()
    env.document.readyState = 'complete'
    const image = env.image()
    env.controller.mode = 'ANALYZE'
    env.controller._analysisPending = false
    env.controller._pageAnalysisResult = clean
    env.controller._lastVerdictWordCount = 0
    env.controller._registerMedia(env.document)
    env.controller._applyResultToNode(env.controller.getVisualNode(image), clean)

    const requests = []
    env.context.chrome.runtime.sendMessage = message => {
        if (message.type !== 'PB_ANALYZE_WORDS') return Promise.resolve({ ok: true })
        return new Promise(resolve => requests.push({ words: [...message.words], resolve }))
    }
    const text = env.text('spider')
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [text], removedNodes: [] }])
    const firstAnalysis = env.runTimers(200)
    assert.deepEqual(requests[0].words, ['spider'])

    env.body.removeChild(text)
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [], removedNodes: [text] }])
    requests[0].resolve({ shouldBlur: true, matchedWords: ['spider'], matchedInputWords: ['spider'] })
    await firstAnalysis
    assert.equal(env.controller._pageAnalysisResult.shouldBlur, false, 'the removed trigger verdict must not be committed')
    assert.equal(env.controller._analysisPending, true)

    const freshAnalysis = env.runTimers(200)
    assert.equal(requests.length, 2, 'the remaining page needs a fresh analysis')
    assert.deepEqual(requests[1].words, [])
    requests[1].resolve(clean)
    await freshAnalysis
    assert.equal(env.controller._analysisPending, false)
    assert.equal(env.controller._analysisTimer, null)
    assert.equal(image.style.getPropertyValue('filter'), 'none')
})

test('removing an unmatched word from a blurred page keeps the verdict without re-analysis', () => {
    const env = createContentHarness()
    const text = env.text('garden')
    env.text('spider')
    env.controller.mode = 'ANALYZE'
    env.controller._analysisPending = false
    env.controller._pageAnalysisResult = { shouldBlur: true, matchedWords: ['spider'], matchedInputWords: ['spider'] }
    env.controller._pageTextIndex.build(env.body)
    env.body.removeChild(text)
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [], removedNodes: [text] }])
    assert.equal(env.controller._analysisPending, false)
    assert.equal(env.controller._analysisTimer, null)
})

test('equivalent text replacement does not restart completed analysis', () => {
    const env = createContentHarness()
    const previous = env.text('garden tree')
    env.controller._pageTextIndex.build(env.body)
    env.controller.mode = 'ANALYZE'
    env.controller._analysisPending = false
    env.controller._pageAnalysisResult = clean
    env.body.removeChild(previous)
    const next = env.text('garden tree')
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [next], removedNodes: [previous] }])
    assert.equal(env.controller._analysisPending, false)
    assert.equal(env.controller._analysisTimer, null)
})

test('a document URL notification applies path rules immediately', async () => {
    const env = createContentHarness()
    const settings = { ...env.Policy.DEFAULTS, wordCoverEnabled: false, whitelistedSites: ['example.com/safe'], blacklistedSites: ['example.com/danger'] }
    env.storage.getWithDefaults = async () => settings
    await env.readAndApplySettings()
    assert.equal(env.controller.mode, 'DISABLED')
    env.context.location.href = 'https://example.com/danger'
    let response
    env.messages.forEach(listener => listener({ target: 'content', type: 'PB_URL_CHANGED' }, {}, value => { response = value }))
    assert.equal(env.controller.mode, 'ALWAYS_BLUR')
    assert.equal(response?.ok, true)
})

test('returning to a whitelisted route restores filters after CSS serialization', async () => {
    const env = createContentHarness()
    const image = env.image()
    const styledImage = env.image()
    styledImage.style.setProperty('filter', 'grayscale(1)')
    const settings = { ...env.Policy.DEFAULTS, wordCoverEnabled: false, whitelistedSites: ['example.com/safe'], blacklistedSites: ['example.com/danger'] }
    env.storage.getWithDefaults = async () => settings
    await env.readAndApplySettings()
    env.context.location.href = 'https://example.com/danger'
    env.window.dispatchEvent({ type: 'popstate' })
    assert.match(image.style.getPropertyValue('filter'), /^blur\(/)
    env.context.location.href = 'https://example.com/safe'
    env.window.dispatchEvent({ type: 'popstate' })
    assert.equal(env.controller.mode, 'DISABLED')
    assert.equal(image.style.getPropertyValue('filter'), 'none')
    assert.equal(styledImage.style.getPropertyValue('filter'), 'grayscale(1)')
})

test('blur strength changes and hover previews preserve the original page filter', async () => {
    const env = createContentHarness()
    const image = env.image()
    image.style.setProperty('filter', 'sepia(1)')
    const settings = { ...env.Policy.DEFAULTS, blurIsAlwaysOn: true, wordCoverEnabled: false }
    await env.controller.applyProtectionMode('ALWAYS_BLUR', settings)
    env.controller.setSettings({ ...settings, blurValueAmount: 70 })
    const node = env.controller.getVisualNode(image)
    node.showPreview()
    node.hidePreview()
    await env.controller.applyProtectionMode('DISABLED', settings)
    assert.equal(image.style.getPropertyValue('filter'), 'sepia(1)')
})

for (const observed of [false, true]) {
    test(`a later page filter survives disabling with its mutation ${observed ? 'observed' : 'queued'}`, async () => {
        const env = createContentHarness()
        const image = env.image()
        image.style.setProperty('filter', 'grayscale(1)')
        const settings = { ...env.Policy.DEFAULTS, blurIsAlwaysOn: true, wordCoverEnabled: false }
        await env.controller.applyProtectionMode('ALWAYS_BLUR', settings)
        const oldValue = image.getAttribute('style')
        image.style.setProperty('filter', 'contrast(1.3)')
        if (observed) {
            env.controller._handleMutations([{ type: 'attributes', target: image, attributeName: 'style', oldValue }])
            assert.match(image.style.getPropertyValue('filter'), /^blur\(/)
        }
        await env.controller.applyProtectionMode('DISABLED', settings)
        assert.equal(image.style.getPropertyValue('filter'), 'contrast(1.3)')
    })
}

test('early URL notifications cannot apply unread default settings', () => {
    const env = createContentHarness()
    const generation = env.controller._policyGeneration
    env.context.location.href = 'https://example.com/danger'
    env.messages.forEach(listener => listener({ target: 'content', type: 'PB_URL_CHANGED' }, {}, () => {}))
    assert.equal(env.controller.mode, 'ALWAYS_BLUR')
    assert.equal(env.controller._policyGeneration, generation)
})

test('back/forward applies cached path rules while storage is unavailable', async () => {
    const env = createContentHarness()
    const settings = { ...env.Policy.DEFAULTS, wordCoverEnabled: false, whitelistedSites: ['example.com/safe'], blacklistedSites: ['example.com/danger'] }
    env.storage.getWithDefaults = async () => settings
    await env.readAndApplySettings()
    env.storage.getWithDefaults = async () => { throw new Error('Unexpected storage read on navigation') }
    env.context.location.href = 'https://example.com/danger'
    env.window.dispatchEvent({ type: 'popstate' })
    assert.equal(env.controller.mode, 'ALWAYS_BLUR')
    env.context.location.href = 'https://example.com/safe'
    env.window.dispatchEvent({ type: 'popstate' })
    assert.equal(env.controller.mode, 'DISABLED')
})

function stylesheetVisibilityFixture(initiallyHidden) {
    const env = createContentHarness()
    const container = env.body.appendChild(env.document.createElement('p'))
    container.appendChild(env.document.createTextNode('spider'))
    const image = env.image()
    let hidden = initiallyHidden
    const computedStyle = env.context.getComputedStyle
    env.context.getComputedStyle = element => ({
        ...computedStyle(element),
        display: element === container && hidden ? 'none' : 'block',
    })
    env.controller.mode = 'ANALYZE'
    env.controller._analysisPending = false
    env.controller._pageAnalysisResult = initiallyHidden
        ? clean
        : { shouldBlur: true, matchedWords: ['spider'], matchedInputWords: ['spider'] }
    env.controller._pageTextIndex.build(env.body)
    env.controller._registerMedia(env.document)
    env.controller._applyResultToNode(env.controller.getVisualNode(image), env.controller._pageAnalysisResult)
    return { ...env, image, setHidden(value) { hidden = value } }
}

// Stylesheet-driven re-indexing is debounced off the observer callback.
const STYLESHEET_REINDEX_DEBOUNCE_MS = 200

for (const initiallyHidden of [true, false]) {
    test(`stylesheet text changes reindex a trigger becoming ${initiallyHidden ? 'visible' : 'hidden'}`, async () => {
        const env = stylesheetVisibilityFixture(initiallyHidden)
        const style = env.body.appendChild(env.document.createElement('style'))
        env.setHidden(!initiallyHidden)
        env.controller._handleMutations([{ type: 'childList', target: style, addedNodes: [], removedNodes: [] }])
        await env.runTimers(STYLESHEET_REINDEX_DEBOUNCE_MS)
        assert.equal(env.controller._pageTextIndex.getTokenCount('spider'), initiallyHidden ? 1 : 0)
        assert.equal(env.controller._analysisPending, true)
        assert.match(env.image.style.getPropertyValue('filter'), /^blur\(/)
    })
}

test('a burst of stylesheet mutations rebuilds the text index once, after the batch', () => {
    const env = stylesheetVisibilityFixture(true)
    const style = env.body.appendChild(env.document.createElement('style'))
    let builds = 0
    const build = env.controller._pageTextIndex.build.bind(env.controller._pageTextIndex)
    env.controller._pageTextIndex.build = (...args) => { builds++; return build(...args) }
    for (let index = 0; index < 5; index++) {
        env.controller._handleMutations([{ type: 'childList', target: style, addedNodes: [], removedNodes: [] }])
    }
    assert.equal(builds, 0, 'the observer callback must not rebuild the index synchronously')
    const pending = [...env.timers.values()].filter(timer => timer.delay === STYLESHEET_REINDEX_DEBOUNCE_MS)
    assert.equal(pending.length, 1, 'repeated stylesheet mutations coalesce into one rebuild')
})

test('stylesheet edits that preserve visible vocabulary keep the completed verdict', async () => {
    const env = stylesheetVisibilityFixture(true)
    const style = env.body.appendChild(env.document.createElement('style'))
    env.controller._handleMutations([{ type: 'childList', target: style, addedNodes: [], removedNodes: [] }])
    await env.runTimers(STYLESHEET_REINDEX_DEBOUNCE_MS)
    assert.equal(env.controller._analysisPending, false)
    assert.equal(env.image.style.getPropertyValue('filter'), 'none')
})

test('stylesheet load events reindex newly visible trigger text', async () => {
    const env = stylesheetVisibilityFixture(true)
    const link = new env.context.HTMLLinkElement()
    link.rel = 'stylesheet'
    env.controller._watchStylesheetLink(link)
    env.setHidden(false)
    link.dispatchEvent({ type: 'load' })
    await env.runTimers(STYLESHEET_REINDEX_DEBOUNCE_MS)
    assert.equal(env.controller._pageTextIndex.getTokenCount('spider'), 1)
    assert.equal(env.controller._analysisPending, true)
})

test('stylesheet polling reindexes visibility after CSSOM rule insertion', async () => {
    const env = stylesheetVisibilityFixture(true)
    const sheet = { href: null, disabled: false, cssRules: [], media: { mediaText: '' } }
    env.document.styleSheets.push(sheet)
    env.controller._startStylesheetPolling()
    sheet.cssRules.push({ cssText: 'p { display: block }' })
    env.setHidden(false)
    for (const timer of env.intervals.values()) timer.callback()
    await env.runTimers(STYLESHEET_REINDEX_DEBOUNCE_MS)
    assert.equal(env.controller._pageTextIndex.getTokenCount('spider'), 1)
    assert.equal(env.controller._analysisPending, true)
})

test('a background scan cannot acknowledge an unindexed stylesheet visibility change', async () => {
    const env = stylesheetVisibilityFixture(true)
    const sheet = { href: null, disabled: false, cssRules: [], media: { mediaText: '' } }
    env.document.styleSheets.push(sheet)
    env.controller._startStylesheetPolling()
    env.controller._scheduleFullBackgroundRescan()
    sheet.cssRules.push({ cssText: 'p { display: block }' })
    env.setHidden(false)
    await env.runTimers(0)
    for (const timer of env.intervals.values()) timer.callback()
    await env.runTimers(STYLESHEET_REINDEX_DEBOUNCE_MS)
    assert.equal(env.controller._pageTextIndex.getTokenCount('spider'), 1)
    assert.equal(env.controller._analysisPending, true)
    assert.match(env.image.style.getPropertyValue('filter'), /^blur\(/)
})

test('viewport-driven stylesheet visibility changes reindex trigger text', async () => {
    const env = stylesheetVisibilityFixture(true)
    env.controller._attachMediaResourceListeners()
    env.setHidden(false)
    env.window.dispatchEvent({ type: 'resize' })
    await env.runTimers(200)
    assert.equal(env.controller._pageTextIndex.getTokenCount('spider'), 1)
    assert.equal(env.controller._analysisPending, true)
})

function iframeLifecycleFixture() {
    const env = createContentHarness()
    const iframe = env.body.appendChild(new env.context.HTMLIFrameElement())
    iframe.setAttribute('src', 'https://other.example/frame')
    env.controller.mode = 'ANALYZE'
    env.controller._analysisPending = false
    env.controller._pageAnalysisResult = clean
    env.controller._registerMedia(env.document)
    env.controller._markIframeNavigationComplete(iframe)
    const lifecycleObserver = env.observers.find(observer => observer.options?.attributeFilter?.includes('sandbox'))
    return { ...env, iframe, mutate(attributeName) {
        lifecycleObserver.callback([{ type: 'attributes', target: iframe, attributeName }])
    } }
}

for (const adding of [true, false]) {
    test(`${adding ? 'adding' : 'removing'} sandbox alone permits a checked iframe to be released`, () => {
        const env = iframeLifecycleFixture()
        if (adding) env.iframe.setAttribute('sandbox', 'allow-scripts')
        else {
            env.iframe.setAttribute('sandbox', 'allow-scripts')
            env.iframe.removeAttribute('sandbox')
        }
        env.mutate('sandbox')
        env.controller._setFrameAggregateClear(true)
        assert.equal(env.controller._pendingIframeNavigations.has(env.iframe), false)
        assert.equal(env.iframe.style.getPropertyValue('filter'), 'none')
    })
}

test('sandbox changes do not clear an actual pending iframe navigation', () => {
    const env = iframeLifecycleFixture()
    env.iframe.setAttribute('src', 'https://other.example/next')
    env.mutate('src')
    env.iframe.setAttribute('sandbox', 'allow-scripts')
    env.mutate('sandbox')
    env.controller._setFrameAggregateClear(true)
    assert.equal(env.controller._pendingIframeNavigations.has(env.iframe), true)
    assert.match(env.iframe.style.getPropertyValue('filter'), /^blur\(/)
})

test('replacing a nested iframe with the same owner count requires a fresh frame aggregate', async () => {
    const env = iframeLifecycleFixture()
    const previousContainer = env.body.appendChild(env.document.createElement('section'))
    previousContainer.appendChild(env.iframe)
    env.controller._setFrameAggregateClear(true)

    const replacement = env.document.createElement('section')
    const newFrame = replacement.appendChild(new env.context.HTMLIFrameElement())
    newFrame.setAttribute('src', 'https://unknown.example/new')
    env.body.replaceChild(replacement, previousContainer)
    const records = [{
        type: 'childList', target: env.body,
        addedNodes: [replacement], removedNodes: [previousContainer],
    }]
    env.controller._iframeLifecycleObserver.callback(records)
    env.controller._handleMutations(records)
    assert.match(newFrame.style.getPropertyValue('filter'), /^blur\(/, 'a replacement frame cannot inherit the previous clear verdict')

    const requests = []
    env.context.chrome.runtime.sendMessage = message => {
        if (message.type !== 'PB_FRAME_AGGREGATE_REQUEST') return Promise.resolve({ ok: true })
        return new Promise(resolve => requests.push({ message, resolve }))
    }
    await env.runTimers(100)
    assert.equal(requests.length, 1)
    requests[0].resolve({ ok: true, clear: true, epoch: requests[0].message.epoch })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(newFrame.style.getPropertyValue('filter'), 'none', 'a fresh clear result can release the replacement')
})

test('adding an unsupported frame owner inside a subtree invalidates a clear frame aggregate', async () => {
    const env = iframeLifecycleFixture()
    env.controller._setFrameAggregateClear(true)
    const container = env.body.appendChild(env.document.createElement('section'))
    container.appendChild(env.document.createElement('object'))
    const records = [{ type: 'childList', target: env.body, addedNodes: [container], removedNodes: [] }]
    env.controller._iframeLifecycleObserver.callback(records)
    env.controller._handleMutations(records)
    assert.match(env.iframe.style.getPropertyValue('filter'), /^blur\(/)

    const requests = []
    env.context.chrome.runtime.sendMessage = async message => {
        if (message.type === 'PB_FRAME_AGGREGATE_REQUEST') requests.push(message)
        return { ok: true, clear: false, epoch: message.epoch }
    }
    await env.runTimers(100)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].hasUnsupportedFrameOwner, true)
    assert.match(env.iframe.style.getPropertyValue('filter'), /^blur\(/)
})

for (const isTrusted of [false, true]) {
    test(`${isTrusted ? 'trusted' : 'synthetic'} word-cover keyboard shortcut ${isTrusted ? 'is forwarded' : 'is ignored'}`, () => {
        const env = createContentHarness()
        const messages = []
        env.context.chrome.runtime.sendMessage = async message => { messages.push({ ...message }) }
        let prevented = false
        env.document.dispatchEvent({
            type: 'keydown', isTrusted, altKey: true, shiftKey: true,
            ctrlKey: false, metaKey: false, repeat: false, defaultPrevented: false,
            code: 'KeyW', key: 'w', target: env.body,
            preventDefault() { prevented = true },
        })
        assert.deepEqual(messages, isTrusted
            ? [{ target: 'background', type: 'toggleWordCover', source: 'keyboard' }]
            : [])
        assert.equal(prevented, isTrusted)
    })
}
