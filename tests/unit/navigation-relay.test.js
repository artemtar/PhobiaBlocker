// Service worker frame coordination: same-document URL relays (PB_URL_CHANGED),
// their acknowledgement tracking and retries, ancestor invalidation, and the
// PB_FRAME_AGGREGATE_REQUEST answer including per-child clearance tokens. The
// invariant: a parent may release a cross-origin iframe only on proof from the
// browser's own frame tree; every doubt answers clear:false and no tokens.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const repositoryRoot = path.resolve(__dirname, '../..')
// JSON round trips keep recorded messages independent of later mutations.
// setImmediate runs after all pending microtasks, so one settle() lets a whole
// message -> promise -> invalidation chain finish before the next assertion.
const clone = value => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(resolve => setImmediate(resolve))

// Minimal chrome.events.Event: the suite emits into the listeners the worker
// registered while loading.
function browserEvent() {
    const listeners = []
    return {
        addListener(listener) { listeners.push(listener) },
        emit(...args) { listeners.forEach(listener => listener(...args)) },
    }
}

// Default authenticated frame tree: a three-level chain, each level on another
// origin. frameId, parentFrameId, documentId, documentLifecycle and url are the
// fields the worker reads from webNavigation.getAllFrames.
const frameTree = [
    { frameId: 0, parentFrameId: -1, documentId: 'main', documentLifecycle: 'active', url: 'https://example.com/' },
    { frameId: 2, parentFrameId: 0, documentId: 'middle', documentLifecycle: 'active', url: 'https://frame.example.com/' },
    { frameId: 9, parentFrameId: 2, documentId: 'child', documentLifecycle: 'active', url: 'https://child.example.com/restricted' },
]

// Runs the real background.js (importScripts pulls in its shared scripts) inside
// node:vm against a fake Chrome. Messages to tabs are recorded; onSend lets a
// test answer or fail specific message types, and anything it leaves undefined
// falls through to the defaults below.
function loadBackground({ onSend, frameData = frameTree } = {}) {
    const messages = []
    // A mutable copy a test can edit between calls to model a replaced document
    // or a new sibling; getAllFrames hands out a fresh clone each time, so the
    // worker's before/after snapshots are independent objects.
    const frames = clone(frameData)
    // A manual clock: timers fire only through advanceTime, so the 250 ms URL
    // retry and the 1500 ms frame-message timeout are under the test's control.
    const timers = new Map()
    let clock = 0
    let nextTimerId = 0
    const navigation = Object.fromEntries([
        'onBeforeNavigate', 'onCommitted', 'onErrorOccurred',
        'onHistoryStateUpdated', 'onReferenceFragmentUpdated',
    ].map(name => [name, browserEvent()]))
    const runtime = {
        lastError: null,
        onInstalled: browserEvent(),
        onMessage: browserEvent(),
        getURL: value => `chrome-extension://test/${value}`,
    }
    const chrome = {
        runtime,
        webNavigation: {
            ...navigation,
            getAllFrames({ tabId }, callback) {
                // The worker must derive the tab from the authenticated sender.
                assert.equal(tabId, 42)
                callback(clone(frames))
            },
        },
        storage: {
            onChanged: browserEvent(),
            // Serves the startup target-word and debugMode reads; neither matters here.
            sync: { get(keys, callback) { callback({ targetWords: ['spider'] }) } },
        },
        tabs: {
            onRemoved: browserEvent(),
            sendMessage(tabId, message, options) {
                messages.push(clone({ tabId, message, options }))
                if (onSend) {
                    const response = onSend(message, options)
                    if (response !== undefined) return response
                }
                // Every reachable frame reports clear by default, with an owner count
                // that matches the frame tree so subtreeIsClear accepts it.
                if (message.type === 'PB_FRAME_STATUS_REQUEST') {
                    return Promise.resolve({
                        allowsUnblur: true,
                        frameElementCount: frames.filter(frame => frame.parentFrameId === options.frameId).length,
                        hasUnsupportedFrameOwner: false,
                    })
                }
                return Promise.resolve({ ok: true })
            },
        },
        contextMenus: { onClicked: browserEvent() },
        commands: { onCommand: browserEvent() },
    }
    let context
    const runScript = filename => vm.runInContext(
        fs.readFileSync(path.join(repositoryRoot, 'js', filename), 'utf8'),
        context,
        { filename }
    )
    context = vm.createContext({
        chrome,
        console,
        crypto: require('node:crypto').webcrypto,
        URL,
        setTimeout(callback, delay) {
            const id = ++nextTimerId
            timers.set(id, { callback, deadline: clock + delay })
            return id
        },
        clearTimeout(id) { timers.delete(id) },
        importScripts(...files) { files.forEach(runScript) },
        // Icon loading is unrelated to navigation and never reaches a network.
        fetch: async () => { throw new Error('Icon rendering is unavailable in Node') },
    })
    runScript('background.js')

    return {
        messages,
        frames,
        emit(name, details) { navigation[name].emit(details) },
        // Fires due timers in deadline order, settling after each so a timer's
        // promise chain completes before the next one runs.
        async advanceTime(milliseconds) {
            const deadline = clock + milliseconds
            while (true) {
                const next = [...timers.entries()].sort((left, right) => left[1].deadline - right[1].deadline)[0]
                if (!next || next[1].deadline > deadline) break
                clock = next[1].deadline
                timers.delete(next[0])
                next[1].callback()
                await settle()
            }
            clock = deadline
            await settle()
        },
        // A PB_FRAME_AGGREGATE_REQUEST from the top document; the sender identity
        // is what the worker trusts. epoch 3 is arbitrary and must be echoed back.
        // frameElementCount 1 matches the single iframe the default tree gives the
        // main document. Without individualClearance the legacy reply shape applies.
        aggregate(overrides = {}) {
            return new Promise(resolve => runtime.onMessage.emit({
                target: 'background',
                type: 'PB_FRAME_AGGREGATE_REQUEST',
                epoch: 3,
                frameElementCount: 1,
                hasUnsupportedFrameOwner: false,
                ...overrides,
            }, { tab: { id: 42 }, frameId: 0, documentId: 'main' }, value => resolve(clone(value))))
        },
    }
}

// A valid webNavigation details object for the top document; overrides turn it
// into a subframe event or an invalid one.
function navigationDetails(overrides = {}) {
    return {
        tabId: 42,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'main',
        documentLifecycle: 'active',
        url: 'https://example.com/gallery#photo',
        ...overrides,
    }
}

for (const event of ['onHistoryStateUpdated', 'onReferenceFragmentUpdated']) {
    test(`${event} relays the URL only to the authenticated frame and document`, async () => {
        const background = loadBackground()
        background.emit(event, navigationDetails())
        await settle()
        assert.deepEqual(background.messages, [{
            tabId: 42,
            message: { target: 'content', type: 'PB_URL_CHANGED', url: 'https://example.com/gallery#photo' },
            options: { frameId: 0, documentId: 'main' },
        }])
    })
}

test('a failed top-level URL notification recovers automatically without an aggregate request', async () => {
    let available = false
    const background = loadBackground({
        onSend: message => message.type === 'PB_URL_CHANGED'
            ? available ? Promise.resolve({ ok: true }) : Promise.reject(new Error('Listener unavailable'))
            : undefined,
    })
    background.frames.splice(1)
    background.emit('onHistoryStateUpdated', navigationDetails())
    await settle()
    assert.equal(background.messages.length, 1)

    available = true
    // The single automatic retry is due at 250 ms (URL_POLICY_RETRY_DELAY_MS).
    await background.advanceTime(1000)
    assert.deepEqual(background.messages, [0, 1].map(() => ({
        tabId: 42,
        message: { target: 'content', type: 'PB_URL_CHANGED', url: 'https://example.com/gallery#photo' },
        options: { frameId: 0, documentId: 'main' },
    })))
    await background.advanceTime(10000)
    assert.equal(background.messages.length, 2, 'successful delivery should stop automatic retries')
})

test('a permanently unavailable top-level document receives only one automatic retry', async () => {
    // A null reply is anything but ok:true: no listener in the document, or an
    // empty answer. It never counts as an acknowledgement.
    const background = loadBackground({
        onSend: message => message.type === 'PB_URL_CHANGED' ? Promise.resolve(null) : undefined,
    })
    background.emit('onHistoryStateUpdated', navigationDetails())
    await settle()
    await background.advanceTime(10000)
    assert.equal(background.messages.length, 2)
    await background.advanceTime(10000)
    assert.equal(background.messages.length, 2)
})

test('automatic recovery retries only the newest URL notification', async () => {
    let available = false
    const background = loadBackground({
        onSend: message => message.type === 'PB_URL_CHANGED' ? Promise.resolve({ ok: available }) : undefined,
    })
    background.emit('onHistoryStateUpdated', navigationDetails({ url: 'https://example.com/old' }))
    await settle()
    background.emit('onHistoryStateUpdated', navigationDetails({ url: 'https://example.com/latest' }))
    await settle()
    available = true
    // Both relays failed; only the newest entry for the frame is still tracked,
    // so the old URL is never re-sent.
    await background.advanceTime(1000)
    assert.deepEqual(background.messages.map(({ message }) => message.url), [
        'https://example.com/old', 'https://example.com/latest', 'https://example.com/latest',
    ])
})

test('automatic recovery does not duplicate an in-flight aggregate retry', async () => {
    let attempts = 0
    let acknowledge
    const background = loadBackground({
        onSend: message => {
            if (message.type !== 'PB_URL_CHANGED') return undefined
            if (attempts++ === 0) return Promise.resolve(null)
            return new Promise(resolve => { acknowledge = resolve })
        },
    })
    background.emit('onHistoryStateUpdated', navigationDetails({ frameId: 9, parentFrameId: 2, documentId: 'child' }))
    await settle()
    // The aggregate's own retry (attempt 2) is in flight when the automatic
    // 250 ms retry fires; it must reuse the in-flight promise, not send a third
    // copy. advanceTime(1000) stays below the 1500 ms frame-message timeout, so
    // the held reply is not timed out by the clock; the aggregate waits for it.
    const aggregate = background.aggregate()
    await settle()
    await background.advanceTime(1000)
    assert.equal(attempts, 2)
    acknowledge({ ok: true })
    assert.deepEqual(await aggregate, { ok: true, clear: true, epoch: 3 })
    await background.advanceTime(10000)
    assert.equal(attempts, 2)
})

test('child URL changes invalidate every ancestor before and after policy application', async () => {
    let applyPolicy
    const background = loadBackground({
        onSend: message => message.type === 'PB_URL_CHANGED'
            ? new Promise(resolve => { applyPolicy = resolve }) : undefined,
    })
    background.emit('onHistoryStateUpdated', navigationDetails({
        frameId: 9, parentFrameId: 2, documentId: 'child', url: 'https://child.example.com/restricted',
    }))
    await settle()
    const notifications = () => background.messages
        .filter(({ message }) => message.type === 'PB_FRAME_AGGREGATE_INVALIDATED')
    // Before the child applies its new URL policy both ancestors are told to drop
    // their aggregates, nearest first, and an aggregate asked now is not clear.
    assert.deepEqual(notifications().map(({ tabId, options }) => ({ tabId, ...options })), [
        { tabId: 42, frameId: 2, documentId: 'middle' },
        { tabId: 42, frameId: 0, documentId: 'main' },
    ])
    assert.deepEqual(background.messages.find(({ message }) => message.type === 'PB_URL_CHANGED'), {
        tabId: 42,
        message: { target: 'content', type: 'PB_URL_CHANGED', url: 'https://child.example.com/restricted' },
        options: { frameId: 9, documentId: 'child' },
    })
    assert.deepEqual(await background.aggregate(), { ok: true, clear: false, epoch: 3 })

    // The acknowledgement invalidates the ancestors a second time: the child may
    // have re-blurred or released under its new policy.
    applyPolicy({ ok: true })
    await settle()
    assert.deepEqual(notifications().slice(2).map(({ options }) => options), [
        { frameId: 2, documentId: 'middle' },
        { frameId: 0, documentId: 'main' },
    ])
    assert.deepEqual(await background.aggregate(), { ok: true, clear: true, epoch: 3 })
})

test('overlapping child URL relays stay conservative until both policy responses arrive', async () => {
    const pending = []
    const background = loadBackground({
        onSend: message => message.type === 'PB_URL_CHANGED'
            ? new Promise(resolve => pending.push(resolve)) : undefined,
    })
    const details = navigationDetails({ frameId: 9, parentFrameId: 2, documentId: 'child' })
    background.emit('onHistoryStateUpdated', details)
    background.emit('onReferenceFragmentUpdated', details)
    await settle()
    assert.equal(pending.length, 2)
    // The second relay replaced the first as the frame's tracked entry, so the
    // first acknowledgement confirms nothing.
    pending[0]({ ok: true })
    await settle()
    assert.deepEqual(await background.aggregate(), { ok: true, clear: false, epoch: 3 })
    pending[1]({ ok: true })
    await settle()
    assert.deepEqual(await background.aggregate(), { ok: true, clear: true, epoch: 3 })
})

for (const failure of ['missing acknowledgement', 'negative acknowledgement', 'delivery rejection']) {
    test(`${failure} stays conservative and recovers through a later aggregate retry`, async () => {
        let fail = true
        const background = loadBackground({
            onSend: message => {
                if (message.type !== 'PB_URL_CHANGED') return undefined
                if (!fail) return Promise.resolve({ ok: true })
                if (failure === 'delivery rejection') return Promise.reject(new Error('Document no longer listens'))
                return Promise.resolve(failure === 'negative acknowledgement' ? { ok: false } : undefined)
            },
        })
        const details = navigationDetails({ frameId: 9, parentFrameId: 2, documentId: 'child' })
        background.emit('onHistoryStateUpdated', details)
        await settle()
        // The first send fails and arms the automatic 250 ms retry, but the clock
        // never advances in this test: the only retries are the single bounded
        // attempt each aggregate request makes for a still-unconfirmed relay.
        assert.deepEqual(await background.aggregate(), { ok: true, clear: false, epoch: 3 })
        assert.equal(background.messages.filter(({ message }) => message.type === 'PB_URL_CHANGED').length, 2,
            'one aggregate check should retry the failed URL notification only once')

        fail = false
        assert.deepEqual(await background.aggregate(), { ok: true, clear: true, epoch: 3 })
        assert.equal(background.messages.filter(({ message }) => message.type === 'PB_URL_CHANGED').length, 3)
    })
}

test('an old acknowledgement cannot clear a newer failed URL notification', async () => {
    const pending = []
    let retrySucceeds = false
    let attempts = 0
    const background = loadBackground({
        onSend: message => {
            if (message.type !== 'PB_URL_CHANGED') return undefined
            if (attempts++ < 2) return new Promise(resolve => pending.push(resolve))
            return Promise.resolve({ ok: retrySucceeds })
        },
    })
    const details = navigationDetails({ frameId: 9, parentFrameId: 2, documentId: 'child' })
    background.emit('onHistoryStateUpdated', { ...details, url: 'https://child.example.com/old' })
    background.emit('onHistoryStateUpdated', { ...details, url: 'https://child.example.com/latest' })
    await settle()
    // The newer relay fails while the older one succeeds; the stale success must
    // not confirm the frame, and the aggregate retries only the latest URL.
    pending[1]({ ok: false })
    pending[0]({ ok: true })
    await settle()
    assert.deepEqual(await background.aggregate(), { ok: true, clear: false, epoch: 3 })
    const retries = background.messages.filter(({ message }) => message.type === 'PB_URL_CHANGED').slice(2)
    assert.deepEqual(retries.map(({ message }) => message.url), ['https://child.example.com/latest'])
    retrySucceeds = true
    assert.deepEqual(await background.aggregate(), { ok: true, clear: true, epoch: 3 })
})

test('an older failed relay cannot undo a newer successful acknowledgement', async () => {
    const pending = []
    const background = loadBackground({
        onSend: message => message.type === 'PB_URL_CHANGED'
            ? new Promise(resolve => pending.push(resolve)) : undefined,
    })
    const details = navigationDetails({ frameId: 9, parentFrameId: 2, documentId: 'child' })
    background.emit('onHistoryStateUpdated', details)
    background.emit('onHistoryStateUpdated', details)
    await settle()
    // The newer relay is acknowledged first; the older failure arrives afterwards
    // and must neither re-mark the frame pending nor schedule a retry.
    pending[1]({ ok: true })
    pending[0]({ ok: false })
    await settle()
    assert.deepEqual(await background.aggregate(), { ok: true, clear: true, epoch: 3 })
})

test('a failed URL relay does not block a replacement document in the same frame', async () => {
    const background = loadBackground({
        onSend: message => message.type === 'PB_URL_CHANGED' ? Promise.resolve(null) : undefined,
    })
    background.emit('onHistoryStateUpdated', navigationDetails({ frameId: 9, parentFrameId: 2, documentId: 'child' }))
    await settle()
    assert.deepEqual(await background.aggregate(), { ok: true, clear: false, epoch: 3 })
    // The unconfirmed relay belongs to document 'child'; a new document in the
    // same frame is judged on its own and the stale entry is not retried for it.
    background.frames[2].documentId = 'replacement-child'
    assert.deepEqual(await background.aggregate(), { ok: true, clear: true, epoch: 3 })
})

test('invalid or inactive navigation events never send content messages', async () => {
    const background = loadBackground()
    // Each entry breaks one field check: a top frame must have parentFrameId -1
    // and a subframe a real parent; only documentLifecycle 'active' owns visible
    // content (prerender, cached and pending_deletion documents do not).
    const invalid = [
        null,
        undefined,
        {},
        navigationDetails({ tabId: -1 }),
        navigationDetails({ tabId: NaN }),
        navigationDetails({ frameId: -1 }),
        navigationDetails({ frameId: 1.5 }),
        navigationDetails({ parentFrameId: undefined }),
        navigationDetails({ parentFrameId: 0 }),
        navigationDetails({ frameId: 9, parentFrameId: -1 }),
        navigationDetails({ documentId: undefined }),
        navigationDetails({ documentId: '' }),
        navigationDetails({ documentLifecycle: 'prerender' }),
        navigationDetails({ documentLifecycle: 'cached' }),
        navigationDetails({ documentLifecycle: 'pending_deletion' }),
        navigationDetails({ documentLifecycle: undefined }),
        navigationDetails({ url: undefined }),
        navigationDetails({ url: '' }),
    ]
    for (const event of ['onHistoryStateUpdated', 'onReferenceFragmentUpdated']) {
        invalid.forEach(details => background.emit(event, details))
    }
    await settle()
    assert.deepEqual(background.messages, [])
})

test('ordinary child navigation still invalidates ancestors and guards aggregates', async () => {
    const background = loadBackground()
    const details = navigationDetails({ frameId: 9, parentFrameId: 2, documentId: 'child' })
    // A real navigation: pending between onBeforeNavigate and onCommitted, with
    // both ancestors invalidated at each end (two messages per end).
    background.emit('onBeforeNavigate', details)
    await settle()
    assert.deepEqual(await background.aggregate(), { ok: true, clear: false, epoch: 3 })
    background.emit('onCommitted', details)
    await settle()
    assert.equal(background.messages.filter(({ message }) => message.type === 'PB_FRAME_AGGREGATE_INVALIDATED').length, 4)
    assert.deepEqual(await background.aggregate(), { ok: true, clear: true, epoch: 3 })
})

// A request that asks for per-child tokens. The sibling tree gives the main
// document two iframes: the checked 'middle' frame and an extension page that
// has no content script, so its status request can only fail.
const individualRequest = { individualClearance: true, frameElementCount: 2 }
const siblingFrames = [
    frameTree[0],
    frameTree[1],
    { frameId: 17, parentFrameId: 0, documentId: 'helper', documentLifecycle: 'active', url: 'chrome-extension://helper/frame.html' },
]

// Frame 17 never answers; everything else keeps the loadBackground defaults.
function loadSiblingBackground({ onSend, frameData = siblingFrames } = {}) {
    return loadBackground({
        frameData,
        onSend(message, options) {
            const response = onSend?.(message, options)
            if (response !== undefined) return response
            if (message.type === 'PB_FRAME_STATUS_REQUEST' && options.frameId === 17) {
                return Promise.reject(new Error('No content script in this extension frame'))
            }
            return undefined
        },
    })
}

function clearanceMessages(background, type) {
    return background.messages.filter(({ message }) => message.type === type)
}

test('individual clearance releases a checked child despite an unavailable sibling', async () => {
    const background = loadSiblingBackground()
    const result = await background.aggregate(individualRequest)

    assert.equal(result.clear, false, 'the existing all-frames verdict remains conservative')
    assert.equal(result.ok, true)
    assert.equal(result.epoch, 3)
    assert.equal(result.clearTokens?.length, 1, 'a separate proof should release the checked child')
    assert.match(result.clearTokens[0], /^[0-9a-f-]{36}$/)
    // Ticket order matters: the parent is armed with the tokens before any child
    // is told to emit, so an unsolicited postMessage can never match a ticket.
    const arm = clearanceMessages(background, 'PB_FRAME_CLEARANCE_ARM')
    const emit = clearanceMessages(background, 'PB_FRAME_CLEARANCE_EMIT')
    assert.deepEqual(arm, [{
        tabId: 42,
        message: { target: 'content', type: 'PB_FRAME_CLEARANCE_ARM', epoch: 3, tokens: result.clearTokens },
        options: { frameId: 0, documentId: 'main' },
    }])
    assert.deepEqual(emit, [{
        tabId: 42,
        message: { target: 'content', type: 'PB_FRAME_CLEARANCE_EMIT', token: result.clearTokens[0] },
        options: { frameId: 2, documentId: 'middle' },
    }])
    assert.ok(background.messages.indexOf(arm[0]) < background.messages.indexOf(emit[0]))
})

test('legacy aggregate requests keep their response shape and never arm individual proofs', async () => {
    const background = loadSiblingBackground()
    assert.deepEqual(await background.aggregate({ frameElementCount: 2 }), { ok: true, clear: false, epoch: 3 })
    assert.equal(clearanceMessages(background, 'PB_FRAME_CLEARANCE_ARM').length, 0)
    assert.equal(clearanceMessages(background, 'PB_FRAME_CLEARANCE_EMIT').length, 0)
})

test('an entirely clear aggregate needs no individual bridge handshake', async () => {
    const background = loadBackground({ frameData: siblingFrames.slice(0, 2) })
    assert.deepEqual(await background.aggregate({ individualClearance: true }), {
        ok: true, clear: true, epoch: 3, clearTokens: [],
    })
    assert.equal(clearanceMessages(background, 'PB_FRAME_CLEARANCE_ARM').length, 0)
})

test('unsupported parent owners do not change the old aggregate but permit a checked child proof', async () => {
    const background = loadSiblingBackground()
    // An unsupported owner in the parent's DOM blocks the whole-tree release but
    // says nothing about the checked child's own subtree.
    const result = await background.aggregate({ ...individualRequest, hasUnsupportedFrameOwner: true })
    assert.equal(result.clear, false)
    assert.equal(result.clearTokens?.length, 1)
})

test('same-URL sibling documents get distinct proofs addressed by exact browser identities', async () => {
    // Same URL as 'middle', different frame and document: tokens must be routed
    // by browser identity, never by URL, and each request mints fresh ones.
    const duplicate = { ...frameTree[1], frameId: 4, documentId: 'same-url-other-document' }
    const background = loadSiblingBackground({ frameData: [...siblingFrames, duplicate] })
    const result = await background.aggregate({ ...individualRequest, frameElementCount: 3 })
    assert.equal(result.clearTokens?.length, 2)
    assert.equal(new Set(result.clearTokens).size, 2)
    const emit = clearanceMessages(background, 'PB_FRAME_CLEARANCE_EMIT')
    assert.deepEqual(emit.map(({ options }) => options), [
        { frameId: 2, documentId: 'middle' },
        { frameId: 4, documentId: 'same-url-other-document' },
    ])
    assert.deepEqual(emit.map(({ message }) => message.token), result.clearTokens)
    const next = await background.aggregate({ ...individualRequest, frameElementCount: 3 })
    assert.equal(next.clearTokens.some(token => result.clearTokens.includes(token)), false,
        'each request must use fresh single-use tickets')
})

for (const failure of ['unavailable', 'matching', 'unsupported owner', 'owner count mismatch', 'pending navigation']) {
    test(`a ${failure} descendant rejects only its own direct-child subtree`, async () => {
        // Tree: main owns 'middle' (which owns child 9), the extension page and
        // 'other'. Only frame 9's status is manipulated; its failure must reject
        // middle's subtree and nothing else, so 'other' alone gets a token.
        const other = { frameId: 4, parentFrameId: 0, documentId: 'other', documentLifecycle: 'active', url: 'https://other.example.com/' }
        const background = loadSiblingBackground({
            frameData: [...siblingFrames, frameTree[2], other],
            onSend(message, options) {
                if (message.type !== 'PB_FRAME_STATUS_REQUEST' || options.frameId !== 9) return undefined
                // 'matching' is a child whose own text matched; 'owner count mismatch'
                // claims one iframe while the tree shows none, so a DOM owner is
                // hidden from the browser's view and nothing can be proven.
                if (failure === 'unavailable') return Promise.resolve(null)
                return Promise.resolve({
                    allowsUnblur: failure !== 'matching',
                    frameElementCount: failure === 'owner count mismatch' ? 1 : 0,
                    hasUnsupportedFrameOwner: failure === 'unsupported owner',
                })
            },
        })
        if (failure === 'pending navigation') {
            background.emit('onBeforeNavigate', navigationDetails({ frameId: 9, parentFrameId: 2, documentId: 'child' }))
            await settle()
        }
        const result = await background.aggregate({ ...individualRequest, frameElementCount: 3 })
        assert.equal(result.clear, false)
        assert.equal(result.clearTokens?.length, 1)
        assert.deepEqual(clearanceMessages(background, 'PB_FRAME_CLEARANCE_EMIT').map(({ options }) => options), [
            { frameId: 4, documentId: 'other' },
        ])
    })
}

for (const stage of ['ARM', 'EMIT']) {
    for (const failure of ['missing acknowledgement', 'negative acknowledgement', 'rejection']) {
        test(`${stage} ${failure} never returns a clearance token`, async () => {
            const background = loadSiblingBackground({
                onSend(message) {
                    if (message.type !== `PB_FRAME_CLEARANCE_${stage}`) return undefined
                    if (failure === 'rejection') return Promise.reject(new Error('Listener unavailable'))
                    return Promise.resolve(failure === 'negative acknowledgement' ? { ok: false } : undefined)
                },
            })
            // A failed ARM yields no tokens and skips EMIT entirely; a failed EMIT
            // drops that child's token. Either way the reply carries an empty list.
            assert.deepEqual(await background.aggregate(individualRequest), {
                ok: true, clear: false, epoch: 3, clearTokens: [],
            })
            if (stage === 'ARM') assert.equal(clearanceMessages(background, 'PB_FRAME_CLEARANCE_EMIT').length, 0)
        })
    }
}

for (const change of ['parent document', 'child document', 'sibling topology', 'candidate navigation', 'candidate URL policy']) {
    test(`${change} during the clearance bridge rejects the stale proof`, async () => {
        // Declared first so the onSend closure can reach the fixture it is part
        // of. The change is made while the worker is delivering EMIT, inside the
        // async gap between arming and the final tree snapshot, so the final
        // checks must catch it. The pushed sibling has no documentLifecycle,
        // which the worker treats as active.
        let background
        background = loadSiblingBackground({
            onSend(message) {
                if (message.type === 'PB_URL_CHANGED' && change === 'candidate URL policy') return Promise.resolve(null)
                if (message.type !== 'PB_FRAME_CLEARANCE_EMIT') return undefined
                if (change === 'parent document') background.frames[0].documentId = 'replacement-parent'
                if (change === 'child document') background.frames[1].documentId = 'replacement-child'
                if (change === 'sibling topology') {
                    background.frames.push({ frameId: 20, parentFrameId: 0, documentId: 'new-sibling', url: 'https://new.example.com/' })
                }
                if (change === 'candidate navigation' || change === 'candidate URL policy') {
                    background.emit(change === 'candidate navigation' ? 'onBeforeNavigate' : 'onHistoryStateUpdated',
                        navigationDetails({ frameId: 2, parentFrameId: 0, documentId: 'middle', url: 'https://frame.example.com/changed' }))
                }
                return Promise.resolve({ ok: true })
            },
        })
        assert.deepEqual(await background.aggregate(individualRequest), {
            ok: true, clear: false, epoch: 3, clearTokens: [],
        })
    })
}

test('unconfirmed parent URL policy prevents every individual proof', async () => {
    const background = loadSiblingBackground({
        onSend: message => message.type === 'PB_URL_CHANGED' ? Promise.resolve(null) : undefined,
    })
    // The parent's own relay is unconfirmed, so it may be about to re-blur: it
    // gets ok without clearance and is never armed.
    background.emit('onHistoryStateUpdated', navigationDetails())
    await settle()
    assert.deepEqual(await background.aggregate(individualRequest), { ok: true, clear: false, epoch: 3, clearTokens: [] })
    assert.equal(clearanceMessages(background, 'PB_FRAME_CLEARANCE_ARM').length, 0)
})
