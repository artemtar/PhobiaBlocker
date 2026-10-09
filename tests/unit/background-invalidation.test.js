const assert = require('node:assert/strict')
const test = require('node:test')
const { createContentHarness } = require('./helpers/content-harness')

const BACKGROUND = 'url("paper.jpg")'

function addBackground(env, parent = env.body) {
    const element = parent.appendChild(env.document.createElement('section'))
    element.style.setProperty('background-image', BACKGROUND)
    return element
}

function startProtection(env) {
    env.controller.mode = 'ALWAYS_BLUR'
    env.controller._discoverShadowRoots(env.document)
    env.controller._registerMedia(env.document)
    env.controller._scanBackgrounds(env.document, { full: true })
    env.controller._pageTextIndex.build(env.body)
}

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

function assertFiltered(element) {
    assert.equal(element.style.getPropertyValue('background-image'), BACKGROUND)
    assert.match(element.style.getPropertyValue('filter'), /^blur\(/)
}

function assertSuppressed(element) {
    assert.equal(element.style.getPropertyValue('background-image'), 'none')
    assert.equal(element.style.getPropertyValue('filter'), '')
}

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

test('iframe editor readiness invalidates containing backgrounds without a parent DOM mutation', () => {
    const env = iframeFixture()
    const checks = observeEditingChecks(env)
    assertFiltered(env.background)

    for (const editable of [true, false]) {
        env.child.body.isContentEditable = editable
        env.document.dispatchEvent({
            type: 'phobiablocker:editor-frame-ready', target: env.frame, composedPath: () => [env.frame],
        })
        if (editable) assertSuppressed(env.background)
        else assertFiltered(env.background)
    }

    assertFiltered(env.unrelated)
    assert.equal(checks.get(env.unrelated) || 0, 0)
})

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

for (const source of ['body editability', 'designMode']) {
    test(`polling detects iframe ${source} changes without child notifications`, () => {
        const env = iframeFixture()
        env.controller._startStylesheetPolling()
        const poll = [...env.intervals.values()].find(interval => interval.delay === 2000)
        assert.ok(poll)
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
