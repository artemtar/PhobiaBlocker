// Clearance retention: after a committed clear verdict, media that did not change
// may stay revealed while a re-analysis is pending. These suites pin the limit of
// that rule: any new vocabulary drops the clearance, because only the offscreen
// analyser can tell whether a new word is an inflection of a trigger.
const assert = require('node:assert/strict')
const test = require('node:test')
const { createContentHarness } = require('./helpers/content-harness')

const clean = { shouldBlur: false, matchedWords: [], matchedInputWords: [] }

// A page whose clear verdict has been committed: the image was analysed,
// released and recorded as cleared media at the current URL.
function clearedPageFixture() {
    const env = createContentHarness()
    // Covers off so the suite observes media alone.
    const settings = { ...env.Policy.DEFAULTS, targetWords: ['spider'], wordCoverEnabled: false }
    env.controller.mode = 'ANALYZE'
    env.controller.setSettings(settings)
    env.controller._wordCoverManager.configure(settings, 'ANALYZE')
    const image = env.image()
    image.setAttribute('src', 'safe.jpg')
    env.body.appendChild(env.document.createTextNode('ordinary text'))
    env.controller._pageTextIndex.build(env.body)
    env.controller._registerMedia(env.document)
    // A clear verdict is deferred while the page may still be producing text:
    // word count changed since the last verdict, or the document still loading.
    // Satisfying both lets applyPageResult commit this first clear verdict at once.
    env.document.readyState = 'complete'
    env.controller._lastVerdictWordCount = env.controller._pageTextIndex.wordCount
    env.controller.applyPageResult(clean)
    assert.equal(image.style.getPropertyValue('filter'), 'none', 'the fixture must start from a released image')
    assert.equal(env.controller._analysisPending, false)
    return { ...env, image }
}

function insertText(env, value) {
    const text = env.body.appendChild(env.document.createTextNode(value))
    env.controller._handleMutations([{ type: 'childList', target: env.body, addedNodes: [text], removedNodes: [] }])
}

// 'spiders' is not in targetWords: a literal check in the content script would
// keep the image revealed while the analyser is about to match the plural.
for (const word of ['spider', 'spiders']) {
    test(`new vocabulary "${word}" re-blurs cleared media while the verdict is pending`, () => {
        const env = clearedPageFixture()

        insertText(env, `look, ${word}!`)

        assert.equal(env.controller._analysisPending, true, 'new vocabulary must schedule analysis')
        assert.match(env.image.style.getPropertyValue('filter'), /^blur\(/,
            'the content script cannot judge inflections, so a cleared image must not stay revealed')
    })
}

// Runs the debounced analysis timer and holds the offscreen reply so the test
// can observe the page during the round trip. The timer callback awaits that
// reply, so it must not be awaited before the reply is released.
async function beginAnalysisRound(env) {
    let resolveAnalysis = null
    env.context.chrome.runtime.sendMessage = message => {
        if (message.type !== 'PB_ANALYZE_WORDS') return Promise.resolve({ ok: true })
        return new Promise(resolve => { resolveAnalysis = resolve })
    }
    // 200 ms is ANALYSIS_DEBOUNCE_MS. runTimers would await the callback and
    // deadlock on the held reply, so the timer is taken and started by hand.
    const [id, analysisTimer] = [...env.timers].find(([, timer]) => timer.delay === 200) || []
    assert.ok(analysisTimer, 'a debounced analysis must be scheduled')
    env.timers.delete(id)
    const analysis = analysisTimer.callback()
    await env.settle()
    assert.ok(resolveAnalysis, 'the analysis must have been requested from the offscreen document')
    return { analysis, resolveAnalysis }
}

test('new vocabulary keeps cleared media blurred until the next clear verdict is committed', async () => {
    const env = clearedPageFixture()

    insertText(env, 'spiders')
    const first = await beginAnalysisRound(env)
    assert.match(env.image.style.getPropertyValue('filter'), /^blur\(/, 'blurred during the offscreen round trip')
    first.resolveAnalysis({ ...clean })
    await first.analysis
    // The vocabulary changed since the last verdict, so the first clear reply
    // is deferred and the page is analysed once more before anything is released.
    assert.match(env.image.style.getPropertyValue('filter'), /^blur\(/, 'a deferred clear verdict releases nothing')

    const second = await beginAnalysisRound(env)
    second.resolveAnalysis({ ...clean })
    await second.analysis
    assert.equal(env.image.style.getPropertyValue('filter'), 'none', 'a committed clear verdict releases the image again')
})

test('an unrelated attribute mutation keeps cleared media released', () => {
    const env = clearedPageFixture()
    const aside = env.body.appendChild(env.document.createElement('aside'))

    aside.setAttribute('class', 'expanded')
    env.controller._handleMutations([{
        type: 'attributes', target: aside, attributeName: 'class', oldValue: null,
    }])

    assert.equal(env.controller._analysisPending, false, 'no vocabulary changed, so nothing is re-analysed')
    assert.equal(env.image.style.getPropertyValue('filter'), 'none')
})

test('an image class change without new vocabulary keeps the cleared image released', () => {
    const env = clearedPageFixture()

    env.image.setAttribute('class', 'loaded')
    env.controller._handleMutations([{
        type: 'attributes', target: env.image, attributeName: 'class', oldValue: null,
    }])

    assert.equal(env.controller._analysisPending, false)
    assert.equal(env.image.style.getPropertyValue('filter'), 'none')
})
