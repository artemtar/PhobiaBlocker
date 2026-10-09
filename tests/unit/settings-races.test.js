const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const repositoryRoot = path.resolve(__dirname, '../..')
const settingsHtml = fs.readFileSync(path.join(repositoryRoot, 'settings.html'), 'utf8')
const clone = value => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(resolve => setImmediate(resolve))
const savedLists = {
    whitelistedSites: ['allowed.example', 'trusted.example'],
    blacklistedSites: ['blocked.example', 'unsafe.example'],
}

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
    for (const [tag, tagName, id] of settingsHtml.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const element = createElement(tagName)
        element.id = id
        element.disabled = /\bdisabled\b/.test(tag)
        element.hidden = /\bhidden\b/.test(tag)
        elements.set(id, element)
    }
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
                    get(keys, callback) {
                        const values = Object.fromEntries(keys
                            .filter(key => persisted[key] !== undefined)
                            .map(key => [key, clone(persisted[key])]))
                        const finish = error => complete(callback, values, error)
                        if (readCount++ === 0) initialRead = finish
                        else if (deferReads) pendingReads.push(finish)
                        else finish()
                    },
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
    for (const file of ['shared-policy.js', 'storage.js', 'settings-ui.js', 'settings.js']) {
        vm.runInContext(fs.readFileSync(path.join(repositoryRoot, 'js', file), 'utf8'), context, { filename: file })
    }
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
        async finishInitialRead(error) {
            initialRead(error)
            await initialized
        },
        deferRefreshReads() { deferReads = true },
        async finishRefreshRead(index = 0, error) {
            pendingReads.splice(index, 1)[0](error)
            await settle()
        },
        async change(values) {
            const changes = Object.fromEntries(Object.entries(values)
                .map(([key, newValue]) => [key, { oldValue: persisted[key], newValue }]))
            Object.assign(persisted, clone(values))
            changeListeners.forEach(listener => listener(changes, 'sync'))
            await settle()
        },
    }
}

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

test('site edits before the initial settings read cannot replace saved lists', async () => {
    const settings = createSettings()
    await settings.addSite('whitelist', 'new.example')
    await settings.removeSite('blacklist', 0)
    assert.deepEqual(settings.writes, [])
    assert.deepEqual(settings.persisted, savedLists)
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

test('a storage change during initialization is retained by the first site edit', async () => {
    const settings = createSettings()
    await settings.change({ whitelistedSites: ['latest.example'] })
    await settings.finishInitialRead()
    await settings.addSite('whitelist', 'new.example')
    assert.deepEqual(settings.persisted.whitelistedSites, ['latest.example', 'new.example'])
})

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
