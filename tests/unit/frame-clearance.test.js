const assert = require('node:assert/strict')
const test = require('node:test')
const { createContentHarness } = require('./helpers/content-harness')

const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function fixture() {
    const env = createContentHarness()
    const c = env.controller
    c.mode = env.Policy.PROTECTION_MODE.ANALYZE
    c._analysisPending = false
    c._pageAnalysisResult = { shouldBlur: false, matchedWords: [], matchedInputWords: [] }
    c.settings.keepCrossOriginIframesBlurred = true
    const frame = (source) => {
        const element = env.body.appendChild(new env.context.HTMLIFrameElement())
        element.setAttribute('src', source)
        element.contentWindow = {}
        c._registerMedia(element)
        c._markIframeNavigationComplete(element)
        c._applyResultToNode(c.getVisualNode(element), c._pageAnalysisResult)
        return element
    }
    const checked = frame('https://editor.example/document')
    const unknown = frame('chrome-extension://unavailable/helper.html')
    const message = value => {
        let response
        env.messages.forEach(listener => listener(value, {}, result => { response = result }))
        return response
    }
    const link = (element = checked, overrides = {}) => env.window.dispatchEvent({
        type: 'message', isTrusted: true, source: element.contentWindow,
        data: { type: 'PB_FRAME_CLEARANCE_LINK', token },
        stopImmediatePropagation() {}, ...overrides,
    })
    const request = ({ emit = () => link(), afterArm = () => {}, responseTokens = [token] } = {}) => {
        env.context.chrome.runtime.sendMessage = async value => {
            if (value.type !== 'PB_FRAME_AGGREGATE_REQUEST') return {}
            message({ type: 'PB_FRAME_CLEARANCE_ARM', epoch: value.epoch, tokens: [token] })
            afterArm()
            emit()
            return { ok: true, clear: false, epoch: value.epoch, clearTokens: responseTokens }
        }
        return c._refreshFrameAggregate()
    }
    return { ...env, checked, unknown, message, link, request }
}

const filter = element => element.style.getPropertyValue('filter')

test('a verified clear iframe is readable beside an unavailable sibling which stays blurred', async () => {
    const env = fixture()
    await env.request()
    assert.equal(filter(env.checked), 'none')
    assert.match(filter(env.unknown), /^blur\(/)
    assert.equal(env.controller._frameAggregateClear, false, 'the full-page aggregate stays conservative')
})

test('a returned ticket cannot release a frame without its actual window message', async () => {
    const env = fixture()
    await env.request({ emit() {} })
    assert.match(filter(env.checked), /^blur\(/)
    env.link()
    assert.equal(filter(env.checked), 'none', 'a delayed identity message can complete the same verified transaction')
})

test('matching URLs do not transfer clearance to another iframe owner', async () => {
    const env = fixture()
    env.unknown.setAttribute('src', env.checked.getAttribute('src'))
    await env.request()
    assert.equal(filter(env.checked), 'none')
    assert.match(filter(env.unknown), /^blur\(/)
})

test('an aggregate invalidation revokes individual clearance and rejects its old ticket', async () => {
    const env = fixture()
    await env.request()
    assert.equal(filter(env.checked), 'none')
    env.controller._invalidateFrameAggregate({ refresh: false })
    env.link()
    assert.match(filter(env.checked), /^blur\(/)
})
