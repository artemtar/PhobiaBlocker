// CSS background images, not the service worker: an element whose subtree holds
// an editing surface has its background-image hidden instead of blurred, so a
// filter never blurs the text being typed. These suites check that the decision
// is re-evaluated only for the backgrounds above a changed surface, never page-wide.
const assert = require('node:assert/strict')
const test = require('node:test')
const { createContentHarness } = require('./helpers/content-harness')

const BACKGROUND = 'url("paper.jpg")'

function addBackground(env, parent = env.body) {
    const element = parent.appendChild(env.document.createElement('section'))
    element.style.setProperty('background-image', BACKGROUND)
    return element
}

// A cut-down enableProtection in ALWAYS_BLUR: shadow discovery, media
// registration, the full background scan and the text index, with no root
// projection, word covers, stylesheet watching or observers. The full scan
// registers every background, and each test then drives the controller's
// handlers directly from that known projected state.
function startProtection(env) {
    env.controller.mode = 'ALWAYS_BLUR'
    env.controller._discoverShadowRoots(env.document)
    env.controller._registerMedia(env.document)
    env.controller._scanBackgrounds(env.document, { full: true })
    env.controller._pageTextIndex.build(env.body)
}

// Counts containsEditingSurface calls per element. That check walks the whole
// subtree of a background element, so the counts are the work a change costs;
// zero for an unrelated element proves no page-wide re-evaluation happened.
function observeEditingChecks(env) {
    const checks = new Map()
    const Index = env.context.PhobiaBlockerPageTextIndex
    const original = Index.containsEditingSurface
    Index.containsEditingSurface = element => {
        checks.set(element, (checks.get(element) || 0) + 1)
        return original(element)
    }
    return checks
}

// The two projections of a registered background: blurred keeps the image under
// an inline filter; suppressed hides the image and leaves no filter, so a control
// inside stays readable.
function assertFiltered(element) {
    assert.equal(element.style.getPropertyValue('background-image'), BACKGROUND)
    assert.match(element.style.getPropertyValue('filter'), /^blur\(/)
}

function assertSuppressed(element) {
    assert.equal(element.style.getPropertyValue('background-image'), 'none')
    assert.equal(element.style.getPropertyValue('filter'), '')
}

// A component whose shadow tree has two background sections, each with a slot.
// The light-DOM `physical` background is assigned to one slot, so `control` inside
// it has a DOM ancestor (physical) and a rendered ancestor (left or right). The
// harness has no slot distribution, so assignedElements is stubbed per slot.
function slottedFixture() {
    const env = createContentHarness()
    const host = env.body.appendChild(env.document.createElement('div'))
    const root = host.attachShadow({ mode: 'open' })
    const left = addBackground(env, root)
    const right = addBackground(env, root)
    const leftSlot = left.appendChild(env.document.createElement('slot'))
    const rightSlot = right.appendChild(env.document.createElement('slot'))
    const physical = addBackground(env, host)
    const control = physical.appendChild(env.document.createElement('span'))
    physical.assignedSlot = leftSlot
    leftSlot.assignedElements = () => physical.assignedSlot === leftSlot ? [physical] : []
    rightSlot.assignedElements = () => physical.assignedSlot === rightSlot ? [physical] : []
    const unrelated = addBackground(env)
    return { ...env, root, left, right, leftSlot, rightSlot, physical, control, unrelated }
}

// slotchange is not composed; the controller listens on each shadow root, so the
// event is dispatched on the root with the slot as its target.
function slotChanged(env, slot) {
    env.root.dispatchEvent({ type: 'slotchange', target: slot, composedPath: () => [slot, env.root] })
}

test('moving a slotted editor restores its former background and suppresses its new background', () => {
    const env = slottedFixture()
    env.control.setAttribute('contenteditable', 'true')
    startProtection(env)
    assertSuppressed(env.left)
    assertFiltered(env.right)
    const checks = observeEditingChecks(env)

    env.physical.assignedSlot = env.rightSlot
    slotChanged(env, env.leftSlot)
    slotChanged(env, env.rightSlot)

    assertFiltered(env.left)
    assertSuppressed(env.right)
    assertSuppressed(env.physical)
    assertFiltered(env.unrelated)
    assert.equal(checks.get(env.unrelated) || 0, 0, 'slot changes must not inspect unrelated backgrounds')
})

// contenteditable makes the span itself editable; role="textbox" is matched by
// containsEditingSurface's ARIA selector. Both are attributes whose change the
// mutation handler treats as a possible editing-surface change.
for (const [attributeName, value] of [['contenteditable', 'true'], ['role', 'textbox']]) {
    test(`a slotted descendant's ${attributeName} change reaches both rendered and physical ancestors`, () => {
        const env = slottedFixture()
        startProtection(env)
        assertFiltered(env.left)
        assertFiltered(env.physical)
        const checks = observeEditingChecks(env)

        env.control.setAttribute(attributeName, value)
        env.controller._handleMutations([{ type: 'attributes', target: env.control, attributeName }])

        assertSuppressed(env.left)
        assertSuppressed(env.physical)
        assertFiltered(env.right)
        assertFiltered(env.unrelated)
        assert.equal(checks.get(env.right) || 0, 0)
        assert.equal(checks.get(env.unrelated) || 0, 0)

        env.control.removeAttribute(attributeName)
        env.controller._handleMutations([{ type: 'attributes', target: env.control, attributeName }])

        assertFiltered(env.left)
        assertFiltered(env.physical)
    })
}

// A same-origin iframe inside a background. The child document stub carries only
// what the editing checks read (body.isContentEditable, designMode); frameWindow
// links back through frameElement so editor-frames accepts the frame as owned.
// readyState 'loading' keeps the navigation guard from touching the bare window.
function iframeFixture() {
    const env = createContentHarness()
    const background = addBackground(env)
    const unrelated = addBackground(env)
    const frame = background.appendChild(new env.context.HTMLIFrameElement())
    const child = { body: { isContentEditable: false }, designMode: 'off', readyState: 'loading' }
    const frameWindow = { frameElement: frame, location: { href: 'about:blank' } }
    child.defaultView = frameWindow
    frame.contentWindow = frameWindow
    frame.contentDocument = child
    startProtection(env)
    return { ...env, background, unrelated, frame, child, frameWindow }
}

// The child controller dispatches editor-frame-ready when its document is ready
// to answer requests; the parent only hears that event, nothing in its DOM changes.
test('iframe editor readiness invalidates containing backgrounds without a parent DOM mutation', () => {
    const env = iframeFixture()
    const checks = observeEditingChecks(env)
    assertFiltered(env.background)

    for (const editable of [true, false]) {
        env.child.body.isContentEditable = editable
        // No bubbling in the harness: dispatched on the document, where editor-frames
        // listens, with the iframe first in composedPath as the browser would report.
        env.document.dispatchEvent({
            type: 'phobiablocker:editor-frame-ready', target: env.frame, composedPath: () => [env.frame],
        })
        if (editable) assertSuppressed(env.background)
        else assertFiltered(env.background)
    }

    assertFiltered(env.unrelated)
    assert.equal(checks.get(env.unrelated) || 0, 0)
})

// A navigation replaces contentDocument, so the old document's editing state must
// not be reused. isTrusted is required: the controller ignores synthetic load
// events a page script could dispatch.
test('iframe load reevaluates the replacement document rather than reusing its previous editing state', () => {
    const env = iframeFixture()
    const checks = observeEditingChecks(env)

    for (const designMode of ['on', 'off']) {
        env.frame.contentDocument = {
            body: { isContentEditable: false }, designMode, readyState: 'loading', defaultView: env.frameWindow,
        }
        env.document.dispatchEvent({
            type: 'load', isTrusted: true, target: env.frame, composedPath: () => [env.frame],
        })
        if (designMode === 'on') assertSuppressed(env.background)
        else assertFiltered(env.background)
    }

    assertFiltered(env.unrelated)
    assert.equal(checks.get(env.unrelated) || 0, 0)
})

// A child without the content script (disabled there, or none injected) never
// emits readiness, so the stylesheet poll also reads each known iframe's editing
// flag and invalidates only when it differs from the last reading.
for (const source of ['body editability', 'designMode']) {
    test(`polling detects iframe ${source} changes without child notifications`, () => {
        const env = iframeFixture()
        env.controller._startStylesheetPolling()
        // 2000 ms is STYLESHEET_POLL_INTERVAL_MS; intervals never fire on their own here.
        const poll = [...env.intervals.values()].find(interval => interval.delay === 2000)
        assert.ok(poll)
        // The first tick only records the baseline state; counting starts after it.
        poll.callback()
        const checks = observeEditingChecks(env)

        for (const editable of [true, false]) {
            if (source === 'body editability') env.child.body.isContentEditable = editable
            else env.child.designMode = editable ? 'on' : 'off'
            poll.callback()

            if (editable) assertSuppressed(env.background)
            else assertFiltered(env.background)
            assertFiltered(env.unrelated)
            assert.equal(checks.get(env.background), 1, 'changed frame state must reconcile its ancestor once')
            assert.equal(checks.get(env.unrelated) || 0, 0, 'a frame edit must not inspect unrelated backgrounds')

            checks.clear()
            poll.callback()
            assert.equal(checks.size, 0, 'an unchanged frame must not repeat any background traversal')
        }
    })
}

// document.designMode is not an attribute and produces no mutation record; the
// poll compares it with the last known value and re-evaluates every background.
test('the existing state poll responds to document designMode changes without a mutation record', () => {
    const env = createContentHarness()
    const background = addBackground(env)
    startProtection(env)
    env.controller._startStylesheetPolling()
    const poll = [...env.intervals.values()].find(interval => interval.delay === 2000)
    assert.ok(poll)
    assertFiltered(background)

    env.document.designMode = 'on'
    poll.callback()
    assertSuppressed(background)

    env.document.designMode = 'off'
    poll.callback()
    assertFiltered(background)
})

// refreshBackgroundMode walks a background's subtree only when something marked
// the node dirty. The 100 children make that walk real work; re-applying the same
// verdict must not pay it.
test('reapplying an unchanged protection decision does not walk background descendants again', () => {
    const env = createContentHarness()
    const background = addBackground(env)
    for (let index = 0; index < 100; index++) background.appendChild(env.document.createElement('p'))
    startProtection(env)
    const checks = observeEditingChecks(env)

    for (let index = 0; index < 10; index++) env.controller.protectAllKnownVisuals()

    assertFiltered(background)
    assert.equal(checks.get(background) || 0, 0)
})
