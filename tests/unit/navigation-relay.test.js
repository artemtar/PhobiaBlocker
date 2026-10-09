const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const repositoryRoot = path.resolve(__dirname, '../..')
const clone = value => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(resolve => setImmediate(resolve))

function browserEvent() {
    const listeners = []
    return {
        addListener(listener) { listeners.push(listener) },
        emit(...args) { listeners.forEach(listener => listener(...args)) },
    }
}

const frameTree = [
    { frameId: 0, parentFrameId: -1, documentId: 'main', documentLifecycle: 'active', url: 'https://example.com/' },
    { frameId: 2, parentFrameId: 0, documentId: 'middle', documentLifecycle: 'active', url: 'https://frame.example.com/' },
    { frameId: 9, parentFrameId: 2, documentId: 'child', documentLifecycle: 'active', url: 'https://child.example.com/restricted' },
]

function loadBackground({ onSend, frameData = frameTree } = {}) {
    const messages = []
    const frames = clone(frameData)
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
                assert.equal(tabId, 42)
                callback(clone(frames))
            },
        },
        storage: {
            onChanged: browserEvent(),
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
    background.frames[2].documentId = 'replacement-child'
    assert.deepEqual(await background.aggregate(), { ok: true, clear: true, epoch: 3 })
})

test('invalid or inactive navigation events never send content messages', async () => {
    const background = loadBackground()
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
    background.emit('onBeforeNavigate', details)
    await settle()
    assert.deepEqual(await background.aggregate(), { ok: true, clear: false, epoch: 3 })
    background.emit('onCommitted', details)
    await settle()
    assert.equal(background.messages.filter(({ message }) => message.type === 'PB_FRAME_AGGREGATE_INVALIDATED').length, 4)
    assert.deepEqual(await background.aggregate(), { ok: true, clear: true, epoch: 3 })
})

const individualRequest = { individualClearance: true, frameElementCount: 2 }
const siblingFrames = [
    frameTree[0],
    frameTree[1],
    { frameId: 17, parentFrameId: 0, documentId: 'helper', documentLifecycle: 'active', url: 'chrome-extension://helper/frame.html' },
]

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
    const result = await background.aggregate({ ...individualRequest, hasUnsupportedFrameOwner: true })
    assert.equal(result.clear, false)
    assert.equal(result.clearTokens?.length, 1)
})

test('same-URL sibling documents get distinct proofs addressed by exact browser identities', async () => {
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
        const other = { frameId: 4, parentFrameId: 0, documentId: 'other', documentLifecycle: 'active', url: 'https://other.example.com/' }
        const background = loadSiblingBackground({
            frameData: [...siblingFrames, frameTree[2], other],
            onSend(message, options) {
                if (message.type !== 'PB_FRAME_STATUS_REQUEST' || options.frameId !== 9) return undefined
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
            assert.deepEqual(await background.aggregate(individualRequest), {
                ok: true, clear: false, epoch: 3, clearTokens: [],
            })
            if (stage === 'ARM') assert.equal(clearanceMessages(background, 'PB_FRAME_CLEARANCE_EMIT').length, 0)
        })
    }
}

for (const change of ['parent document', 'child document', 'sibling topology', 'candidate navigation', 'candidate URL policy']) {
    test(`${change} during the clearance bridge rejects the stale proof`, async () => {
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
    background.emit('onHistoryStateUpdated', navigationDetails())
    await settle()
    assert.deepEqual(await background.aggregate(individualRequest), { ok: true, clear: false, epoch: 3, clearTokens: [] })
    assert.equal(clearanceMessages(background, 'PB_FRAME_CLEARANCE_ARM').length, 0)
})
