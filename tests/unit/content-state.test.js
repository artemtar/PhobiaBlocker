// Controller state transitions in the content script: settings-read races, the
// pending-analysis window, URL policy changes, stylesheet-driven visibility,
// the iframe lifecycle and the keyboard shortcut. The invariant throughout: media
// is never revealed without a committed clear verdict, DISABLED mode or an
// explicit user action.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createContentHarness } = require('./helpers/content-harness')

// A committed "nothing found" verdict. Tests assign it to _pageAnalysisResult
// directly to model a page whose analysis already finished; the constructor
// starts pending and fail-closed, so _analysisPending is reset alongside it.
const clean = { shouldBlur: false, matchedWords: [], matchedInputWords: [] }

test('a visual update cannot supersede an unapplied protection enable', async () => {
    const env = createContentHarness()
    await env.controller.applyProtectionMode('DISABLED', { ...env.Policy.DEFAULTS, phobiaBlockerEnabled: false })
    const reads = []
    // Hold both storage reads so the test decides their completion order.
    env.storage.getWithDefaults = () => new Promise(resolve => reads.push(resolve))
    // A policy read (enabling protection) is still in flight when a visual-only
    // read starts. The newer read wins the generation race and the older one is
    // dropped, so the visual read must notice that the mode it loaded differs
    // from the applied one and run the full application instead of a re-style.
    const enabling = env.readAndApplySettings()
    const visual = env.readAndApplySettings({ visualOnly: true })
    // Both reads see protection switched on; only the second carries the new blur.
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
    // Same race, same mode: the superseding visual read still has to notice the
    // changed target list, invalidate the old analysis and re-cover the words.
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
    // Only blurValueAmount changed, so the re-style shortcut applies and the
    // committed verdict survives: the policy generation must not move.
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
    // New vocabulary puts the page back into pending analysis. The verdict was
    // assigned directly, so no clearance was recorded and nothing is retained:
    // the image goes back to blur rather than keeping its release.
    const text = env.text('spider')
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [text], removedNodes: [] }])
    assert.equal(env.controller._analysisPending, true)
    assert.match(image.style.getPropertyValue('filter'), /^blur\(/)
    // Swapping the picture while the verdict is pending must not reveal it.
    image.setAttribute('src', 'spider.jpg')
    env.controller._handleMutations([{ type: 'attributes', target: image, attributeName: 'src' }])
    assert.match(image.style.getPropertyValue('filter'), /^blur\(/)
})

test('an explicit reveal is still honored during pending analysis', () => {
    const env = createContentHarness()
    const image = env.image()
    // rememberExplicitReveal needs a media fingerprint, which the src provides.
    // The user's own reveal is one of the sanctioned reveal paths and outranks
    // the pending state that otherwise blurs everything.
    image.setAttribute('src', 'safe.jpg')
    env.controller._registerMedia(env.document)
    env.controller.rememberExplicitReveal(image)
    env.controller._analysisPending = true
    env.controller._applyResultToNode(env.controller.getVisualNode(image), clean)
    assert.equal(image.style.getPropertyValue('filter'), 'none')
})

test('settings reapplication keeps a root background hidden', async () => {
    const env = createContentHarness()
    // A background on <body> is a root background: it is hidden with
    // background-image:none !important instead of a filter, which would blur the
    // page's text. Re-applying with a changed setting rebuilds the registry and
    // must project the same suppression again.
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
    // The page's own filter must survive: a root background never gets a blur
    // filter, so there is nothing a preview could reduce either.
    env.controller._scanBackgrounds(env.document, { full: true })
    // The harness has no layout: the pointer position and the hit-test stack are
    // supplied directly, with the body on top of the stack.
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
    // Index the text first so the removal is seen as lost vocabulary.
    env.controller._pageTextIndex.build(env.body)
    // The removed word is the one that produced the blur verdict, so the verdict
    // can no longer stand and a re-analysis of what remains is scheduled.
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
    // Removing text cannot introduce a trigger, so a committed clear verdict stays
    // valid: no pending state, no timer, and the image keeps its release.
    env.body.removeChild(text)
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [], removedNodes: [text] }])
    assert.equal(env.controller._pageTextIndex.getTokenCount('garden'), 0)
    assert.equal(env.controller._analysisPending, false)
    assert.equal(env.controller._analysisTimer, null)
    assert.equal(image.style.getPropertyValue('filter'), 'none')
})

test('removing a trigger during analysis rejects its stale verdict and analyzes the remaining page', async () => {
    const env = createContentHarness()
    // A clear verdict is deferred while the page may still be producing text
    // (readyState not complete, or a word count that moved since the last
    // verdict). 'complete' plus _lastVerdictWordCount = 0 below let the final
    // clean verdict for an empty page commit instead of scheduling another pass.
    env.document.readyState = 'complete'
    const image = env.image()
    env.controller.mode = 'ANALYZE'
    env.controller._analysisPending = false
    env.controller._pageAnalysisResult = clean
    env.controller._lastVerdictWordCount = 0
    env.controller._registerMedia(env.document)
    env.controller._applyResultToNode(env.controller.getVisualNode(image), clean)

    // Hold every analysis request so its reply can arrive after the page changed.
    const requests = []
    env.context.chrome.runtime.sendMessage = message => {
        if (message.type !== 'PB_ANALYZE_WORDS') return Promise.resolve({ ok: true })
        return new Promise(resolve => requests.push({ words: [...message.words], resolve }))
    }
    const text = env.text('spider')
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [text], removedNodes: [] }])
    // 200 is ANALYSIS_DEBOUNCE_MS. The timer body runs synchronously up to its
    // first await, so the request is recorded before the promise is awaited; the
    // promise itself settles only once the held reply resolves.
    const firstAnalysis = env.runTimers(200)
    assert.deepEqual(requests[0].words, ['spider'])

    // The trigger leaves while its verdict is in flight. Removing pending input
    // bumps the policy generation, so the blur verdict that arrives is stale and
    // must be dropped: the committed result is still the earlier clean one.
    env.body.removeChild(text)
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [], removedNodes: [text] }])
    requests[0].resolve({ shouldBlur: true, matchedWords: ['spider'], matchedInputWords: ['spider'] })
    await firstAnalysis
    assert.equal(env.controller._pageAnalysisResult.shouldBlur, false, 'the removed trigger verdict must not be committed')
    assert.equal(env.controller._analysisPending, true)

    // The page now has no words at all; the fresh clean verdict commits (see the
    // readyState note above) and releases the image.
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
    // 'spider' still matches, so the blur verdict stands and nothing is rescheduled.
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
    // The same tokens removed and added within one batch: the index reports no
    // vocabulary change, so a finished analysis is left alone.
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
    // The harness starts on https://example.com/safe, which the whitelist covers.
    assert.equal(env.controller.mode, 'DISABLED')
    env.context.location.href = 'https://example.com/danger'
    let response
    // pushState/replaceState emit no popstate; the service worker relays the new
    // URL as PB_URL_CHANGED to the exact document, delivered here through the
    // collected onMessage listeners. The ok reply is what the worker's retry
    // logic counts as an acknowledgement.
    env.messages.forEach(listener => listener({ target: 'content', type: 'PB_URL_CHANGED' }, {}, value => { response = value }))
    assert.equal(env.controller.mode, 'ALWAYS_BLUR')
    assert.equal(response?.ok, true)
})

test('returning to a whitelisted route restores filters after CSS serialization', async () => {
    const env = createContentHarness()
    const image = env.image()
    // One image carries a page filter of its own; DISABLED must hand it back
    // while the plain image gets the inline filter:none counter-projection that
    // overrides the stylesheet's !important blur.
    const styledImage = env.image()
    styledImage.style.setProperty('filter', 'grayscale(1)')
    const settings = { ...env.Policy.DEFAULTS, wordCoverEnabled: false, whitelistedSites: ['example.com/safe'], blacklistedSites: ['example.com/danger'] }
    env.storage.getWithDefaults = async () => settings
    await env.readAndApplySettings()
    // The harness Style rounds blur lengths the way Chromium serializes them, so
    // the filter read back differs from the string written; the controller must
    // still recognise it as its own projection when it restores page filters.
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
    // Each of these rewrites the inline filter over the page's sepia(1): a new
    // strength, a preview and its removal. Disabling must restore the original.
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
        // The page changes its filter underneath the blur. 'observed' delivers the
        // style record (with oldValue, as attributeOldValue provides) so
        // captureStyleMutation learns the new page value and re-asserts the blur;
        // 'queued' never delivers it, so the restore path must detect the foreign
        // value on its own instead of restoring the filter it last recorded.
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
    // No settings read has completed: applyCurrentUrlPolicy must return before
    // resolving a mode, or the DEFAULTS trigger list would be analysed against
    // (the review's CRITICAL finding). The constructor's fail-closed ALWAYS_BLUR
    // and the policy generation both stay untouched.
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
    // Navigation events re-resolve the mode from the settings already applied;
    // a storage read here would be a regression, so the fake makes one throw.
    env.storage.getWithDefaults = async () => { throw new Error('Unexpected storage read on navigation') }
    env.context.location.href = 'https://example.com/danger'
    env.window.dispatchEvent({ type: 'popstate' })
    assert.equal(env.controller.mode, 'ALWAYS_BLUR')
    env.context.location.href = 'https://example.com/safe'
    env.window.dispatchEvent({ type: 'popstate' })
    assert.equal(env.controller.mode, 'DISABLED')
})

// A page with 'spider' inside a <p> whose display the test controls through a
// stubbed getComputedStyle (the harness default reports everything displayed).
// Hidden text is not indexed, so the committed verdict starts clear and the
// image released; visible text starts blurred. setHidden flips the visibility
// without any DOM record, exactly as a stylesheet change would.
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
        // A record whose target is a <style> element counts as a stylesheet change.
        // Either direction leaves the verdict stale: a trigger appearing adds
        // vocabulary, one disappearing removes the matched word. Both re-analyse,
        // and the image is blurred while that is pending.
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
    // Count index rebuilds: the debounce must coalesce five records into one
    // pending 200 ms timer, and none may run inside the observer callback.
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
    // Visibility did not change, so the rebuilt index equals the old one and the
    // clear verdict, with the released image, stands.
    env.controller._handleMutations([{ type: 'childList', target: style, addedNodes: [], removedNodes: [] }])
    await env.runTimers(STYLESHEET_REINDEX_DEBOUNCE_MS)
    assert.equal(env.controller._analysisPending, false)
    assert.equal(env.image.style.getPropertyValue('filter'), 'none')
})

test('stylesheet load events reindex newly visible trigger text', async () => {
    const env = stylesheetVisibilityFixture(true)
    // A <link rel=stylesheet> finishing its load can change what is visible; the
    // controller listens for load on every link it has been told about.
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
    // CSSOM edits (insertRule) produce no mutation records, so sheets are
    // fingerprinted on an interval. The fake sheet has exactly the fields the
    // fingerprint reads; pushing a rule changes its rule count. The harness
    // never fires intervals, so the poll tick is invoked by hand.
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
    // The background rescan (a 0 ms timer) runs before the poll tick sees the
    // new rule. It must not refresh the stylesheet fingerprints as a side
    // effect, or the visibility change would never be indexed and the image
    // would stay released with a trigger on screen.
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
    // Media queries flip visibility with the viewport; resize goes through the
    // debounced rescan. The 200 below is RESIZE_DEBOUNCE_MS, which happens to
    // equal the stylesheet debounce.
    env.controller._attachMediaResourceListeners()
    env.setHidden(false)
    env.window.dispatchEvent({ type: 'resize' })
    await env.runTimers(200)
    assert.equal(env.controller._pageTextIndex.getTokenCount('spider'), 1)
    assert.equal(env.controller._analysisPending, true)
})

// A cross-origin iframe on a page with a committed clear verdict. Marking its
// navigation complete records the loaded fingerprint, so only a later src or
// srcdoc change can make it pending again. The lifecycle observer is picked by
// its attributeFilter; that works only because applyProtectionMode never runs
// here, as the main DOM observer created on enable lists 'sandbox' as well.
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
        // sandbox only affects future navigations and emits no load, so it must
        // not mark the frame pending. _setFrameAggregateClear(true) stands in for
        // a clear aggregate answer; production reaches that state through
        // _refreshFrameAggregate, which only ever calls the helper with false.
        env.mutate('sandbox')
        env.controller._setFrameAggregateClear(true)
        assert.equal(env.controller._pendingIframeNavigations.has(env.iframe), false)
        assert.equal(env.iframe.style.getPropertyValue('filter'), 'none')
    })
}

test('sandbox changes do not clear an actual pending iframe navigation', () => {
    const env = iframeLifecycleFixture()
    // A real navigation (src) is pending; the later sandbox change must not be
    // mistaken for its completion.
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
    // Replacing a <section> that holds the iframe with another holding a new one
    // keeps the owner count at one, so only the changed subtrees reveal it.
    const previousContainer = env.body.appendChild(env.document.createElement('section'))
    previousContainer.appendChild(env.iframe)
    env.controller._setFrameAggregateClear(true)

    const replacement = env.document.createElement('section')
    const newFrame = replacement.appendChild(new env.context.HTMLIFrameElement())
    newFrame.setAttribute('src', 'https://unknown.example/new')
    env.body.replaceChild(replacement, previousContainer)
    // Both observers receive the same record, as the browser would deliver it:
    // the lifecycle observer invalidates the aggregate, the main one registers
    // the new frame.
    const records = [{
        type: 'childList', target: env.body,
        addedNodes: [replacement], removedNodes: [previousContainer],
    }]
    env.controller._iframeLifecycleObserver.callback(records)
    env.controller._handleMutations(records)
    assert.match(newFrame.style.getPropertyValue('filter'), /^blur\(/, 'a replacement frame cannot inherit the previous clear verdict')

    // 100 ms is FRAME_AGGREGATE_REFRESH_DEBOUNCE_MS. The reply must echo the
    // request's epoch or the controller discards it; the setImmediate lets the
    // response chain settle before the filter is read.
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
    // <object> hosts a document the frame protocol cannot see. Its arrival must
    // re-blur the released iframe, the next request must report it, and the
    // worker's negative answer keeps the iframe blurred.
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
        // Alt+Shift+W with the body focused. Only a trusted (user-generated) event
        // is forwarded and consumed; a page script's synthetic event must not be
        // able to toggle word covers.
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
