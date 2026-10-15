// Parent side of the per-iframe clearance tickets (js/frame-clearance.js). A
// cross-origin iframe is released on its own only when the service worker armed
// the parent with a token, the child's window posted that token and the worker
// confirmed it; each suite removes one link of that chain.
const assert = require('node:assert/strict')
const test = require('node:test')
const { createContentHarness } = require('./helpers/content-harness')

// Must have the crypto.randomUUID() v4 shape; anything else is dropped unread.
const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function fixture() {
    const env = createContentHarness()
    const c = env.controller
    // A committed clear verdict without running analysis: in ANALYZE with nothing
    // pending, only keepCrossOriginIframesBlurred and the frame aggregate still
    // keep a cross-origin iframe blurred.
    c.mode = env.Policy.PROTECTION_MODE.ANALYZE
    c._analysisPending = false
    c._pageAnalysisResult = { shouldBlur: false, matchedWords: [], matchedInputWords: [] }
    c.settings.keepCrossOriginIframesBlurred = true
    // Registers a cross-origin iframe (its src origin differs from the page, so
    // isCrossOriginIframe sends it down the frame protocol) and records that src as
    // the loaded document, so no navigation is pending when a ticket arrives.
    // contentWindow is a distinct object because a ticket is matched by
    // event.source identity, never by URL.
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
    // No content script can run in a chrome-extension:// frame, so this sibling
    // never reports clear and the worker's aggregate answer stays `clear: false`.
    const unknown = frame('chrome-extension://unavailable/helper.html')
    // Delivers a runtime message to the content listener the way the worker would.
    const message = value => {
        let response
        env.messages.forEach(listener => listener(value, {}, result => { response = result }))
        return response
    }
    // The child's PB_FRAME_CLEARANCE_LINK as a trusted window message from the
    // iframe's own window; stopImmediatePropagation is stubbed because _receive calls it.
    const link = (element = checked, overrides = {}) => env.window.dispatchEvent({
        type: 'message', isTrusted: true, source: element.contentWindow,
        data: { type: 'PB_FRAME_CLEARANCE_LINK', token },
        stopImmediatePropagation() {}, ...overrides,
    })
    // Plays the worker's whole sequence inside the aggregate request: arm the
    // parent, let the child post its token, then reply with the confirmed tokens,
    // all before _refreshFrameAggregate resumes and calls approve().
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

// approve() with a ticket nobody linked clears nothing; the link arriving later
// completes the release because the ticket is already marked approved.
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
    // Bumps the epoch and resets the ticket table; the old token is now unknown.
    env.controller._invalidateFrameAggregate({ refresh: false })
    env.link()
    assert.match(filter(env.checked), /^blur\(/)
})
