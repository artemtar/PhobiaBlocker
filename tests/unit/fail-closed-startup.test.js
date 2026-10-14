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

// Records the subtree each shadow-root discovery walk starts from. Every such
// walk is a whole-subtree query, so the list is the work the handler does.
function recordDiscoveryWalks(env) {
    const walks = []
    const index = env.context.PhobiaBlockerPageTextIndex
    const collectDomRoots = index.collectDomRoots
    index.collectDomRoots = (subtree) => {
        walks.push(subtree)
        return collectDomRoots(subtree)
    }
    return walks
}

test('startup records walk each inserted subtree once and never the whole record target', () => {
    // Arrange: the parser streams a section, then a paragraph into it. Each
    // insertion is reported against its parent, which has no shadow root. The
    // startup handler is driven directly so the iframe lifecycle observer's
    // own queries do not count.
    const env = createContentHarness()
    const section = env.body.appendChild(env.document.createElement('section'))
    const paragraph = section.appendChild(env.document.createElement('p'))
    const walks = recordDiscoveryWalks(env)

    // Act
    env.controller._handleStartupMutations([childListRecord(env.body, section), childListRecord(section, paragraph)])

    // Assert: <body> is not walked per record and nested inserts are deduped.
    assert.deepEqual(walks, [section], 'only the outermost inserted subtree is walked, once')
})

test('a startup record whose target already hosts a shadow root still discovers that root', () => {
    // Arrange: a host attached its root before the record for its light-DOM
    // text arrives, so only the record target points at the root.
    const env = createContentHarness()
    const host = env.body.appendChild(env.document.createElement('div'))
    const root = host.attachShadow({ mode: 'open' })
    const text = host.appendChild(env.document.createTextNode('slotted'))

    // Act
    env.dispatchMutations([childListRecord(host, text)])

    // Assert
    assert.equal(root.adoptedStyleSheets.length, 1, 'the host target must still adopt the protection sheet')
    assert.equal(env.controller.protectionApplied, false)
})

// Streaming SSR: the parser yields right after a host's start tag, so the
// host's insertion record arrives with no shadow root, and the next chunk's
// <template shadowrootmode> creates the root without any record of its own
// (the template never enters the DOM). A plain host has no hyphen and no
// template child to give it away; only its position, as the element the
// parser still had open, does. Media inside such a root must be protected at
// the next record or the late check, not at the first settings application.

function shadowImage(env, root) {
    const image = root.appendChild(new env.context.HTMLImageElement())
    image.setAttribute('src', 'hero.jpg')
    return image
}

async function parserYieldsAfter(env, records) {
    env.dispatchMutations(records)
    await env.settle()
    await env.runTimers(0)
}

function assertSheetOnlyProtection(env, root, image) {
    assert.equal(root.adoptedStyleSheets.length, 1, 'the late declarative root must adopt the protection sheet')
    assert.equal(image.style.getPropertyValue('filter'), '', 'no default projection before settings')
    assert.equal(env.controller.protectionApplied, false)
}

test('a plain host split across a parser yield is protected at the record for its following sibling', async () => {
    // Arrange: <div class="hero"> ends one chunk; its record is delivered.
    const env = createContentHarness()
    const host = env.body.appendChild(env.document.createElement('div'))
    host.setAttribute('class', 'hero')
    await parserYieldsAfter(env, [childListRecord(env.body, host)])
    assert.ok(!host.shadowRoot, 'the next chunk has not arrived yet')

    // Act: the next chunk creates the root, renders into it, then the parser
    // closes the host and inserts a sibling, which is the only record it makes.
    const root = host.attachShadow({ mode: 'open' })
    const image = shadowImage(env, root)
    const sibling = env.body.appendChild(env.document.createElement('p'))
    env.dispatchMutations([childListRecord(env.body, sibling)])

    // Assert
    assertSheetOnlyProtection(env, root, image)
})

test('a plain host whose chunk ends in a comment node is still watched for a late declarative root', async () => {
    // Arrange: server-rendered markup often leaves a marker comment such as
    // <!--[--> as the last node before the parser yields inside the host.
    const env = createContentHarness()
    const host = env.body.appendChild(env.document.createElement('div'))
    host.setAttribute('class', 'hero')
    const marker = host.appendChild(env.document.createComment('['))
    await parserYieldsAfter(env, [childListRecord(env.body, host), childListRecord(host, marker)])
    assert.ok(!host.shadowRoot, 'the next chunk has not arrived yet')

    // Act: the root arrives with the next chunk; the parser then closes the
    // host and inserts a sibling.
    const root = host.attachShadow({ mode: 'open' })
    const image = shadowImage(env, root)
    const sibling = env.body.appendChild(env.document.createElement('p'))
    env.dispatchMutations([childListRecord(env.body, sibling)])

    // Assert
    assertSheetOnlyProtection(env, root, image)
})

test('a nested plain host split across a parser yield is protected at the next record', async () => {
    // Arrange: body <- section <- div.hero, all in one batch; the yield lands
    // right after the div's start tag, so it is the deepest open element.
    const env = createContentHarness()
    const section = env.body.appendChild(env.document.createElement('section'))
    const host = section.appendChild(env.document.createElement('div'))
    host.setAttribute('class', 'hero')
    await parserYieldsAfter(env, [childListRecord(env.body, section), childListRecord(section, host)])

    // Act: the root arrives with the next chunk; the parser then continues in
    // the section, where the host's sibling is the next record.
    const root = host.attachShadow({ mode: 'open' })
    const image = shadowImage(env, root)
    const sibling = section.appendChild(env.document.createElement('p'))
    env.dispatchMutations([childListRecord(section, sibling)])

    // Assert
    assertSheetOnlyProtection(env, root, image)
})

test('a custom element nested in an inserted ancestor is still watched for a late declarative root', async () => {
    // Arrange: body <- section <- my-el in one batch. The section is the only
    // minimal root of the batch; the host must still be remembered.
    const env = createContentHarness()
    const section = env.body.appendChild(env.document.createElement('section'))
    const host = section.appendChild(env.document.createElement('my-el'))
    await parserYieldsAfter(env, [childListRecord(env.body, section), childListRecord(section, host)])

    // Act
    const root = host.attachShadow({ mode: 'open' })
    const image = shadowImage(env, root)
    const sibling = section.appendChild(env.document.createElement('p'))
    env.dispatchMutations([childListRecord(section, sibling)])

    // Assert
    assertSheetOnlyProtection(env, root, image)
})

test('a plain host whose root is the last thing parsed is protected when parsing ends', async () => {
    // Arrange: the host's record is the last the parser produces before the
    // chunk that creates the root closes the document.
    const env = createContentHarness()
    const host = env.body.appendChild(env.document.createElement('div'))
    await parserYieldsAfter(env, [childListRecord(env.body, host)])

    // Act
    const root = host.attachShadow({ mode: 'open' })
    const image = shadowImage(env, root)
    env.document.readyState = 'interactive'
    env.document.dispatchEvent({ type: 'readystatechange' })

    // Assert
    assertSheetOnlyProtection(env, root, image)
})

test('a plain host whose root is parsed within the same task is protected by the follow-up check', async () => {
    // Arrange
    const env = createContentHarness()
    const host = env.body.appendChild(env.document.createElement('div'))
    env.dispatchMutations([childListRecord(env.body, host)])

    // Act: the parser continues before any other record is produced.
    const root = host.attachShadow({ mode: 'open' })
    const image = shadowImage(env, root)
    await env.runTimers(0)

    // Assert
    assertSheetOnlyProtection(env, root, image)
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
