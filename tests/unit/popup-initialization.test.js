const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const repositoryRoot = path.resolve(__dirname, '../..')
const popupHtml = fs.readFileSync(path.join(repositoryRoot, 'popup.html'), 'utf8')
const savedWords = ['spider', 'clown', 'mice']
const clone = value => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(resolve => setImmediate(resolve))

function createElement() {
    const classes = new Set()
    const listeners = new Map()
    const attributes = new Map()
    return {
        children: [],
        disabled: false,
        hidden: false,
        value: '',
        textWrites: 0,
        get textContent() { return this.text ?? '' },
        set textContent(value) { this.text = value; this.textWrites += 1 },
        dataset: {},
        setAttribute(name, value) { attributes.set(name, String(value)) },
        getAttribute(name) { return attributes.get(name) ?? null },
        style: { setProperty() {} },
        classList: {
            add: value => classes.add(value),
            remove: value => classes.delete(value),
            contains: value => classes.has(value),
            toggle(value, enabled) {
                if (enabled) classes.add(value)
                else classes.delete(value)
            },
        },
        set innerHTML(value) {
            this.html = value
            this.children = []
        },
        appendChild(child) { this.children.push(child) },
        addEventListener(type, listener) { listeners.set(type, listener) },
        dispatch(type, details = {}) {
            listeners.get(type)?.({ currentTarget: this, ...details })
        },
        querySelector() { return null },
    }
}

// Run production policy/storage/UI/popup scripts. Only the browser boundary is
// faked, including callback-scoped runtime.lastError and delayed storage reads.
function createPopup({ failStatusRead = false, deferWrites = false, url = 'https://example.com/', initialSettings = {} } = {}) {
    const elements = new Map()
    for (const [tag, id] of popupHtml.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const element = createElement()
        element.disabled = /\bdisabled\b/.test(tag)
        elements.set(id, element)
    }
    for (const id of ['mode-smart', 'mode-always', 'mode-off', 'preview-toggle', 'cover-toggle', 'site-rule-select']) {
        if (!elements.has(id)) elements.set(id, createElement())
    }
    const persisted = { targetWords: [...savedWords], ...clone(initialSettings) }
    const writes = []
    const changeListeners = []
    const pendingWrites = []
    const pendingRefreshReads = []
    const pendingStatusReads = []
    let deferRefreshReads = false
    let deferStatusReads = false
    let initialRead
    let readCount = 0
    const runtime = { lastError: null, openOptionsPage() {} }
    const complete = (callback, values, error) => {
        runtime.lastError = error ? { message: error } : null
        callback(values)
        runtime.lastError = null
    }
    const context = vm.createContext({
        console: { error() {} },
        URL,
        setTimeout,
        clearTimeout,
        document: {
            body: createElement(),
            addEventListener() {},
            getElementById: id => elements.get(id),
            querySelectorAll: () => [],
            createElement,
            createTextNode: text => ({ textContent: text }),
        },
        chrome: {
            runtime,
            tabs: {
                query(query, callback) { callback([{ id: 1, url }]) },
                sendMessage(...args) { args.at(-1)({ words: [] }) },
            },
            storage: {
                onChanged: { addListener(listener) { changeListeners.push(listener) } },
                sync: {
                    get(keys, callback) {
                        const values = Object.fromEntries(keys
                            .filter(key => persisted[key] !== undefined)
                            .map(key => [key, clone(persisted[key])]))
                        if (readCount++ === 0) {
                            initialRead = error => complete(callback, values, error)
                        } else if (deferRefreshReads && keys.length < 9) {
                            pendingRefreshReads.push(error => complete(callback, values, error))
                        } else if (deferStatusReads && keys.length > 9) {
                            pendingStatusReads.push(error => complete(callback, values, error))
                        } else {
                            complete(callback, values, failStatusRead && keys.length > 9
                                ? 'Status read unavailable' : null)
                        }
                    },
                    set(values, callback) {
                        const candidate = clone(values)
                        writes.push(candidate)
                        const finish = error => {
                            if (!error) Object.assign(persisted, candidate)
                            complete(callback, undefined, error)
                        }
                        if (deferWrites) pendingWrites.push(finish)
                        else finish()
                    },
                },
            },
        },
    })
    for (const file of ['shared-policy.js', 'storage.js', 'settings-ui.js', 'popup.js']) {
        vm.runInContext(fs.readFileSync(path.join(repositoryRoot, 'js', file), 'utf8'), context, { filename: file })
    }
    const initialized = context.initializePopup()
    return {
        elements,
        persisted,
        writes,
        reportAnalysis: response => context.renderDetectedWords(response),
        addWord: word => context.addTag(word),
        removeWord: index => context.removeTag(index),
        async finishInitialRead(error) {
            initialRead(error)
            await initialized
        },
        finishWrite(error) { pendingWrites.shift()(error) },
        deferRefreshReads() { deferRefreshReads = true },
        async finishRefreshRead(index = 0, error) {
            pendingRefreshReads.splice(index, 1)[0](error)
            await settle()
        },
        deferStatusReads() { deferStatusReads = true },
        async finishStatusRead(index = 0, error) {
            pendingStatusReads.splice(index, 1)[0](error)
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

function assertWordControlsDisabled(popup, disabled) {
    assert.equal(popup.elements.get('word-input').disabled, disabled, 'word input availability')
    assert.equal(popup.elements.get('addTagBtn').disabled, disabled, 'add button availability')
    for (const tag of popup.elements.get('tags-container').children) {
        assert.equal(tag.children[1].disabled, disabled, 'remove button availability')
    }
}

test('pending initial storage read cannot overwrite saved words through add or remove', async () => {
    const popup = createPopup()
    await popup.addWord('snake')
    await popup.removeWord(0)
    assert.deepEqual(popup.writes, [])
    assert.deepEqual(popup.persisted.targetWords, savedWords)
    await popup.finishInitialRead()
})

test('word controls stay disabled while initial settings are loading', async () => {
    const popup = createPopup()
    assertWordControlsDisabled(popup, true)
    await popup.finishInitialRead()
    assertWordControlsDisabled(popup, false)
})

test('failed initial Chrome storage read leaves existing words intact and mutations guarded', async () => {
    const popup = createPopup()
    await popup.finishInitialRead('Storage unavailable')
    await popup.addWord('snake')
    await popup.removeWord(0)
    assert.deepEqual(popup.writes, [])
    assert.deepEqual(popup.persisted.targetWords, savedWords)
    assertWordControlsDisabled(popup, true)
    assert.equal(popup.elements.get('word-error').hidden, false)
})

test('partial storage changes after an initial read failure cannot enable word edits', async () => {
    const popup = createPopup()
    await popup.finishInitialRead('Storage unavailable')
    await popup.change({ targetWords: ['wasp'], phobiaBlockerEnabled: false })
    await popup.addWord('snake')
    await popup.removeWord(0)
    assert.deepEqual(popup.writes, [])
    assert.deepEqual(popup.persisted.targetWords, ['wasp'])
    assertWordControlsDisabled(popup, true)
})

test('successful initialization appends to and removes from the saved word list', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    popup.elements.get('word-input').value = ' Snake '
    popup.elements.get('addTagBtn').dispatch('click')
    await settle()
    assert.deepEqual(popup.persisted.targetWords, ['spider', 'clown', 'mice', 'snake'])
    popup.elements.get('tags-container').children[1].children[1].dispatch('click')
    await settle()
    assert.deepEqual(popup.persisted.targetWords, ['spider', 'mice', 'snake'])
    assertWordControlsDisabled(popup, false)
})

test('site-status read failure does not invalidate successfully loaded trigger words', async () => {
    const popup = createPopup({ failStatusRead: true })
    await popup.finishInitialRead()
    await popup.addWord('snake')
    assert.deepEqual(popup.persisted.targetWords, ['spider', 'clown', 'mice', 'snake'])
    assertWordControlsDisabled(popup, false)
})

test('a live word update during initialization is retained by the first popup write', async () => {
    const popup = createPopup()
    await popup.change({ targetWords: ['spider', 'clown', 'mice', 'wasp'] })
    await popup.addWord('snake')
    assert.deepEqual(popup.writes, [])
    assertWordControlsDisabled(popup, true)
    await popup.finishInitialRead()
    await popup.addWord('snake')
    assert.deepEqual(popup.persisted.targetWords, ['spider', 'clown', 'mice', 'wasp', 'snake'])
})

test('an in-flight failed word write blocks further mutations and preserves the loaded list', async () => {
    const popup = createPopup({ deferWrites: true })
    await popup.finishInitialRead()
    const adding = popup.addWord('snake')
    await popup.addWord('wasp')
    await popup.removeWord(0)
    assert.equal(popup.writes.length, 1)
    assertWordControlsDisabled(popup, true)
    popup.finishWrite('Write unavailable')
    await adding
    assert.deepEqual(popup.persisted.targetWords, savedWords)
    assertWordControlsDisabled(popup, false)

    const removing = popup.removeWord(0)
    popup.finishWrite()
    await removing
    assert.deepEqual(popup.persisted.targetWords, ['clown', 'mice'])
})

test('out-of-order word refreshes cannot erase newer words on the next edit', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    popup.deferRefreshReads()
    await popup.change({ targetWords: ['spider', 'wasp'] })
    await popup.change({ targetWords: ['spider', 'wasp', 'snake'] })
    await popup.finishRefreshRead(1)
    await popup.finishRefreshRead(0)
    await popup.addWord('clown')
    assert.deepEqual(popup.persisted.targetWords, ['spider', 'wasp', 'snake', 'clown'])
})

test('overlapping popup refreshes retain unrelated keys from the earlier response', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    popup.deferRefreshReads()
    await popup.change({ targetWords: ['spider', 'wasp'], phobiaBlockerEnabled: false })
    await popup.change({ phobiaBlockerEnabled: true })
    await popup.finishRefreshRead(1)
    await popup.finishRefreshRead(0)
    assert.equal(popup.elements.get('mode-smart').getAttribute('aria-pressed'), 'true')
    await popup.addWord('snake')
    assert.deepEqual(popup.persisted.targetWords, ['spider', 'wasp', 'snake'])
})

test('an older site-status response cannot replace a newer protection status', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    popup.deferStatusReads()
    await popup.change({ phobiaBlockerEnabled: false })
    await popup.change({ phobiaBlockerEnabled: true })
    await popup.finishStatusRead(1)
    await popup.finishStatusRead(0)
    assert.equal(popup.elements.get('site-status-title').textContent, 'Automatic protection on')
    assert.equal(popup.elements.get('mode-smart').getAttribute('aria-pressed'), 'true')
    assert.equal(popup.persisted.phobiaBlockerEnabled, true)
})

test('an older site-status read failure cannot replace a newer successful status', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    popup.deferStatusReads()
    await popup.change({ phobiaBlockerEnabled: false })
    await popup.change({ phobiaBlockerEnabled: true })
    await popup.finishStatusRead(1)
    await popup.finishStatusRead(0, 'Status read unavailable')
    assert.equal(popup.elements.get('site-status-title').textContent, 'Automatic protection on')
})

test('out-of-order site-rule status reads retain the newer rule removal', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    popup.deferStatusReads()
    await popup.change({ whitelistedSites: ['example.com'] })
    await popup.change({ whitelistedSites: [] })
    await popup.finishStatusRead(1)
    await popup.finishStatusRead(0)
    assert.equal(popup.elements.get('site-status-title').textContent, 'Automatic protection on')
})

test('a newer setting change invalidates old status reads before its refresh finishes', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    popup.deferStatusReads()
    await popup.change({ phobiaBlockerEnabled: false })
    popup.deferRefreshReads()
    await popup.change({ phobiaBlockerEnabled: true })
    await popup.finishStatusRead(0)
    assert.equal(popup.elements.get('site-status-title').textContent, 'Automatic protection on')
    await popup.finishRefreshRead()
    await popup.finishStatusRead()
    assert.equal(popup.elements.get('site-status-title').textContent, 'Automatic protection on')
})

test('status reads cannot reset the saved preference used after a failed write', async () => {
    const popup = createPopup({ deferWrites: true })
    await popup.finishInitialRead()
    popup.deferStatusReads()
    await popup.change({ phobiaBlockerEnabled: false })
    const preview = popup.elements.get('preview-toggle')
    preview.dispatch('click')
    popup.finishWrite()
    await settle()
    await popup.finishStatusRead()

    preview.dispatch('click')
    popup.finishWrite('Write unavailable')
    await settle()
    assert.equal(preview.getAttribute('aria-pressed'), 'false')
    assert.equal(popup.persisted.previewEnabled, false)
})

test('word add/remove during a refresh cannot overwrite remote words or discard input', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    popup.deferRefreshReads()
    await popup.change({ targetWords: ['spider', 'wasp'] })
    popup.elements.get('word-input').value = 'snake'
    await popup.addWord('snake')
    await popup.removeWord(0)
    assert.deepEqual(popup.writes, [])
    assert.deepEqual(popup.persisted.targetWords, ['spider', 'wasp'])
    assert.equal(popup.elements.get('word-input').value, 'snake')
    assertWordControlsDisabled(popup, true)

    await popup.finishRefreshRead()
    assertWordControlsDisabled(popup, false)
    await popup.addWord('snake')
    await popup.removeWord(0)
    assert.deepEqual(popup.persisted.targetWords, ['wasp', 'snake'])
})

test('word refresh failure blocks edits through unrelated successes until a newer word read succeeds', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    popup.deferRefreshReads()
    await popup.change({ targetWords: ['spider', 'wasp'] })
    await popup.change({ phobiaBlockerEnabled: false })
    await popup.finishRefreshRead(1)
    assertWordControlsDisabled(popup, true)
    await popup.finishRefreshRead(0, 'Storage unavailable')
    await popup.change({ phobiaBlockerEnabled: true })
    await popup.finishRefreshRead()
    popup.elements.get('word-input').value = 'snake'
    await popup.addWord('snake')
    await popup.removeWord(0)
    assert.deepEqual(popup.writes, [])
    assert.deepEqual(popup.persisted.targetWords, ['spider', 'wasp'])
    assert.equal(popup.elements.get('word-input').value, 'snake')
    assertWordControlsDisabled(popup, true)
    assert.equal(popup.elements.get('word-error').hidden, false)

    await popup.change({ targetWords: ['spider', 'wasp', 'clown'] })
    await popup.finishRefreshRead()
    assertWordControlsDisabled(popup, false)
    await popup.addWord('snake')
    assert.deepEqual(popup.persisted.targetWords, ['spider', 'wasp', 'clown', 'snake'])
})

test('a newer successful word refresh releases edits despite an older pending read and failure', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    popup.deferRefreshReads()
    await popup.change({ targetWords: ['spider'] })
    await popup.change({ targetWords: ['spider', 'wasp'] })
    assertWordControlsDisabled(popup, true)
    await popup.finishRefreshRead(1)
    assertWordControlsDisabled(popup, false)
    await popup.finishRefreshRead(0, 'Old read unavailable')
    assertWordControlsDisabled(popup, false)
    await popup.addWord('snake')
    assert.deepEqual(popup.persisted.targetWords, ['spider', 'wasp', 'snake'])
})

test('mode tiles save both flags together and keep the selected policy unambiguous', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    for (const [mode, expected] of [
        ['always', { phobiaBlockerEnabled: true, blurIsAlwaysOn: true }],
        ['off', { phobiaBlockerEnabled: false, blurIsAlwaysOn: false }],
        ['smart', { phobiaBlockerEnabled: true, blurIsAlwaysOn: false }],
    ]) {
        popup.elements.get(`mode-${mode}`).dispatch('click')
        await settle()
        assert.deepEqual(popup.writes.at(-1), expected)
        assert.equal(popup.elements.get(`mode-${mode}`).getAttribute('aria-pressed'), 'true')
    }
})

test('cover and hover rows persist independently and failed writes retain the saved choice', async () => {
    const popup = createPopup({ deferWrites: true })
    await popup.finishInitialRead()
    popup.elements.get('preview-toggle').dispatch('click')
    assert.deepEqual(popup.writes, [{ previewEnabled: false }])
    assert.equal(popup.elements.get('preview-toggle').disabled, true)
    popup.elements.get('preview-toggle').dispatch('click')
    assert.equal(popup.writes.length, 1)
    popup.finishWrite('Storage unavailable')
    await settle()
    assert.equal(popup.elements.get('preview-toggle').getAttribute('aria-pressed'), 'true')
    popup.elements.get('cover-toggle').dispatch('click')
    assert.deepEqual(popup.writes.at(-1), { wordCoverEnabled: false })
    popup.finishWrite()
    await settle()
    assert.equal(popup.elements.get('cover-toggle').getAttribute('aria-pressed'), 'false')
    assert.equal(popup.elements.get('preview-toggle').getAttribute('aria-pressed'), 'true')
})

test('a pending or failed preference refresh blocks stale toggle writes', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    popup.deferRefreshReads()
    await popup.change({ previewEnabled: false })
    popup.elements.get('preview-toggle').dispatch('click')
    assert.deepEqual(popup.writes, [])
    assert.equal(popup.elements.get('preview-toggle').disabled, true)
    await popup.finishRefreshRead(0, 'Storage unavailable')
    popup.elements.get('preview-toggle').dispatch('click')
    assert.deepEqual(popup.writes, [])
    await popup.change({ previewEnabled: false })
    await popup.finishRefreshRead()
    popup.elements.get('preview-toggle').dispatch('click')
    await settle()
    assert.deepEqual(popup.writes.at(-1), { previewEnabled: true })
})

test('domain rule edits retain unrelated and inherited rules and respect always-blur precedence', async () => {
    const popup = createPopup({
        url: 'https://news.example.com/article',
        initialSettings: { blacklistedSites: ['example.com', 'photos.test'], whitelistedSites: ['safe.test'] },
    })
    await popup.finishInitialRead()
    const select = popup.elements.get('site-rule-select')
    select.value = 'off'
    select.dispatch('change')
    await settle()
    assert.deepEqual(popup.persisted.blacklistedSites, ['example.com', 'photos.test'])
    assert.deepEqual(popup.persisted.whitelistedSites, ['safe.test', 'news.example.com'])
    assert.equal(popup.elements.get('site-status-title').textContent, 'Always blur is on')
    select.value = 'default'
    select.dispatch('change')
    await settle()
    assert.deepEqual(popup.persisted.whitelistedSites, ['safe.test'])
    assert.deepEqual(popup.persisted.blacklistedSites, ['example.com', 'photos.test'])
})

test('unsupported pages disable page actions and site rules while keeping global preferences editable', async () => {
    const popup = createPopup({ url: 'chrome://extensions/' })
    await popup.finishInitialRead()
    assert.equal(popup.elements.get('site-rule-select').disabled, true)
    assert.equal(popup.elements.get('blurBtn').disabled, true)
    assert.equal(popup.elements.get('unblurBtn').disabled, true)
    assert.equal(popup.elements.get('preview-toggle').disabled, false)
    popup.elements.get('preview-toggle').dispatch('click')
    await settle()
    assert.deepEqual(popup.writes.at(-1), { previewEnabled: false })
})

test('unchanged analysis polling does not rewrite the accessible live status', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    const title = popup.elements.get('site-status-title')
    const reason = popup.elements.get('site-status-reason')
    const before = [title.textWrites, reason.textWrites]
    popup.reportAnalysis({ words: [] })
    popup.reportAnalysis({ words: [] })
    assert.deepEqual([title.textWrites, reason.textWrites], before)
    popup.reportAnalysis({ words: [{ word: 'spider' }] })
    assert.equal(reason.textWrites, before[1] + 1)
})

test('recovered popup refresh clears only its stale error', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    popup.deferRefreshReads()
    await popup.change({ previewEnabled: false })
    await popup.finishRefreshRead(0, 'Storage unavailable')
    assert.equal(popup.elements.get('word-error').hidden, false)
    await popup.change({ previewEnabled: true })
    await popup.finishRefreshRead()
    assert.equal(popup.elements.get('word-error').hidden, true)

    await popup.change({ previewEnabled: false })
    await popup.finishRefreshRead(0, 'Storage unavailable')
    await popup.addWord('!')
    assert.match(popup.elements.get('word-error').textContent, /Use at least three letters/)
    await popup.change({ previewEnabled: true })
    await popup.finishRefreshRead()
    assert.equal(popup.elements.get('word-error').textContent, 'Use at least three letters.')
    assert.equal(popup.elements.get('word-error').hidden, false)
})

test('an unrelated save keeps the recovery warning while failed keys remain locked', async () => {
    const popup = createPopup()
    await popup.finishInitialRead()
    popup.deferRefreshReads()
    await popup.change({ targetWords: ['wasp'] })
    await popup.finishRefreshRead(0, 'Storage unavailable')
    popup.elements.get('preview-toggle').dispatch('click')
    await settle()
    assertWordControlsDisabled(popup, true)
    assert.equal(popup.elements.get('word-error').hidden, false)
    assert.match(popup.elements.get('word-error').textContent, /remain locked/)
})
