// Races on the settings page between the user's edits, in-flight storage writes
// and storage.onChanged refreshes from another context (the popup). The guarded
// invariant: an edit may never write a list or flag that is older than a change
// the page has already been told about.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const repositoryRoot = path.resolve(__dirname, '../..')
const settingsHtml = fs.readFileSync(path.join(repositoryRoot, 'settings.html'), 'utf8')
const clone = value => JSON.parse(JSON.stringify(value))
// setImmediate runs after every pending microtask, so one settle() lets a whole
// storage callback -> promise -> render chain finish before the next assertion.
const settle = () => new Promise(resolve => setImmediate(resolve))
// What storage holds before the page loads; every test starts from these lists.
const savedLists = {
    whitelistedSites: ['allowed.example', 'trusted.example'],
    blacklistedSites: ['blocked.example', 'unsafe.example'],
}

// One listener per event type is kept, which matches settings.js (one handler per
// control); dispatch() is how a test clicks a button or changes an input.
function createElement(tagName = 'div') {
    const listeners = new Map()
    const attributes = new Map()
    const classes = new Set()
    return {
        tagName,
        children: [],
        disabled: false,
        hidden: false,
        value: '',
        textContent: '',
        dataset: {},
        classList: {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
            contains: name => classes.has(name),
        },
        style: { setProperty() {} },
        setAttribute(name, value) { attributes.set(name, String(value)) },
        getAttribute: name => attributes.get(name),
        removeAttribute: name => attributes.delete(name),
        focus() { this.focused = true },
        scrollIntoView() {},
        // settings.js empties list containers with innerHTML = '' before re-rendering.
        set innerHTML(value) {
            this.html = value
            this.children = []
        },
        appendChild(child) { this.children.push(child) },
        append(...children) { this.children.push(...children) },
        addEventListener(type, listener) { listeners.set(type, listener) },
        dispatch(type, details = {}) {
            listeners.get(type)?.({ target: this, currentTarget: this, preventDefault() {}, ...details })
        },
    }
}

// The production policy, storage, shared UI and settings scripts run unchanged;
// only DOM/Chrome boundaries are faked to control storage callback ordering.
function createSettings({ initial = {}, hash = '' } = {}) {
    const elements = new Map()
    // Elements are scraped from the real settings.html, so a renamed id fails here
    // instead of leaving a dangling fake. `tag` is the whole opening tag; the markup's
    // disabled/hidden attributes become the initial state the page is expected to lift.
    for (const [tag, tagName, id] of settingsHtml.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const element = createElement(tagName)
        element.id = id
        element.disabled = /\bdisabled\b/.test(tag)
        element.hidden = /\bhidden\b/.test(tag)
        elements.set(id, element)
    }
    // The fake <select> has no options; whitelist is the first one in the markup.
    elements.get('site-rule-type').value = 'whitelist'
    const modeButtons = [...settingsHtml.matchAll(/<button[^>]*data-mode="([^"]+)"/g)].map(([, mode]) => {
        const button = createElement('button')
        button.dataset.mode = mode
        return button
    })
    const navLinks = [...settingsHtml.matchAll(/<a href="#([^"]+)" class="nav-link/g)].map(([, section]) => {
        const link = createElement('a')
        link.setAttribute('href', `#${section}`)
        return link
    })
    const persisted = { ...clone(savedLists), ...clone(initial) }
    const writes = []
    const changeListeners = []
    const pendingReads = []
    let deferReads = false
    let deferWrites = false
    const pendingWrites = []
    let writeError
    let initialRead
    let readCount = 0
    const runtime = { lastError: null, getManifest: () => ({ version: 'test' }) }
    const location = { hash }
    // Chrome reports a storage failure only through runtime.lastError, set for the
    // duration of the callback; storage.js reads it there, so the fake does the same.
    const complete = (callback, values, error) => {
        runtime.lastError = error ? { message: error } : null
        callback(values)
        runtime.lastError = null
    }
    const context = vm.createContext({
        console: { error() {} },
        URL,
        setTimeout,
        window: { location, addEventListener() {} },
        IntersectionObserver: class { observe() {} },
        document: {
            addEventListener() {},
            getElementById: id => elements.get(id),
            querySelectorAll(selector) {
                if (selector === '[data-mode]') return modeButtons
                if (selector === '.nav-link') return navLinks
                if (selector === '.settings-section') return navLinks.map(link => elements.get(link.getAttribute('href').slice(1)))
                if (selector === 'input, button' || selector === 'input, select, button') {
                    return [...elements.values(), ...modeButtons].filter(element => ['input', 'button', 'select'].includes(element.tagName))
                }
                return []
            },
            querySelector(selector) {
                return navLinks.find(link => selector === `.nav-link[href="${link.getAttribute('href')}"]`)
            },
            createElement,
            createTextNode: text => ({ textContent: text }),
        },
        chrome: {
            runtime,
            commands: { getAll(callback) { callback([]) } },
            storage: {
                onChanged: { addListener(listener) { changeListeners.push(listener) } },
                sync: {
                    // The values are snapshotted when the read is requested, not when it
                    // completes, so a deferred older read really carries the older list.
                    // Missing keys are omitted and storage.js fills in the defaults.
                    get(keys, callback) {
                        const values = Object.fromEntries(keys
                            .filter(key => persisted[key] !== undefined)
                            .map(key => [key, clone(persisted[key])]))
                        const finish = error => complete(callback, values, error)
                        // The very first read is the page's initial loadAll and is held
                        // until finishInitialRead; later reads (refreshes, a retried load)
                        // complete at once unless deferRefreshReads was called.
                        if (readCount++ === 0) initialRead = finish
                        else if (deferReads) pendingReads.push(finish)
                        else finish()
                    },
                    // A write lands in `persisted` only when it succeeds, so `writes` is
                    // exactly the list of committed writes a test can assert against.
                    set(values, callback) {
                        const candidate = clone(values)
                        const finish = () => {
                            if (!writeError) {
                                writes.push(candidate)
                                Object.assign(persisted, candidate)
                            }
                            complete(callback, undefined, writeError)
                        }
                        if (deferWrites) pendingWrites.push(finish)
                        else finish()
                    },
                },
            },
        },
    })
    // The load order of settings.html; each script expects the previous globals.
    for (const file of ['shared-policy.js', 'storage.js', 'settings-ui.js', 'settings.js']) {
        vm.runInContext(fs.readFileSync(path.join(repositoryRoot, 'js', file), 'utf8'), context, { filename: file })
    }
    // Called directly because the fake document never fires DOMContentLoaded. The
    // promise stays pending until the held initial read is released.
    const initialized = context.initializeSettingsPage()
    return {
        elements,
        persisted,
        writes,
        modeButtons,
        navLinks,
        location,
        async chooseMode(mode) {
            modeButtons.find(button => button.dataset.mode === mode).dispatch('click')
            await settle()
        },
        async addWord(value) {
            elements.get('word-input').value = value
            elements.get('add-word-btn').dispatch('click')
            await settle()
        },
        failWrites(message) { writeError = message },
        deferWrites() { deferWrites = true },
        async finishWrite() { pendingWrites.shift()(); await settle() },
        addSite(listType, value) {
            elements.get('site-rule-type').value = listType
            elements.get('site-rule-input').value = value
            return context.addToSiteList(listType)
        },
        removeSite: (listType, index) => context.removeSiteFromList(index, listType),
        // If a change() invalidated the load, loadAll reads again; that second read is
        // not deferred (unless deferRefreshReads ran), so awaiting `initialized` is safe.
        async finishInitialRead(error) {
            initialRead(error)
            await initialized
        },
        deferRefreshReads() { deferReads = true },
        // Pending reads are listed in request order; the index picks which of several
        // overlapping refreshes completes first, which is how the races are staged.
        async finishRefreshRead(index = 0, error) {
            pendingReads.splice(index, 1)[0](error)
            await settle()
        },
        // Another context (the popup) wrote to storage: persist first, then notify
        // onChanged listeners with Chrome's {oldValue, newValue} shape.
        async change(values) {
            const changes = Object.fromEntries(Object.entries(values)
                .map(([key, newValue]) => [key, { oldValue: persisted[key], newValue }]))
            Object.assign(persisted, clone(values))
            changeListeners.forEach(listener => listener(changes, 'sync'))
            await settle()
        },
    }
}

// Both lists share one input and add button, so the lock state is re-derived per
// list by switching the type select; the last child of each row is its remove button.
function assertSiteControlsDisabled(settings, disabled, listTypes = ['whitelist', 'blacklist']) {
    for (const listType of listTypes) {
        settings.elements.get('site-rule-type').value = listType
        settings.elements.get('site-rule-type').dispatch('change')
        assert.equal(settings.elements.get('site-rule-input').disabled, disabled, `${listType} input`)
        assert.equal(settings.elements.get('add-site-rule-btn').disabled, disabled, `${listType} add button`)
        for (const site of settings.elements.get(`${listType}-container`).children) {
            assert.equal(site.children.at(-1).disabled, disabled, `${listType} remove button`)
        }
    }
}

// Before the first read the page knows no lists; an accepted edit would write
// [new.example] over the saved whitelist.
test('site edits before the initial settings read cannot replace saved lists', async () => {
    const settings = createSettings()
    await settings.addSite('whitelist', 'new.example')
    await settings.removeSite('blacklist', 0)
    assert.deepEqual(settings.writes, [])
    assert.deepEqual(settings.persisted, savedLists)
    // Released so the page's pending load does not outlive the test.
    await settings.finishInitialRead()
})

test('site controls remain disabled until the complete settings read succeeds', async () => {
    const settings = createSettings()
    assertSiteControlsDisabled(settings, true)
    await settings.finishInitialRead()
    assertSiteControlsDisabled(settings, false)
    await settings.addSite('whitelist', 'new.example')
    await settings.removeSite('blacklist', 0)
    assert.deepEqual(settings.persisted.whitelistedSites, ['allowed.example', 'trusted.example', 'new.example'])
    assert.deepEqual(settings.persisted.blacklistedSites, ['unsafe.example'])
})

// While the page is not loaded a change only invalidates the reader; it must not
// hand the page a partial snapshot that makes edits possible.
test('failed initial reads keep site edits guarded even after a partial storage change', async () => {
    const settings = createSettings()
    await settings.finishInitialRead('Storage unavailable')
    await settings.change({ whitelistedSites: ['latest.example'] })
    await settings.addSite('whitelist', 'new.example')
    await settings.removeSite('blacklist', 0)
    assert.deepEqual(settings.writes, [])
    assert.deepEqual(settings.persisted.whitelistedSites, ['latest.example'])
    assert.deepEqual(settings.persisted.blacklistedSites, savedLists.blacklistedSites)
    assertSiteControlsDisabled(settings, true)
    assert.equal(settings.elements.get('settings-error').hidden, false)
})

// The held initial read snapshotted the old list; the change invalidates the load,
// so loadAll reads a second time and the page starts from latest.example.
test('a storage change during initialization is retained by the first site edit', async () => {
    const settings = createSettings()
    await settings.change({ whitelistedSites: ['latest.example'] })
    await settings.finishInitialRead()
    await settings.addSite('whitelist', 'new.example')
    assert.deepEqual(settings.persisted.whitelistedSites, ['latest.example', 'new.example'])
})

// Two refreshes of the same key complete in reverse order. Read 0 snapshotted the
// one-item list, so applying it after read 1 would drop second.example.
test('out-of-order list refreshes cannot erase a newer site rule on the next edit', async () => {
    const settings = createSettings()
    await settings.finishInitialRead()
    settings.deferRefreshReads()
    await settings.change({ whitelistedSites: ['first.example'] })
    await settings.change({ whitelistedSites: ['first.example', 'second.example'] })
    await settings.finishRefreshRead(1)
    await settings.finishRefreshRead(0)
    await settings.addSite('whitelist', 'third.example')
    assert.deepEqual(settings.persisted.whitelistedSites, ['first.example', 'second.example', 'third.example'])
})

// Read 0 covers two keys, read 1 only previewEnabled. When read 0 lands last its
// previewEnabled is superseded, but its whitelistedSites is still the current value
// and must be applied; dropping the whole response would leave that key locked.
test('overlapping refreshes retain unrelated keys from the earlier response', async () => {
    const settings = createSettings()
    await settings.finishInitialRead()
    settings.deferRefreshReads()
    await settings.change({ whitelistedSites: ['latest.example'], previewEnabled: false })
    await settings.change({ previewEnabled: true })
    await settings.finishRefreshRead(1)
    await settings.finishRefreshRead(0)
    assert.equal(settings.elements.get('preview-switch').checked, true)
    await settings.addSite('whitelist', 'new.example')
    assert.deepEqual(settings.persisted.whitelistedSites, ['latest.example', 'new.example'])
})

for (const [listType, storageKey] of [['whitelist', 'whitelistedSites'], ['blacklist', 'blacklistedSites']]) {
    // The page still shows the pre-change list while the refresh is in flight; an
    // accepted add would write that stale list plus local.example over remote.example.
    // The typed value is kept in the input so the user can retry after the refresh.
    test(`${listType} add/remove during a refresh cannot overwrite a remote rule`, async () => {
        const settings = createSettings()
        await settings.finishInitialRead()
        settings.deferRefreshReads()
        await settings.change({ [storageKey]: ['existing.example', 'remote.example'] })
        await settings.addSite(listType, 'local.example')
        await settings.removeSite(listType, 0)
        assert.deepEqual(settings.writes, [])
        assert.deepEqual(settings.persisted[storageKey], ['existing.example', 'remote.example'])
        assert.equal(settings.elements.get('site-rule-input').value, 'local.example')
        assertSiteControlsDisabled(settings, true, [listType])

        await settings.finishRefreshRead()
        assertSiteControlsDisabled(settings, false, [listType])
        await settings.addSite(listType, 'local.example')
        await settings.removeSite(listType, 0)
        assert.deepEqual(settings.persisted[storageKey], ['remote.example', 'local.example'])
    })

    // A failed refresh leaves its key in settingsRefreshRequired. Successful refreshes
    // of other keys (previewEnabled, debugMode) must not unlock it; only a later
    // successful read of the same key does.
    test(`${listType} refresh failure keeps edits blocked through unrelated successes until recovery`, async () => {
        const settings = createSettings()
        await settings.finishInitialRead()
        settings.deferRefreshReads()
        await settings.change({ [storageKey]: ['remote.example'] })
        await settings.change({ previewEnabled: false })
        await settings.finishRefreshRead(1)
        assertSiteControlsDisabled(settings, true, [listType])
        await settings.finishRefreshRead(0, 'Storage unavailable')
        await settings.change({ debugMode: true })
        await settings.finishRefreshRead()
        await settings.addSite(listType, 'local.example')
        await settings.removeSite(listType, 0)
        assert.deepEqual(settings.writes, [])
        assert.deepEqual(settings.persisted[storageKey], ['remote.example'])
        assert.equal(settings.elements.get('site-rule-input').value, 'local.example')
        assertSiteControlsDisabled(settings, true, [listType])
        assert.equal(settings.elements.get('settings-error').hidden, false)

        await settings.change({ [storageKey]: ['remote.example', 'recovered.example'] })
        await settings.finishRefreshRead()
        assertSiteControlsDisabled(settings, false, [listType])
        await settings.addSite(listType, 'local.example')
        assert.deepEqual(settings.persisted[storageKey], ['remote.example', 'recovered.example', 'local.example'])
    })
}

// The older read fails after the newer one succeeded. createRevisionedReader only
// reports a failure while that read still owns a key, so the stale failure must
// neither re-lock the list nor raise the refresh alert.
test('a successful newer site refresh releases edits despite an older pending read and failure', async () => {
    const settings = createSettings()
    await settings.finishInitialRead()
    settings.deferRefreshReads()
    await settings.change({ whitelistedSites: ['old.example'] })
    await settings.change({ whitelistedSites: ['remote.example'] })
    assertSiteControlsDisabled(settings, true, ['whitelist'])
    await settings.finishRefreshRead(1)
    assertSiteControlsDisabled(settings, false, ['whitelist'])
    await settings.finishRefreshRead(0, 'Old read unavailable')
    assertSiteControlsDisabled(settings, false, ['whitelist'])
    await settings.addSite('whitelist', 'local.example')
    assert.deepEqual(settings.persisted.whitelistedSites, ['remote.example', 'local.example'])
})

// One write per click. Two separate writes would be two storage changes, each
// re-read by every open page, with an intermediate flag combination in between.
test('default protection modes persist both policy flags in one write', async () => {
    const settings = createSettings()
    await settings.finishInitialRead()
    await settings.chooseMode('always')
    await settings.chooseMode('off')
    await settings.chooseMode('smart')
    assert.deepEqual(settings.writes, [
        { phobiaBlockerEnabled: true, blurIsAlwaysOn: true },
        { phobiaBlockerEnabled: false, blurIsAlwaysOn: false },
        { phobiaBlockerEnabled: true, blurIsAlwaysOn: false },
    ])
})

test('failed mode writes restore the committed selection', async () => {
    const settings = createSettings({ initial: { phobiaBlockerEnabled: true, blurIsAlwaysOn: true } })
    await settings.finishInitialRead()
    settings.failWrites('Storage unavailable')
    await settings.chooseMode('off')
    assert.equal(settings.modeButtons.find(button => button.dataset.mode === 'always').getAttribute('aria-pressed'), 'true')
    assert.equal(settings.modeButtons.find(button => button.dataset.mode === 'off').getAttribute('aria-pressed'), 'false')
    assert.equal(settings.persisted.phobiaBlockerEnabled, true)
    assert.equal(settings.elements.get('settings-error').hidden, false)
})

// The mode buttons write both flags, so a pending refresh of just blurIsAlwaysOn
// must lock them: a click would otherwise re-persist the stale value of that flag.
test('default mode edits are blocked while either policy flag needs a refresh', async () => {
    const settings = createSettings()
    await settings.finishInitialRead()
    settings.deferRefreshReads()
    await settings.change({ blurIsAlwaysOn: true })
    await settings.chooseMode('off')
    assert.deepEqual(settings.writes, [])
    assert.equal(settings.modeButtons.every(button => button.disabled), true)
    await settings.finishRefreshRead(0, 'Storage unavailable')
    await settings.chooseMode('smart')
    assert.deepEqual(settings.writes, [])
    await settings.change({ blurIsAlwaysOn: true })
    await settings.finishRefreshRead()
    await settings.chooseMode('smart')
    assert.deepEqual(settings.writes, [{ phobiaBlockerEnabled: true, blurIsAlwaysOn: false }])
})

// The full-width C folds to ASCII under NFKC and the whole word is lowercased, so
// 'clown' is then a duplicate; 'two words' fails the single-word shape check.
test('Settings adds normalized trigger words and rejects duplicates and invalid shapes', async () => {
    const settings = createSettings({ initial: { targetWords: ['spider'] } })
    await settings.finishInitialRead()
    await settings.addWord('  ＣLOWN  ')
    await settings.addWord('clown')
    await settings.addWord('two words')
    assert.deepEqual(settings.persisted.targetWords, ['spider', 'clown'])
    assert.deepEqual(settings.writes, [{ targetWords: ['spider', 'clown'] }])
    assert.equal(settings.elements.get('word-count').textContent, '2 / 20')
})

test('trigger-word edits cannot overwrite popup changes while a refresh is pending or failed', async () => {
    const settings = createSettings({ initial: { targetWords: ['spider'] } })
    await settings.addWord('clown')
    assert.deepEqual(settings.writes, [])
    await settings.finishInitialRead()
    settings.deferRefreshReads()
    await settings.change({ targetWords: ['spider', 'mice'] })
    await settings.addWord('clown')
    assert.deepEqual(settings.writes, [])
    await settings.finishRefreshRead(0, 'Storage unavailable')
    await settings.addWord('clown')
    assert.deepEqual(settings.writes, [])
    await settings.change({ targetWords: ['mice'] })
    await settings.finishRefreshRead()
    await settings.addWord('clown')
    assert.deepEqual(settings.persisted.targetWords, ['mice', 'clown'])
})

test('Settings enforces the same trigger-word limit as the popup', async () => {
    const targetWords = Array.from({ length: 20 }, (_, index) => `word${String.fromCharCode(97 + index)}`)
    const settings = createSettings({ initial: { targetWords } })
    await settings.finishInitialRead()
    await settings.addWord('clown')
    assert.deepEqual(settings.writes, [])
    assert.deepEqual(settings.persisted.targetWords, targetWords)
    assert.match(settings.elements.get('word-error').textContent, /20/)
})

// Each tag's last child is its remove button; children[1] is 'clown'. After the
// failed second removal the list must still show both remaining words.
test('removing a saved word persists the remaining words and preserves them on failure', async () => {
    const settings = createSettings({ initial: { targetWords: ['spider', 'clown', 'mice'] } })
    await settings.finishInitialRead()
    settings.elements.get('word-list').children[1].children.at(-1).dispatch('click')
    await settle()
    assert.deepEqual(settings.persisted.targetWords, ['spider', 'mice'])
    settings.failWrites('Storage unavailable')
    settings.elements.get('word-list').children[0].children.at(-1).dispatch('click')
    await settle()
    assert.deepEqual(settings.persisted.targetWords, ['spider', 'mice'])
    assert.equal(settings.elements.get('word-list').children.length, 2)
    assert.equal(settings.elements.get('settings-error').hidden, false)
})

// The two sliders have different units: blur strength is a 0-100 scale mapped
// through computeBlurPixels, the preview slider is literal pixels.
test('strength and word-cover controls write their distinct shared settings keys', async () => {
    const settings = createSettings()
    await settings.finishInitialRead()
    settings.elements.get('blur-strength-slider').value = '82'
    settings.elements.get('blur-strength-slider').dispatch('change')
    await settle()
    settings.elements.get('preview-strength-slider').value = '7'
    settings.elements.get('preview-strength-slider').dispatch('change')
    await settle()
    settings.elements.get('word-cover-switch').checked = false
    settings.elements.get('word-cover-switch').dispatch('change')
    await settle()
    assert.deepEqual(settings.writes, [
        { blurValueAmount: 82 },
        { previewBlurStrength: 7 },
        { wordCoverEnabled: false },
    ])
    assert.equal(settings.elements.get('blur-strength-value').textContent, '82 / 100')
    assert.equal(settings.elements.get('preview-strength-value').textContent, '7 px')
})

// '#hover-preview' is a hash from an earlier settings layout, aliased to the
// protection section, so old bookmarks still land on a panel.
test('sidebar navigation selects one panel and keeps the URL hash usable', async () => {
    const settings = createSettings({ hash: '#hover-preview' })
    await settings.finishInitialRead()
    assert.equal(settings.elements.get('protection').hidden, false)
    assert.equal(settings.elements.get('site-rules').hidden, true)
    settings.navLinks.find(link => link.getAttribute('href') === '#words').dispatch('click')
    assert.equal(settings.elements.get('words').hidden, false)
    assert.equal(settings.elements.get('protection').hidden, true)
    assert.equal(settings.location.hash, '#words')
    assert.equal(settings.navLinks.find(link => link.getAttribute('href') === '#words').getAttribute('aria-current'), 'page')
})

// The write of `false` is still in flight when the popup sets `true`. The write's
// callback must not paint its own value: the key's revision moved, and the refresh
// read (snapshotted at request time, so it holds `true`) decides the final state.
test('a pending scalar write keeps the control locked until the latest refresh finishes', async () => {
    const settings = createSettings()
    await settings.finishInitialRead()
    settings.deferWrites()
    settings.deferRefreshReads()
    const toggle = settings.elements.get('preview-switch')
    toggle.checked = false
    toggle.dispatch('change')
    await settings.change({ previewEnabled: true })
    await settings.finishWrite()
    assert.equal(toggle.disabled, true)
    await settings.finishRefreshRead()
    assert.equal(toggle.checked, true)
    assert.equal(toggle.disabled, false)
})

// Read 0 is the stale refresh, read 1 the retry's full load. The change during the
// retry invalidates that load (the page is unloaded again, so no refresh is issued),
// which is why read 1 must be finished twice: loadAll re-reads until no change
// arrived mid-flight. The stale refresh completes last and is dropped by generation.
test('retrying settings supersedes older pending refreshes before allowing list edits', async () => {
    const settings = createSettings()
    await settings.finishInitialRead()
    settings.deferRefreshReads()
    await settings.change({ whitelistedSites: ['old.example'] })
    settings.elements.get('retry-settings-btn').dispatch('click')
    await settings.change({ whitelistedSites: ['latest.example'] })
    await settings.finishRefreshRead(1)
    await settings.finishRefreshRead(1)
    await settings.finishRefreshRead(0)
    await settings.addSite('whitelist', 'new.example')
    assert.deepEqual(settings.persisted.whitelistedSites, ['latest.example', 'new.example'])
})

// After the failure two keys need a refresh. Finishing only previewEnabled's read
// must unlock that control but keep the alert and retry button, because debugMode
// is still unread; the second finishRefreshRead(0) is debugMode's read, now first.
test('refresh recovery clears its alert only after every affected key has a current value', async () => {
    const settings = createSettings()
    await settings.finishInitialRead()
    settings.deferRefreshReads()
    await settings.change({ previewEnabled: false })
    await settings.finishRefreshRead(0, 'Storage unavailable')
    assert.equal(settings.elements.get('settings-error').hidden, false)
    assert.equal(settings.elements.get('settings-save-status').textContent, 'Needs attention')

    await settings.change({ previewEnabled: true })
    await settings.change({ debugMode: true })
    await settings.finishRefreshRead(0)
    assert.equal(settings.elements.get('preview-switch').disabled, false)
    assert.equal(settings.elements.get('debug-switch').disabled, true)
    assert.equal(settings.elements.get('settings-error').hidden, false)
    assert.equal(settings.elements.get('retry-settings-btn').hidden, false)

    await settings.finishRefreshRead(0)
    assert.equal(settings.elements.get('debug-switch').disabled, false)
    assert.equal(settings.elements.get('settings-error').hidden, true)
    assert.equal(settings.elements.get('settings-save-status').textContent, 'Saved')
    assert.equal(settings.elements.get('retry-settings-btn').hidden, true)
})

// The alert has two sources. A refresh-caused alert clears itself on recovery; one
// raised by the user's own action (invalid rule, failed write) replaces it and must
// survive the recovery, with the retry button hidden since nothing is pending.
for (const failure of ['validation', 'write']) {
    test(`refresh recovery preserves an unrelated ${failure} error`, async () => {
        const settings = createSettings()
        await settings.finishInitialRead()
        settings.deferRefreshReads()
        await settings.change({ previewEnabled: false })
        await settings.finishRefreshRead(0, 'Storage unavailable')

        if (failure === 'write') settings.failWrites('Write unavailable')
        await settings.addSite('whitelist', failure === 'validation' ? 'invalid' : 'new.example')
        const message = settings.elements.get('settings-error').textContent
        assert.match(message, failure === 'validation' ? /valid domain/ : /Could not save/)

        await settings.change({ previewEnabled: true })
        await settings.finishRefreshRead(0)
        assert.equal(settings.elements.get('preview-switch').disabled, false)
        assert.equal(settings.elements.get('settings-error').textContent, message)
        assert.equal(settings.elements.get('settings-error').hidden, false)
        assert.equal(settings.elements.get('settings-save-status').textContent, 'Needs attention')
        assert.equal(settings.elements.get('retry-settings-btn').hidden, true)
    })
}
