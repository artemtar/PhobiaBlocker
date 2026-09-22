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
    return {
        tagName,
        children: [],
        disabled: false,
        hidden: false,
        value: '',
        textContent: '',
        style: { setProperty() {} },
        set innerHTML(value) {
            this.html = value
            this.children = []
        },
        appendChild(child) { this.children.push(child) },
        addEventListener(type, listener) { listeners.set(type, listener) },
        dispatch(type, details = {}) {
            listeners.get(type)?.({ target: this, currentTarget: this, ...details })
        },
    }
}

// The production policy, storage, shared UI and settings scripts run unchanged;
// only DOM/Chrome boundaries are faked to control storage callback ordering.
function createSettings() {
    const elements = new Map()
    for (const [tag, tagName, id] of settingsHtml.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const element = createElement(tagName)
        element.id = id
        element.disabled = /\bdisabled\b/.test(tag)
        elements.set(id, element)
    }
    const persisted = clone(savedLists)
    const writes = []
    const changeListeners = []
    const pendingReads = []
    let deferReads = false
    let initialRead
    let readCount = 0
    const runtime = { lastError: null, getManifest: () => ({ version: 'test' }) }
    const complete = (callback, values, error) => {
        runtime.lastError = error ? { message: error } : null
        callback(values)
        runtime.lastError = null
    }
    const context = vm.createContext({
        console: { error() {} },
        URL,
        setTimeout,
        window: { location: { hash: '' } },
        IntersectionObserver: class { observe() {} },
        document: {
            addEventListener() {},
            getElementById: id => elements.get(id),
            querySelectorAll(selector) {
                if (selector !== 'input, button') return []
                return [...elements.values()].filter(element => ['input', 'button'].includes(element.tagName))
            },
            createElement,
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
                        writes.push(candidate)
                        Object.assign(persisted, candidate)
                        complete(callback)
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
        addSite(listType, value) {
            elements.get(`${listType}-input`).value = value
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
        assert.equal(settings.elements.get(`${listType}-input`).disabled, disabled, `${listType} input`)
        assert.equal(settings.elements.get(`add-${listType}-btn`).disabled, disabled, `${listType} add button`)
        for (const site of settings.elements.get(`${listType}-container`).children) {
            assert.equal(site.children[0].disabled, disabled, `${listType} remove button`)
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
        assert.equal(settings.elements.get(`${listType}-input`).value, 'local.example')
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
        assert.equal(settings.elements.get(`${listType}-input`).value, 'local.example')
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
