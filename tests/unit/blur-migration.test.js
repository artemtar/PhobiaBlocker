const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const repositoryRoot = path.resolve(__dirname, '../..')
const clone = value => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(resolve => setImmediate(resolve))
const PIXEL_TOLERANCE = 0.5

// The curve every release before 1.3.1 rendered: slider 50 gave 30px.
function legacyBlurPixels(sliderValue) {
    return Math.pow(sliderValue * 0.09, 1.8) * 2
}

function loadPolicy() {
    const context = vm.createContext({})
    vm.runInContext(fs.readFileSync(path.join(repositoryRoot, 'js', 'shared-policy.js'), 'utf8'), context)
    return context.PhobiaBlockerPolicy
}

function browserEvent() {
    const listeners = []
    return {
        addListener(listener) { listeners.push(listener) },
        emit(...args) { listeners.forEach(listener => listener(...args)) },
    }
}

const fullyStoredSettings = Object.freeze({
    targetWords: ['spider'],
    phobiaBlockerEnabled: true,
    blurIsAlwaysOn: false,
    wordCoverEnabled: true,
    blurValueAmount: 50,
    previewEnabled: true,
    previewBlurStrength: 5,
    whitelistedSites: [],
    blacklistedSites: [],
    keepCrossOriginIframesBlurred: true,
    debugMode: false,
    detectedWordsCollapsed: false,
    supportedWordsCollapsed: false,
})

function loadBackground({ stored = fullyStoredSettings, readError = null } = {}) {
    const writes = []
    const errors = []
    const runtime = {
        lastError: null,
        onInstalled: browserEvent(),
        onMessage: browserEvent(),
        getURL: value => `chrome-extension://test/${value}`,
    }
    const chrome = {
        runtime,
        webNavigation: Object.fromEntries([
            'onBeforeNavigate', 'onCommitted', 'onErrorOccurred',
            'onHistoryStateUpdated', 'onReferenceFragmentUpdated',
        ].map(name => [name, browserEvent()])),
        storage: {
            onChanged: browserEvent(),
            sync: {
                get(keys, callback) {
                    const names = Array.isArray(keys) ? keys : [keys]
                    if (readError && names.includes('blurValueAmount')) {
                        runtime.lastError = { message: readError }
                        callback(undefined)
                        runtime.lastError = null
                        return
                    }
                    const values = {}
                    for (const name of names) {
                        if (stored[name] !== undefined) values[name] = clone(stored[name])
                    }
                    callback(values)
                },
                set(values, callback) {
                    writes.push(clone(values))
                    callback()
                },
            },
        },
        tabs: { onRemoved: browserEvent(), sendMessage: () => Promise.resolve({ ok: true }) },
        contextMenus: {
            onClicked: browserEvent(),
            removeAll(callback) { callback() },
            create(_, callback) { callback() },
        },
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
        console: { ...console, error: (...args) => errors.push(args) },
        crypto: require('node:crypto').webcrypto,
        URL,
        setTimeout,
        clearTimeout,
        importScripts(...files) { files.forEach(runScript) },
        fetch: async () => { throw new Error('Icon rendering is unavailable in Node') },
    })
    runScript('background.js')

    return {
        writes,
        errors,
        policy: context.PhobiaBlockerPolicy,
        async install(details) {
            runtime.onInstalled.emit(details)
            await settle()
            await settle()
        },
    }
}

function blurWrites(background) {
    return background.writes.filter(values => Object.prototype.hasOwnProperty.call(values, 'blurValueAmount'))
}

test('the legacy slider conversion preserves rendered pixels and keeps both ends in place', () => {
    const { convertLegacyBlurSliderValue, computeBlurPixels } = loadPolicy()
    assert.equal(convertLegacyBlurSliderValue(0), 0)
    assert.equal(convertLegacyBlurSliderValue(100), 100)
    for (const legacyValue of [25, 50, 75]) {
        const converted = convertLegacyBlurSliderValue(legacyValue)
        assert.ok(converted >= 0 && converted <= 100, `${legacyValue} converted out of range: ${converted}`)
        const difference = Math.abs(computeBlurPixels(converted) - legacyBlurPixels(legacyValue))
        assert.ok(difference <= PIXEL_TOLERANCE, `${legacyValue} -> ${converted} drifted ${difference}px`)
    }
})

test('the legacy slider conversion bounds out-of-range values and defaults invalid inputs', () => {
    const { convertLegacyBlurSliderValue, computeBlurPixels } = loadPolicy()
    assert.equal(convertLegacyBlurSliderValue(-5), 0)
    assert.equal(convertLegacyBlurSliderValue(150), 100)
    for (const value of [undefined, null, '50', NaN, Infinity]) {
        const difference = Math.abs(computeBlurPixels(convertLegacyBlurSliderValue(value)) - legacyBlurPixels(50))
        assert.ok(difference <= PIXEL_TOLERANCE, `${String(value)} did not fall back to the default strength`)
    }
})

test('updating from 1.3.0 rewrites a stored 50 so the page still renders about 30px', async () => {
    const background = loadBackground()
    await background.install({ reason: 'update', previousVersion: '1.3.0' })

    const writes = blurWrites(background)
    assert.equal(writes.length, 1, 'exactly one migration write')
    assert.deepEqual(Object.keys(writes[0]), ['blurValueAmount'])
    const pixels = background.policy.computeBlurPixels(writes[0].blurValueAmount)
    assert.ok(Math.abs(pixels - 30) <= PIXEL_TOLERANCE, `migrated value renders ${pixels}px`)
    assert.deepEqual(background.errors, [])
})

test('updating from 1.3.0 maps a slider at the maximum onto the new maximum', async () => {
    const background = loadBackground({ stored: { ...fullyStoredSettings, blurValueAmount: 100 } })
    await background.install({ reason: 'update', previousVersion: '1.3.0' })
    assert.deepEqual(blurWrites(background), [{ blurValueAmount: 100 }])
})

test('updating from 1.3.0 without a stored slider value keeps the legacy default strength', async () => {
    const { blurValueAmount, ...withoutBlur } = fullyStoredSettings
    void blurValueAmount
    const background = loadBackground({ stored: withoutBlur })
    await background.install({ reason: 'update', previousVersion: '1.3.0' })

    const writes = blurWrites(background)
    assert.equal(writes.length, 1)
    const pixels = background.policy.computeBlurPixels(writes[0].blurValueAmount)
    assert.ok(Math.abs(pixels - 30) <= PIXEL_TOLERANCE, `migrated default renders ${pixels}px`)
})

test('a fresh install never rewrites the blur strength', async () => {
    const background = loadBackground()
    await background.install({ reason: 'install' })
    assert.deepEqual(background.writes, [])
})

for (const previousVersion of ['1.3.1', '1.3.2', '1.4.0', '1.10.0', '2.0.0']) {
    test(`updating from ${previousVersion} leaves the already-migrated slider value alone`, async () => {
        const background = loadBackground()
        await background.install({ reason: 'update', previousVersion })
        assert.deepEqual(background.writes, [])
        assert.deepEqual(background.errors, [])
    })
}

test('an update without a readable previous version does not guess and leaves storage untouched', async () => {
    const background = loadBackground()
    await background.install({ reason: 'update' })
    await background.install({ reason: 'update', previousVersion: 'garbage' })
    await background.install({ reason: 'chrome_update' })
    assert.deepEqual(background.writes, [])
})

test('a failed storage read logs and leaves the stored slider value untouched', async () => {
    const background = loadBackground({ readError: 'Storage unavailable' })
    await background.install({ reason: 'update', previousVersion: '1.3.0' })
    assert.deepEqual(background.writes, [])
    assert.equal(background.errors.length, 1)
    assert.match(String(background.errors[0][0]), /blur/i)
})

test('an unreadable stored slider value logs and is left for the fail-closed readers', async () => {
    const background = loadBackground({ stored: { ...fullyStoredSettings, blurValueAmount: 'strong' } })
    await background.install({ reason: 'update', previousVersion: '1.3.0' })
    assert.deepEqual(background.writes, [])
    assert.equal(background.errors.length, 1)
})
