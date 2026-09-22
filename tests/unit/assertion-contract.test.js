const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Execute the browser test's real callbacks with controlled browser responses.
// No browser is launched: these tests exercise the assertions, not extension DOM behavior.
async function loadBrowserCase(filename, name, page, helpers = {}, globals = {}) {
    const cases = new Map()
    const setup = []
    const noop = async () => {}
    const utilities = new Proxy({
        launchBrowserWithExtension: async () => ({ newPage: async () => page }),
        ...helpers,
    }, { get: (target, key) => target[key] || noop })
    const source = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8')
    vm.runInNewContext(source, {
        require: name => name === 'node:test' ? {
            describe: (_name, callback) => callback(),
            it: (name, callback) => cases.set(name, callback),
            before: callback => setup.push(callback),
            after: noop,
        } : name === './test-utils' ? utilities : require(name),
        setTimeout: callback => callback(),
        ...globals,
    }, { filename })
    assert.ok(cases.has(name), `Missing browser test: ${name}`)
    for (const callback of setup) await callback()
    return cases.get(name)
}

const validDebug = {
    pageAnalysisRequests: 3,
    mutationBatches: 5,
    directWordCovers: 4,
    mediaCount: 2,
    pageWordCount: 35,
    policyGeneration: 2,
    protectionMode: 'ANALYZE',
}

async function runAnalysisCase(name, { before = validDebug, after = before, afterChurn = after, responseError, tabs } = {}) {
    let evaluations = 0
    let phase = 'before'
    let now = 0
    const mediaCase = name.includes('media analysis')
    const safeInsertion = name === 'analyzes dynamically added safe text once and keeps it stable'
    const targetInsertion = name === 'covers dynamically added target text once without cycling'
    const page = {
        setDefaultTimeout() {},
        url: () => 'file:///assertion-contract.html',
        waitForFunction: async () => {},
        evaluate: async () => {
            evaluations++
            if (evaluations === (mediaCase ? 2 : 1)) phase = 'after'
            if (safeInsertion) {
                if (evaluations === 2) return 4
                if (evaluations === 3) phase = 'afterChurn'
                return { coverCount: 4 }
            }
            if (targetInsertion) {
                if (evaluations === 2) phase = 'afterChurn'
                return { dynamicCoverCount: 1 }
            }
            return { coverCount: 4, pending: false }
        },
    }
    const chrome = {
        runtime: { lastError: null },
        tabs: {
            query: (_query, callback) => callback(tabs || [{ id: 1, url: page.url() }]),
            sendMessage: (_id, _message, _options, callback) => {
                chrome.runtime.lastError = responseError ? { message: responseError } : null
                callback({ before, after, afterChurn }[phase])
                chrome.runtime.lastError = null
            },
        },
    }
    const body = await loadBrowserCase('attribute-lifecycle.test.js', name, page, {
        wait: async milliseconds => { now += milliseconds },
        getExtensionServiceWorker: async () => ({
            worker: async () => ({
                evaluate: async (callback, ...args) => vm.runInNewContext(`(${callback})(...args)`, { chrome, args }),
            }),
        }),
    }, { Date: { now: () => now } })
    return body()
}

for (const { name, beforeCovers, afterCovers } of [
    { name: 'analyzes dynamically added safe text once and keeps it stable', beforeCovers: 4, afterCovers: 4 },
    { name: 'covers dynamically added target text once without cycling', beforeCovers: 0, afterCovers: 1 },
]) {
    // word-cover.html has no media. The safe insertion retains existing matches;
    // the target insertion creates a match. Neither asks for a clear media verdict
    // that Controller.applyPageResult could defer for another stabilization pass.
    const before = { ...validDebug, mediaCount: 0, directWordCovers: beforeCovers }
    const after = { ...before, pageAnalysisRequests: 4, pageWordCount: 42, directWordCovers: afterCovers }

    test(`${name}: accepts one analysis with the expected direct covers`, async () => {
        await runAnalysisCase(name, { before, after })
    })

    test(`${name}: rejects missing analysis`, async () => {
        await assert.rejects(runAnalysisCase(name, { before, after: before }),
            /page analysis did not reach 4 requests/)
    })

    test(`${name}: rejects an excess analysis request`, async () => {
        await assert.rejects(runAnalysisCase(name, {
            before, after: { ...after, pageAnalysisRequests: 5 },
        }), /should trigger exactly one additional page analysis/)
    })

    test(`${name}: rejects another analysis after layout churn`, async () => {
        await assert.rejects(runAnalysisCase(name, {
            before, after, afterChurn: { ...after, pageAnalysisRequests: 5 },
        }), /should not be (?:re-)?analyzed again|should not be re-analyzed after unrelated churn/)
    })

    test(`${name}: rejects an excess direct cover`, async () => {
        await assert.rejects(runAnalysisCase(name, {
            before, after: { ...after, directWordCovers: afterCovers + 1 },
        }), /should not create direct word covers|should create exactly one direct word cover/)
    })
}

const noRerunCases = [
    'does not re-run analysis for unrelated DOM churn after stable state',
    'does not re-run media analysis for unrelated DOM churn after stable state',
]

for (const name of noRerunCases) {
    test(`${name}: accepts unchanged current counters`, async () => {
        await runAnalysisCase(name)
    })

    test(`${name}: rejects an extra page analysis request`, async () => {
        await assert.rejects(runAnalysisCase(name, {
            after: { ...validDebug, pageAnalysisRequests: 4 },
        }), /unchanged page text should not trigger another.*page analysis/)
    })

    test(`${name}: rejects missing and nonnumeric counters`, async () => {
        for (const pageAnalysisRequests of [undefined, '3', NaN, Infinity]) {
            await assert.rejects(runAnalysisCase(name, {
                before: { ...validDebug, pageAnalysisRequests },
            }), /pageAnalysisRequests should be a nonnegative integer/)
        }
    })

    test(`${name}: rejects a missing content-script response`, async () => {
        await assert.rejects(runAnalysisCase(name, { before: null }), /should return analysis debug state/)
    })

    test(`${name}: rejects a failed content-script response`, async () => {
        await assert.rejects(runAnalysisCase(name, { responseError: 'Receiving end does not exist' }),
            /Receiving end does not exist/)
    })

    test(`${name}: rejects a response from a different tab`, async () => {
        await assert.rejects(runAnalysisCase(name, { tabs: [{ id: 2, url: 'file:///other.html' }] }),
            /No tab found for analysis debug query/)
    })
}

async function runHandoffCase({ uncoveredFrames = 0, opaqueCover = true, hiddenText = true, blurred = false } = {}) {
    let frame = 0
    let target
    let install
    const listeners = new Map()
    const frames = []
    const rects = () => [{ width: 160, height: 20 }]
    const cover = { getClientRects: rects, textContent: 'spider' }
    const document = {
        body: { appendChild: element => { target = element } },
        createElement: () => ({
            getClientRects: rects,
            querySelector: () => frame > uncoveredFrames ? cover : null,
        }),
        querySelector: () => target,
    }
    const window = {
        addEventListener: (name, callback) => listeners.set(name, callback),
        getComputedStyle: element => ({
            display: 'block', visibility: 'visible', opacity: '1',
            color: element === cover && hiddenText ? 'rgba(0, 0, 0, 0)' : 'rgb(0, 0, 0)',
            webkitTextFillColor: element === cover && hiddenText ? 'rgba(0, 0, 0, 0)' : 'rgb(0, 0, 0)',
            backgroundColor: opaqueCover ? 'rgb(50, 50, 50)' : 'rgba(0, 0, 0, 0)',
            filter: blurred ? 'blur(7px)' : 'none', textShadow: 'none',
        }),
    }
    const context = vm.createContext({ window, document, requestAnimationFrame: callback => frames.push(callback) })
    const evaluate = (callback, ...args) => {
        context.args = args
        return vm.runInContext(`(${callback})(...args)`, context)
    }
    const page = {
        evaluateOnNewDocument: async callback => { install = callback },
        waitForFunction: async callback => {
            assert.ok(evaluate(callback), 'handoff monitor should reach the requested state')
        },
        evaluate: async callback => evaluate(callback),
    }
    const body = await loadBrowserCase('flash-prevention.test.js',
        'should cover words inserted during handoff without CSS-blurring them', page, {
            loadTestPage: async () => {
                evaluate(install)
                listeners.get('phobiablocker:word-cover-manager-ready')()
                while (frames.length && frame < 120) {
                    frame++
                    frames.shift()()
                }
            },
        })
    await body()
    return window.__phobiaHandoffWordCoverState
}

test('handoff monitor accepts a protected first rendered frame', async () => {
    await runHandoffCase()
})

test('handoff monitor rejects 20 visible frames before eventual covering', async () => {
    await assert.rejects(runHandoffCase({ uncoveredFrames: 20 }), error => {
        assert.match(error.message, /never appear uncovered in a rendered frame/)
        assert.equal(error.actual, 20)
        assert.equal(error.expected, 0)
        return true
    })
})

test('handoff monitor rejects a cover class whose text remains readable', async () => {
    await assert.rejects(runHandoffCase({ hiddenText: false }), /should have hidden text and an opaque cover/)
})

test('handoff monitor rejects a transparent cover background', async () => {
    await assert.rejects(runHandoffCase({ opaqueCover: false }), /should have hidden text and an opaque cover/)
})

test('handoff monitor rejects CSS blur even when the cover is already present', async () => {
    await assert.rejects(runHandoffCase({ blurred: true }), /should not be CSS-blurred/)
})
