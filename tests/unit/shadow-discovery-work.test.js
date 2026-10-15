// The fallback sweep for open shadow roots that neither the attachShadow notifier
// nor the declarative re-checks reported: it runs from the stylesheet poll in
// bounded slices. These tests measure how much of the page each slice touches and
// check that a root found late is protected and indexed without rebuilding the page.
const assert = require('node:assert/strict')
const test = require('node:test')
const { createContentHarness } = require('./helpers/content-harness')

// Mirrors SHADOW_DISCOVERY_YIELD_MS in js.js. It is the only 16 ms timer the
// controller arms, so a pending timer with this delay is a discovery continuation.
const DISCOVERY_YIELD_MS = 16

// `size` plain divs whose shadowRoot getter records the visit and advances a fake
// clock by `readCost` ms; performance.now reads that clock (the harness default is
// frozen), so the 4 ms time budget is consumed purely by shadowRoot reads.
// _startStylesheetPolling arms the interval that schedules discovery and poll()
// fires it; wholePageQueries counts document.querySelectorAll('*'), which a
// collectDomRoots sweep (or a full background scan, never run here) would issue.
function pollingFixture(size = 1000, readCost = 0) {
    const env = createContentHarness()
    const visited = []
    const elements = []
    let elapsed = 0
    for (let index = 0; index < size; index++) {
        const element = env.body.appendChild(env.document.createElement('div'))
        Object.defineProperty(element, 'shadowRoot', {
            configurable: true,
            get() {
                visited.push(element)
                elapsed += readCost
                return null
            },
        })
        elements.push(element)
    }
    env.context.performance.now = () => elapsed
    env.controller.mode = 'ALWAYS_BLUR'
    env.controller._startStylesheetPolling()
    let wholePageQueries = 0
    const querySelectorAll = env.document.querySelectorAll.bind(env.document)
    env.document.querySelectorAll = selector => {
        if (selector === '*') wholePageQueries++
        return querySelectorAll(selector)
    }
    const poll = () => [...env.intervals.values()].forEach(timer => timer.callback())
    const hasSlice = () => [...env.timers.values()].some(timer => timer.delay === DISCOVERY_YIELD_MS)
    return { ...env, elements, visited, poll, hasSlice, wholePageQueries: () => wholePageQueries }
}

// The interval callback only arms the first slice; every slice then visits at most
// SHADOW_DISCOVERY_NODE_BUDGET (250) elements. html, body and the 1000 divs take
// five slices, and a resumed walk must continue where it stopped.
test('ordinary polling yields between bounded discovery slices and resumes instead of restarting', async () => {
    const env = pollingFixture()
    env.poll()

    assert.equal(env.wholePageQueries(), 0, 'polling must not materialize every page element')
    assert.ok(env.visited.length <= 250, 'the polling task cannot inspect the whole page')
    assert.equal(env.hasSlice(), true, 'unfinished discovery must yield to a later task')

    for (let slice = 0; slice < 10 && env.hasSlice(); slice++) {
        const before = env.visited.length
        await env.runTimers(DISCOVERY_YIELD_MS)
        assert.ok(env.visited.length - before <= 250, 'each timer must bound its element work')
    }

    assert.equal(env.hasSlice(), false)
    assert.equal(new Set(env.visited).size, 1000, 'slices must eventually reach the end of the document')
    assert.equal(env.visited.length, 1000, 'resuming discovery must not revisit completed prefixes')
    assert.equal(env.wholePageQueries(), 0)
})

// Each shadowRoot read now costs 1 ms, so the 4 ms SHADOW_DISCOVERY_TIME_BUDGET_MS
// stops a slice after four elements, long before the 250-element limit.
test('slow discovery checks yield on the time budget before the element limit', async () => {
    const env = pollingFixture(1000, 1)
    env.poll()
    assert.ok(env.visited.length <= 4, 'one task must yield after four milliseconds of work')
    assert.equal(env.hasSlice(), true)

    const before = env.visited.length
    await env.runTimers(DISCOVERY_YIELD_MS)

    assert.ok(env.visited.length > before, 'the next task must make progress')
    assert.ok(env.visited.length - before <= 4, 'the resumed task must retain its time budget')
})

// A component that populated its root before discovery reached it (the host is the
// last element, so the walk takes several slices). The three controller assignments
// simulate a committed clear verdict in ANALYZE, so the test can see the new trigger
// text flip _analysisPending back to true: a clean page must not stay cleared once a
// trigger appears inside a late root.
test('fallback discovery initializes prepopulated shadow media and trigger text without rebuilding the page', async () => {
    const env = pollingFixture()
    const outside = env.body.appendChild(env.document.createElement('p'))
    outside.appendChild(env.document.createTextNode('ordinary text'))
    const settings = { ...env.Policy.DEFAULTS, targetWords: ['spider'], wordCoverEnabled: true }
    env.controller.mode = 'ANALYZE'
    env.controller._analysisPending = false
    env.controller._pageAnalysisResult = { shouldBlur: false, matchedWords: [], matchedInputWords: [] }
    env.controller.setSettings(settings)
    env.controller._wordCoverManager.configure(settings, 'ANALYZE')
    const index = env.controller._pageTextIndex
    index.build(env.body)
    const host = env.elements.at(-1)
    // The fixture's recording getter must go before attachShadow can assign the property.
    delete host.shadowRoot
    const root = host.attachShadow({ mode: 'open' })
    const paragraph = root.appendChild(env.document.createElement('p'))
    paragraph.appendChild(env.document.createTextNode('spider'))
    const image = root.appendChild(new env.context.HTMLImageElement())
    image.setAttribute('src', 'picture.jpg')
    let rebuilds = 0
    const build = index.build.bind(index)
    index.build = (...args) => { rebuilds++; return build(...args) }

    env.poll()
    for (let slice = 0; slice < 15 && env.hasSlice(); slice++) {
        await env.runTimers(DISCOVERY_YIELD_MS)
    }

    assert.equal(root.adoptedStyleSheets.length, 1)
    assert.match(image.style.getPropertyValue('filter'), /^blur\(/)
    assert.equal(paragraph.querySelector('.phobia-word-cover')?.textContent, 'spider')
    assert.equal(index.getTokenCount('spider'), 1)
    assert.equal(index.getTokenCount('ordinary'), 1)
    assert.equal(env.controller._analysisPending, true, 'new trigger text must invalidate a clean page verdict')
    assert.equal(rebuilds, 0, 'a newly discovered component must not rebuild the unrelated page text')

    // 200 ms is STYLESHEET_REINDEX_DEBOUNCE_MS: a fingerprint change on this poll
    // would rebuild the index then. The root was baselined when it was registered.
    env.poll()
    await env.runTimers(200)
    assert.equal(rebuilds, 0, 'the next stylesheet poll must not mistake a new root for a page stylesheet edit')
})

// A page stylesheet hides 'spider' (modelled by the paragraph's rects). While the
// discovery walk is paused between slices the page inserts a rule that shows it,
// which changes that sheet's fingerprint (rule count). Registering the root found
// afterwards must baseline only that root; snapshotting every sheet there would
// swallow the document edit and the text would stay out of the index.
test('a document stylesheet edit during shadow discovery still refreshes visible page text', async () => {
    const env = pollingFixture()
    const paragraph = env.body.appendChild(env.document.createElement('p'))
    paragraph.appendChild(env.document.createTextNode('spider'))
    let hidden = true
    paragraph.getClientRects = () => hidden ? [] : [{}]
    const sheet = new env.context.CSSStyleSheet()
    sheet.replaceSync('p { display: none }')
    env.document.styleSheets.push(sheet)
    // Re-armed so the baseline fingerprint includes the sheet just added.
    env.controller._startStylesheetPolling()
    const index = env.controller._pageTextIndex
    index.build(env.body)
    assert.equal(index.getTokenCount('spider'), 0)
    let rebuilds = 0
    const build = index.build.bind(index)
    index.build = (...args) => { rebuilds++; return build(...args) }
    const host = env.elements.at(-1)
    delete host.shadowRoot
    const root = host.attachShadow({ mode: 'open' })
    const componentText = root.appendChild(env.document.createElement('p'))
    componentText.appendChild(env.document.createTextNode('component'))

    env.poll()
    await env.runTimers(DISCOVERY_YIELD_MS)
    assert.equal(env.hasSlice(), true)
    hidden = false
    sheet.cssRules.push({ cssText: 'p { display: block }' })
    for (let slice = 0; slice < 15 && env.hasSlice(); slice++) {
        await env.runTimers(DISCOVERY_YIELD_MS)
    }
    assert.equal(index.getTokenCount('component'), 1)
    assert.equal(rebuilds, 0, 'root initialization must stay scoped before polling existing stylesheets')

    env.poll()
    await env.runTimers(200)

    assert.equal(rebuilds, 1, 'discovering a root must not acknowledge a concurrent document stylesheet edit')
    assert.equal(index.getTokenCount('spider'), 1)
})

// Ten elements, so discovery finishes in one slice. The baseline taken at
// registration must include the root's own styleSheets as they are then: the rule
// inserted afterwards changes that sheet's rule count, and the next poll must read
// the difference and re-index the text it reveals (the previous test pins the
// other side: no rebuild when nothing changed).
test('a stylesheet edit in a newly initialized root is detected on its next poll', async () => {
    const env = pollingFixture(10)
    const host = env.elements.at(-1)
    delete host.shadowRoot
    const root = host.attachShadow({ mode: 'open' })
    const paragraph = root.appendChild(env.document.createElement('p'))
    paragraph.appendChild(env.document.createTextNode('spider'))
    let hidden = true
    paragraph.getClientRects = () => hidden ? [] : [{}]
    const sheet = new env.context.CSSStyleSheet()
    sheet.replaceSync('p { display: none }')
    root.styleSheets.push(sheet)
    const index = env.controller._pageTextIndex
    let rebuilds = 0
    const build = index.build.bind(index)
    index.build = (...args) => { rebuilds++; return build(...args) }

    env.poll()
    for (let slice = 0; slice < 5 && env.hasSlice(); slice++) {
        await env.runTimers(DISCOVERY_YIELD_MS)
    }
    assert.equal(root.adoptedStyleSheets.length, 1)
    assert.equal(index.getTokenCount('spider'), 0)
    assert.equal(rebuilds, 0)
    hidden = false
    sheet.cssRules.push({ cssText: 'p { display: block }' })

    env.poll()
    await env.runTimers(200)

    assert.equal(rebuilds, 1, 'new roots need their own initial stylesheet snapshot before later edits')
    assert.equal(index.getTokenCount('spider'), 1)
})

// Shadow styles reach outside the root: :host can give the host a background and
// ::slotted rules can hide or show light-DOM children. Both are modelled as depending
// on host.shadowRoot existing. _initializeShadowRoot therefore reconciles the host
// subtree (register its background, re-index its light text), not just the root.
test('new shadow styles update host backgrounds and the visibility of light content without rebuilding the page', async () => {
    const env = pollingFixture(10)
    const host = env.elements.at(-1)
    const hiddenByShadow = host.appendChild(env.document.createElement('p'))
    hiddenByShadow.appendChild(env.document.createTextNode('spider'))
    const shownByShadow = host.appendChild(env.document.createElement('p'))
    shownByShadow.appendChild(env.document.createTextNode('snake'))
    hiddenByShadow.getClientRects = () => host.shadowRoot ? [] : [{}]
    shownByShadow.getClientRects = () => host.shadowRoot ? [{}] : []
    const getComputedStyle = env.context.getComputedStyle
    env.context.getComputedStyle = element => ({
        ...getComputedStyle(element),
        backgroundImage: element === host && host.shadowRoot ? 'url("host-picture.jpg")' : 'none',
    })
    const index = env.controller._pageTextIndex
    index.build(env.body)
    assert.equal(index.getTokenCount('spider'), 1)
    assert.equal(index.getTokenCount('snake'), 0)
    let rebuilds = 0
    const build = index.build.bind(index)
    index.build = (...args) => { rebuilds++; return build(...args) }
    delete host.shadowRoot
    const root = host.attachShadow({ mode: 'open' })
    const slot = root.appendChild(env.document.createElement('slot'))
    slot.assignedElements = () => [hiddenByShadow, shownByShadow]
    const sheet = new env.context.CSSStyleSheet()
    sheet.replaceSync(':host { background-image: url("host-picture.jpg") }')
    root.styleSheets.push(sheet)

    env.poll()
    for (let slice = 0; slice < 5 && env.hasSlice(); slice++) {
        await env.runTimers(DISCOVERY_YIELD_MS)
    }

    assert.match(host.style.getPropertyValue('filter'), /^blur\(/, 'a :host background must be protected on discovery')
    assert.equal(index.getTokenCount('spider'), 0, 'shadow styles can hide previously indexed light text')
    assert.equal(index.getTokenCount('snake'), 1, 'shadow styles can expose previously hidden slotted text')
    assert.equal(rebuilds, 0, 'the affected host subtree can be updated without rebuilding the document')
})

// Component libraries (Lit, FAST, Stencil) assign adoptedStyleSheets after attach,
// dropping the protection sheet. The poll must put it back for every known root
// while keeping the page's sheet, and without walking the page to find roots.
test('polling repairs protection CSS in a known shadow root without a whole-page discovery sweep', () => {
    const env = createContentHarness()
    const host = env.body.appendChild(env.document.createElement('div'))
    const root = host.attachShadow({ mode: 'open' })
    env.controller.mode = 'ALWAYS_BLUR'
    env.controller._discoverShadowRoots(host)
    const protectionSheet = root.adoptedStyleSheets[0]
    const pageSheet = new env.context.CSSStyleSheet()
    root.adoptedStyleSheets.push(pageSheet)
    env.controller._startStylesheetPolling()
    // The replacement a library's adoptStyles performs: our sheet is gone.
    root.adoptedStyleSheets = [pageSheet]
    let wholePageQueries = 0
    const querySelectorAll = env.document.querySelectorAll.bind(env.document)
    env.document.querySelectorAll = selector => {
        if (selector === '*') wholePageQueries++
        return querySelectorAll(selector)
    }

    for (const timer of env.intervals.values()) timer.callback()

    assert.ok(root.adoptedStyleSheets.includes(protectionSheet))
    assert.ok(root.adoptedStyleSheets.includes(pageSheet))
    assert.equal(wholePageQueries, 0)
})

// The paused TreeWalker's currentNode is the last element the slice visited. If the
// page removes it, a walker that kept going would traverse that detached subtree
// (which the page may keep growing; here 500 instrumented spans) and, with no path
// back to the root, never reach the rest of the document. The slice must detect the
// detached cursor, give up that walk, and the next poll must start a fresh one that
// reaches the host at the end.
test('removing a paused discovery cursor releases that walk and the next poll reaches later hosts', async () => {
    const env = pollingFixture()
    const host = env.elements.at(-1)
    delete host.shadowRoot
    const root = host.attachShadow({ mode: 'open' })
    const image = root.appendChild(new env.context.HTMLImageElement())
    env.poll()
    await env.runTimers(DISCOVERY_YIELD_MS)
    const cursor = env.visited.at(-1)
    assert.ok(cursor, 'the first slice must have traversed part of the page')
    assert.equal(env.hasSlice(), true)
    let detachedVisits = 0
    for (let index = 0; index < 500; index++) {
        const descendant = cursor.appendChild(env.document.createElement('span'))
        Object.defineProperty(descendant, 'shadowRoot', {
            get() { detachedVisits++; return null },
        })
    }
    env.body.removeChild(cursor)
    const before = env.visited.length

    await env.runTimers(DISCOVERY_YIELD_MS)

    assert.equal(env.hasSlice(), false, 'a detached cursor must not leave an endlessly pending walk')
    assert.equal(env.visited.length, before, 'the abandoned cursor must not retain scanning work')
    assert.equal(detachedVisits, 0, 'a removed cursor must not keep traversing its detached descendants')
    env.poll()
    for (let slice = 0; slice < 10 && env.hasSlice(); slice++) {
        await env.runTimers(DISCOVERY_YIELD_MS)
    }
    assert.equal(env.hasSlice(), false)
    assert.equal(root.adoptedStyleSheets.length, 1)
    assert.match(image.style.getPropertyValue('filter'), /^blur\(/)
})

// The MAIN-world notifier's event, with a committed clear verdict already in place
// (same simulation as above). The harness has no bubbling, so the event is dispatched
// on the document, where the controller listens in the capture phase; the controller
// reads only composedPath()[0] and then inspects the real DOM, never the event.
test('a shadow-root notification immediately initializes its media and trigger text', () => {
    const env = createContentHarness()
    const settings = { ...env.Policy.DEFAULTS, targetWords: ['spider'], wordCoverEnabled: true }
    env.controller.mode = 'ANALYZE'
    env.controller._analysisPending = false
    env.controller._pageAnalysisResult = { shouldBlur: false, matchedWords: [], matchedInputWords: [] }
    env.controller.setSettings(settings)
    env.controller._wordCoverManager.configure(settings, 'ANALYZE')
    const host = env.body.appendChild(env.document.createElement('div'))
    const root = host.attachShadow({ mode: 'open' })
    const paragraph = root.appendChild(env.document.createElement('p'))
    paragraph.appendChild(env.document.createTextNode('spider'))
    const image = root.appendChild(new env.context.HTMLImageElement())

    env.document.dispatchEvent({
        type: 'phobiablocker:shadow-root-attached',
        composedPath: () => [host, env.body, env.html, env.document],
    })

    assert.equal(root.adoptedStyleSheets.length, 1)
    assert.match(image.style.getPropertyValue('filter'), /^blur\(/)
    assert.equal(paragraph.querySelector('.phobia-word-cover')?.textContent, 'spider')
    assert.equal(env.controller._pageTextIndex.getTokenCount('spider'), 1)
    assert.equal(env.controller._analysisPending, true)
})

// The host was indexed before it had a root and no notification ever arrives (as
// with a declarative root). The only signal is a childList record on the host whose
// added node is text; the mutation path must notice the unknown root on the record's
// target, index it once, and still index the text that produced the record.
test('a text-only host mutation initializes an unnotified prepopulated shadow root', () => {
    const env = createContentHarness()
    const settings = { ...env.Policy.DEFAULTS, targetWords: ['spider'], wordCoverEnabled: true }
    env.controller.mode = 'ANALYZE'
    env.controller._analysisPending = false
    env.controller._pageAnalysisResult = { shouldBlur: false, matchedWords: [], matchedInputWords: [] }
    env.controller.setSettings(settings)
    env.controller._wordCoverManager.configure(settings, 'ANALYZE')
    const host = env.body.appendChild(env.document.createElement('div'))
    const index = env.controller._pageTextIndex
    index.build(env.body)
    const root = host.attachShadow({ mode: 'open' })
    const paragraph = root.appendChild(env.document.createElement('p'))
    paragraph.appendChild(env.document.createTextNode('spider'))
    const image = root.appendChild(new env.context.HTMLImageElement())
    const text = host.appendChild(env.document.createTextNode('ordinary text'))

    env.controller._handleMutations([{
        type: 'childList', target: host, addedNodes: [text], removedNodes: [],
    }])

    assert.equal(root.adoptedStyleSheets.length, 1)
    assert.equal(index.getTokenCount('ordinary'), 1, 'the text that caused discovery must still be indexed')
    assert.equal(index.getTokenCount('spider'), 1, 'a discovered root must be indexed before it becomes known')
    assert.match(image.style.getPropertyValue('filter'), /^blur\(/)
    assert.equal(paragraph.querySelector('.phobia-word-cover')?.textContent, 'spider')
    assert.equal(env.controller._analysisPending, true)
})

// Both paths run _cancelShadowDiscovery: cancelPendingAnalysis directly, and
// applyProtectionMode through cancelPendingAnalysis and disableProtection. The
// settings passed with DISABLED only keep them consistent with the explicit mode.
for (const action of ['cancel', 'disable']) {
    test(`${action} stops a pending discovery walk`, async () => {
        const env = pollingFixture()
        env.poll()
        assert.equal(env.hasSlice(), true, 'the fixture must have an unfinished walk')

        if (action === 'cancel') env.controller.cancelPendingAnalysis()
        else await env.controller.applyProtectionMode('DISABLED', {
            ...env.Policy.DEFAULTS, phobiaBlockerEnabled: false,
        })
        const before = env.visited.length
        await env.runTimers(DISCOVERY_YIELD_MS)

        assert.equal(env.hasSlice(), false)
        assert.equal(env.visited.length, before, 'cancelled work must not keep inspecting page elements')
    })
}
