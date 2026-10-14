const assert = require('node:assert/strict')
const test = require('node:test')
const { createContentHarness } = require('./helpers/content-harness')

const clean = { shouldBlur: false, matchedWords: [], matchedInputWords: [] }
const FRAME_MESSAGE_TYPES = ['PB_FRAME_AGGREGATE_REQUEST', 'PB_FRAME_STATUS_CHANGED']

// A page with a committed clear verdict, trigger word 'spider' and word
// covers on, so any newly protected content is observable at once.
function clearedPageFixture() {
    const env = createContentHarness()
    const settings = { ...env.Policy.DEFAULTS, targetWords: ['spider'], wordCoverEnabled: true }
    env.controller.mode = 'ANALYZE'
    env.controller.protectionApplied = true
    env.controller._analysisPending = false
    env.controller._pageAnalysisResult = clean
    env.controller.setSettings(settings)
    env.controller._wordCoverManager.configure(settings, 'ANALYZE')
    env.controller._pageTextIndex.build(env.body)
    return env
}

function notifyShadowRoot(env, host) {
    env.document.dispatchEvent({
        type: 'phobiablocker:shadow-root-attached',
        composedPath: () => [host, env.body, env.html, env.document],
    })
}

function renderComponent(env, root) {
    const paragraph = root.appendChild(env.document.createElement('p'))
    paragraph.appendChild(env.document.createTextNode('spider'))
    const image = root.appendChild(new env.context.HTMLImageElement())
    image.setAttribute('src', 'picture.jpg')
    return { paragraph, image }
}

function assertProtected(root, paragraph, image, protectionSheet = null) {
    const sheet = protectionSheet || root.adoptedStyleSheets[0]
    assert.ok(sheet, 'the root must have adopted the protection sheet')
    assert.ok(root.adoptedStyleSheets.includes(sheet), 'the protection sheet must be adopted by the root')
    assert.match(image.style.getPropertyValue('filter'), /^blur\(/, 'shadow media must be blurred')
    assert.equal(paragraph.querySelector('.phobia-word-cover')?.textContent, 'spider', 'the trigger word must be covered')
}

// Finding 9: a component that replaces adoptedStyleSheets after attachShadow
// (Lit adoptStyles, FAST, Stencil) must not leave its covers unstyled until
// the stylesheet poll.

for (const target of ['the shadow root', 'an element inside the root']) {
    test(`content rendered under ${target} re-adopts a dropped protection sheet before covers are created`, () => {
        const env = clearedPageFixture()
        const host = env.body.appendChild(env.document.createElement('my-card'))
        const root = host.attachShadow({ mode: 'open' })
        notifyShadowRoot(env, host)
        const protectionSheet = root.adoptedStyleSheets[0]
        assert.ok(protectionSheet, 'the notification must adopt the protection sheet')
        const componentSheet = new env.context.CSSStyleSheet()
        root.adoptedStyleSheets = [componentSheet]
        const container = target === 'the shadow root' ? root : root.appendChild(env.document.createElement('div'))
        const { paragraph, image } = renderComponent(env, container)

        env.controller._handleMutations([{
            type: 'childList', target: container, addedNodes: [paragraph, image], removedNodes: [],
        }])

        assertProtected(root, paragraph, image, protectionSheet)
        assert.ok(root.adoptedStyleSheets.includes(componentSheet), 'the component sheet must be kept')
        assert.equal(env.controller._analysisPending, true, 'new trigger text must invalidate the clean verdict')
    })
}

test('a text edit inside a root whose sheets were replaced re-adopts the protection sheet', () => {
    const env = clearedPageFixture()
    const host = env.body.appendChild(env.document.createElement('my-card'))
    const root = host.attachShadow({ mode: 'open' })
    const paragraph = root.appendChild(env.document.createElement('p'))
    const text = paragraph.appendChild(env.document.createTextNode('ordinary'))
    notifyShadowRoot(env, host)
    const protectionSheet = root.adoptedStyleSheets[0]
    root.adoptedStyleSheets = [new env.context.CSSStyleSheet()]

    text.nodeValue = 'spider'
    env.controller._handleMutations([{ type: 'characterData', target: text }])

    assert.ok(root.adoptedStyleSheets.includes(protectionSheet))
    assert.equal(paragraph.querySelector('.phobia-word-cover')?.textContent, 'spider')
})

// Finding 10: a declarative shadow root is parsed without attachShadow. When
// the host's insertion record arrives before the parser reaches the template,
// the root must still be found without waiting for the stylesheet poll.

test('a custom element whose declarative root is parsed after its insertion is protected after a microtask', async () => {
    const env = clearedPageFixture()
    const hero = env.body.appendChild(env.document.createElement('x-hero'))
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [hero], removedNodes: [] }])
    assert.ok(!hero.shadowRoot, 'the parser has not reached the template yet')

    const root = hero.attachShadow({ mode: 'open' })
    const { paragraph, image } = renderComponent(env, root)
    await env.settle()

    assertProtected(root, paragraph, image)
    assert.equal(env.controller._pageTextIndex.getTokenCount('spider'), 1)
    assert.equal(env.controller._analysisPending, true)
})

test('a custom element whose declarative root appears after the microtask is protected by the follow-up task', async () => {
    const env = clearedPageFixture()
    const hero = env.body.appendChild(env.document.createElement('x-hero'))
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [hero], removedNodes: [] }])
    await env.settle()

    const root = hero.attachShadow({ mode: 'open' })
    const { paragraph, image } = renderComponent(env, root)
    await env.runTimers(0)

    assertProtected(root, paragraph, image)
    assert.equal(env.controller._analysisPending, true)
})

test('an element carrying a declarative shadow template is re-checked once the root is created', async () => {
    const env = clearedPageFixture()
    const host = env.body.appendChild(env.document.createElement('div'))
    host.appendChild(env.document.createElement('template')).setAttribute('shadowrootmode', 'open')
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [host], removedNodes: [] }])

    const root = host.attachShadow({ mode: 'open' })
    const { paragraph, image } = renderComponent(env, root)
    await env.settle()
    await env.runTimers(0)

    assertProtected(root, paragraph, image)
})

// A streaming page: the host's start tag ends one network chunk and the
// declarative template arrives with the next one, after the microtask and the
// follow-up task have both looked. The template never enters the DOM, so the
// only record the parser produces afterwards is for the sibling that follows.
function heroRecord(env, hero) {
    return { type: 'childList', target: env.body, addedNodes: [hero], removedNodes: [] }
}

async function heroWithLateChunk(env, deliver) {
    const hero = env.body.appendChild(env.document.createElement('x-hero'))
    deliver([heroRecord(env, hero)])
    await env.settle()
    await env.runTimers(0)
    assert.ok(!hero.shadowRoot, 'the next chunk has not arrived yet')
    const root = hero.attachShadow({ mode: 'open' })
    const rendered = renderComponent(env, root)
    const sibling = env.body.appendChild(env.document.createElement('p'))
    sibling.appendChild(env.document.createTextNode('after'))
    return { hero, root, sibling, ...rendered }
}

test('a declarative root created by a later network chunk is protected at the next mutation batch', async () => {
    const env = clearedPageFixture()
    const { root, sibling, paragraph, image } = await heroWithLateChunk(env, records => env.controller._handleMutations(records))

    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [sibling], removedNodes: [] }])

    assertProtected(root, paragraph, image)
    assert.equal(env.controller._pageTextIndex.getTokenCount('spider'), 1)
    assert.equal(env.controller._analysisPending, true)
})

test('a declarative root that closes the document is protected when parsing ends', async () => {
    const env = clearedPageFixture()
    const { root, paragraph, image } = await heroWithLateChunk(env, records => env.controller._handleMutations(records))

    env.document.readyState = 'interactive'
    env.document.dispatchEvent({ type: 'readystatechange' })

    assertProtected(root, paragraph, image)
    assert.equal(env.controller._pageTextIndex.getTokenCount('spider'), 1)
})

test('before the settings read, a declarative root from a later chunk adopts the protection sheet at the next batch', async () => {
    const env = createContentHarness()
    const { root, sibling } = await heroWithLateChunk(env, records => env.dispatchMutations(records))

    env.dispatchMutations([{ type: 'childList', target: env.body, addedNodes: [sibling], removedNodes: [] }])

    assert.equal(env.controller.protectionApplied, false)
    assert.ok(root.adoptedStyleSheets.length > 0, 'the root must adopt the protection sheet before settings arrive')
})

test('once parsing has ended, a host without a root is not re-inspected by later batches', async () => {
    const env = clearedPageFixture()
    env.document.readyState = 'complete'
    const host = env.body.appendChild(env.document.createElement('x-late'))
    let reads = 0
    Object.defineProperty(host, 'shadowRoot', { get() { reads++; return undefined } })
    env.controller._handleMutations([heroRecord(env, host)])
    await env.settle()
    await env.runTimers(0)
    const readsAfterChecks = reads

    const sibling = env.body.appendChild(env.document.createElement('p'))
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [sibling], removedNodes: [] }])

    assert.equal(reads, readsAfterChecks, 'the parser cannot add a declarative root after parsing')
})

// Startup race: the startup observer sees the host before settings arrive, the
// settings read lands and applyProtectionMode indexes a page without the root,
// then the parser creates the root. The deferred check must initialise it,
// not merely register it; the discovery poll skips registered roots.
test('a declarative root parsed after the settings read is initialised by the startup re-check', async () => {
    const env = createContentHarness()
    const hero = env.body.appendChild(env.document.createElement('x-hero'))
    env.dispatchMutations([heroRecord(env, hero)])
    await env.settle()
    env.storage.getWithDefaults = async () => ({ ...env.Policy.DEFAULTS, targetWords: ['spider'], wordCoverEnabled: true })
    env.document.readyState = 'complete'
    await env.readAndApplySettings()
    await env.settle()
    assert.equal(env.controller.protectionApplied, true)
    assert.ok(!hero.shadowRoot, 'the parser has not reached the template yet')

    const root = hero.attachShadow({ mode: 'open' })
    const { paragraph, image } = renderComponent(env, root)
    await env.runTimers(0)

    assertProtected(root, paragraph, image)
    assert.ok(env.controller._registry.get(image), 'late shadow media must be registered, not left to the sheet alone')
    assert.equal(env.controller._pageTextIndex.getTokenCount('spider'), 1)
    assert.equal(env.controller._analysisPending, true)
})

// Finding 9, startup window: until the settings read resolves the adopted
// sheet is the only protection inside a root, so a component that dropped it
// before rendering must get it back from the startup observer.
test('before the settings read, content rendered into a root that dropped its sheet re-adopts it', () => {
    const env = createContentHarness()
    const host = env.body.appendChild(env.document.createElement('my-card'))
    const root = host.attachShadow({ mode: 'open' })
    notifyShadowRoot(env, host)
    const protectionSheet = root.adoptedStyleSheets[0]
    assert.ok(protectionSheet, 'the notification must adopt the protection sheet')
    root.adoptedStyleSheets = [new env.context.CSSStyleSheet()]
    const image = root.appendChild(new env.context.HTMLImageElement())
    image.setAttribute('src', 'picture.jpg')

    env.dispatchMutations([{ type: 'childList', target: root, addedNodes: [image], removedNodes: [] }], root)

    assert.equal(env.controller.protectionApplied, false)
    assert.ok(root.adoptedStyleSheets.includes(protectionSheet), 'the startup observer must re-adopt the dropped sheet')
})

test('ordinary inserted elements are not re-inspected for shadow roots later', async () => {
    const env = clearedPageFixture()
    const plain = env.body.appendChild(env.document.createElement('div'))
    let reads = 0
    Object.defineProperty(plain, 'shadowRoot', { get() { reads++; return undefined } })
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [plain], removedNodes: [] }])
    const synchronousReads = reads

    await env.settle()
    await env.runTimers(0)

    assert.equal(reads, synchronousReads, 'a plain element must not be scheduled for a late shadow-root check')
})

// Finding 11: attaching or pruning a shadow root without frame owners is not a
// frame-topology change; a released cross-origin iframe must stay released
// and the service worker must not be asked again.

function releasedIframeFixture() {
    const env = clearedPageFixture()
    env.window.top = {}
    const iframe = env.body.appendChild(new env.context.HTMLIFrameElement())
    iframe.setAttribute('src', 'https://other.example/frame')
    env.controller._registerMedia(env.document)
    env.controller._markIframeNavigationComplete(iframe)
    env.controller._setFrameAggregateClear(true)
    assert.equal(iframe.style.getPropertyValue('filter'), 'none', 'the fixture starts from a released iframe')
    const messages = []
    env.context.chrome.runtime.sendMessage = async message => {
        if (FRAME_MESSAGE_TYPES.includes(message.type)) messages.push(message)
        return { ok: true, clear: true, epoch: message.epoch }
    }
    return { ...env, iframe, messages }
}

test('an empty shadow root attachment leaves a released iframe alone and sends no frame messages', async () => {
    const env = releasedIframeFixture()
    const host = env.body.appendChild(env.document.createElement('my-widget'))
    host.attachShadow({ mode: 'open' })

    notifyShadowRoot(env, host)
    assert.equal(env.iframe.style.getPropertyValue('filter'), 'none')
    await env.runTimers(100)

    assert.equal(env.iframe.style.getPropertyValue('filter'), 'none')
    assert.deepEqual(env.messages, [])
})

test('a shadow root that contains a frame owner still invalidates the released aggregate', async () => {
    const env = releasedIframeFixture()
    const host = env.body.appendChild(env.document.createElement('my-embed'))
    const root = host.attachShadow({ mode: 'open' })
    const nested = root.appendChild(new env.context.HTMLIFrameElement())
    nested.setAttribute('src', 'https://chat.example/live')

    notifyShadowRoot(env, host)

    assert.match(env.iframe.style.getPropertyValue('filter'), /^blur\(/, 'a new frame owner revokes the aggregate')
    assert.match(nested.style.getPropertyValue('filter'), /^blur\(/)
    await env.runTimers(100)
    assert.ok(env.messages.some(message => message.type === 'PB_FRAME_AGGREGATE_REQUEST'),
        'the parent must ask the service worker about the new frame')
})

test('pruning an empty shadow root leaves a released iframe alone and sends no frame messages', async () => {
    const env = releasedIframeFixture()
    const host = env.body.appendChild(env.document.createElement('my-widget'))
    host.attachShadow({ mode: 'open' })
    notifyShadowRoot(env, host)
    env.messages.length = 0
    env.body.removeChild(host)

    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [], removedNodes: [host] }])
    await env.runTimers(100)

    assert.equal(env.iframe.style.getPropertyValue('filter'), 'none')
    assert.deepEqual(env.messages, [])
})
