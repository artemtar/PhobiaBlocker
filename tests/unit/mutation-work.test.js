// How much work one mutation batch costs the controller, measured by wrapping the
// expensive steps: containsEditingSurface walks a whole subtree, _scanBackgrounds
// reads computed styles, indexTextNode reads layout. Typing into an editor on a
// page with large backgrounds is the scenario; verdicts are not under test here.
const assert = require('node:assert/strict')
const test = require('node:test')
const { createContentHarness } = require('./helpers/content-harness')

// Two backgrounds with 200 children each, so an unnecessary editing-surface walk
// is visible in the counters, plus a contenteditable editor the user types into.
// ALWAYS_BLUR keeps vocabulary changes from scheduling analysis. The full scan
// registers both backgrounds as blurred before any counting starts.
function backgroundFixture() {
    const env = createContentHarness()
    const ancestor = env.body.appendChild(env.document.createElement('section'))
    const background = ancestor.appendChild(env.document.createElement('div'))
    const unrelated = env.body.appendChild(env.document.createElement('aside'))
    for (const element of [background, unrelated]) {
        element.style.setProperty('background-image', 'url("wallpaper.jpg")')
        for (let index = 0; index < 200; index++) {
            element.appendChild(env.document.createElement('span'))
        }
    }
    const editor = env.body.appendChild(env.document.createElement('div'))
    editor.setAttribute('contenteditable', 'true')
    const text = editor.appendChild(env.document.createTextNode('draft'))
    env.controller.mode = 'ALWAYS_BLUR'
    env.controller._scanBackgrounds(env.document, { full: true })
    env.controller._pageTextIndex.build(env.body)
    const checks = new Map()
    const Index = env.context.PhobiaBlockerPageTextIndex
    const containsEditingSurface = Index.containsEditingSurface
    // VisualNode looks the static up on the class at call time, so patching it after
    // the initial scan counts only the checks the mutation path performs.
    Index.containsEditingSurface = element => {
        checks.set(element, (checks.get(element) || 0) + 1)
        return containsEditingSurface(element)
    }
    return { ...env, ancestor, background, unrelated, editor, text, checks }
}

// A background is blurred with a filter unless it contains an editing surface; then
// a filter would blur the text being typed, so its image is hidden instead.
function assertFiltered(element) {
    assert.equal(element.style.getPropertyValue('background-image'), 'url("wallpaper.jpg")')
    assert.match(element.style.getPropertyValue('filter'), /^blur\(/)
}

function assertSuppressed(element) {
    assert.equal(element.style.getPropertyValue('background-image'), 'none')
    assert.equal(element.style.getPropertyValue('filter'), '')
}

// Each keystroke is a characterData record. Text cannot change which elements hold
// an editing surface, so no background may be re-evaluated for it.
test('typing text does not inspect unrelated background descendants', () => {
    const env = backgroundFixture()
    for (let index = 0; index < 10; index++) {
        env.text.nodeValue += 'x'
        env.controller._handleMutations([{ type: 'characterData', target: env.text }])
    }

    assertFiltered(env.background)
    assertFiltered(env.unrelated)
    assert.equal(env.controller._pageTextIndex.wordCount, 0, 'editable text stays out of detection')
    assert.equal(env.checks.get(env.background) || 0, 0)
    assert.equal(env.checks.get(env.unrelated) || 0, 0)
})

// Editors often replace the text node rather than edit it. A childList record whose
// added and removed nodes are all text must cost no more than a characterData one:
// no ancestor invalidation and no stylesheet search of the parent's subtree.
test('text-only child replacements do not inspect unrelated background descendants', () => {
    const env = backgroundFixture()
    let descendantQueries = 0
    const querySelector = env.editor.querySelector.bind(env.editor)
    env.editor.querySelector = selector => { descendantQueries++; return querySelector(selector) }
    env.editor.removeChild(env.text)
    const replacement = env.editor.appendChild(env.document.createTextNode('another draft'))
    env.controller._handleMutations([{
        type: 'childList', target: env.editor, addedNodes: [replacement], removedNodes: [env.text],
    }])

    assertFiltered(env.background)
    assertFiltered(env.unrelated)
    assert.equal(env.controller._pageTextIndex.wordCount, 0)
    assert.equal(env.checks.get(env.background) || 0, 0)
    assert.equal(env.checks.get(env.unrelated) || 0, 0)
    assert.equal(descendantQueries, 0, 'replacing text must not search its entire parent for stylesheets')
})

// Editors rewrite the same class and style strings on every key. MutationObserver
// still reports them with oldValue equal to the current value; such records are
// dropped before any work, so the 200 paragraphs are never revisited.
test('typing with unchanged editor class and style writes does not rescan its document', () => {
    const env = backgroundFixture()
    env.editor.setAttribute('class', 'editor focused')
    env.editor.setAttribute('style', 'white-space: pre-wrap')
    for (let index = 0; index < 200; index++) {
        const paragraph = env.editor.appendChild(env.document.createElement('p'))
        paragraph.appendChild(env.document.createTextNode('editor paragraph'))
    }
    env.controller._pageTextIndex.build(env.body)
    let textVisits = 0
    let backgroundScans = 0
    const indexTextNode = env.controller._pageTextIndex.indexTextNode.bind(env.controller._pageTextIndex)
    env.controller._pageTextIndex.indexTextNode = (...args) => { textVisits++; return indexTextNode(...args) }
    const scanBackgrounds = env.controller._scanBackgrounds.bind(env.controller)
    env.controller._scanBackgrounds = (...args) => { backgroundScans++; return scanBackgrounds(...args) }

    env.text.nodeValue += ' spider'
    env.controller._handleMutations([
        { type: 'characterData', target: env.text },
        { type: 'attributes', target: env.editor, attributeName: 'class', oldValue: 'editor focused' },
        { type: 'attributes', target: env.editor, attributeName: 'style', oldValue: env.editor.getAttribute('style') },
    ])

    assert.equal(env.controller._pageTextIndex.getTokenCount('spider'), 0, 'editor content stays excluded')
    assertFiltered(env.background)
    assert.equal(backgroundScans, 0, 'identical attribute writes must not force background discovery')
    assert.equal(textVisits, 1, 'only the changed text node needs an eligibility check')
})

// An <input> appearing inside a blurred background flips it to suppressed so the
// control stays usable, and removing it flips it back. The ancestor walk marks only
// registered backgrounds dirty, so each change costs exactly one check there and
// none for the unrelated background.
test('adding and removing a control only reevaluates its background container once', () => {
    const env = backgroundFixture()
    const control = env.background.appendChild(env.document.createElement('input'))
    env.controller._handleMutations([{
        type: 'childList', target: env.background, addedNodes: [control], removedNodes: [],
    }])

    assertSuppressed(env.background)
    assertFiltered(env.unrelated)
    assert.equal(env.checks.get(env.background), 1)
    assert.equal(env.checks.get(env.unrelated) || 0, 0)

    env.checks.clear()
    env.background.removeChild(control)
    env.controller._handleMutations([{
        type: 'childList', target: env.background, addedNodes: [], removedNodes: [control],
    }])

    assertFiltered(env.background)
    assert.equal(env.checks.get(env.background), 1)
    assert.equal(env.checks.get(env.unrelated) || 0, 0)
})

// contenteditable is inherited, so toggling it on an ancestor makes every background
// below it an editing surface; those are re-evaluated (_invalidateBackgroundSubtree),
// the aside outside the ancestor is not.
test('inherited editability changes reevaluate descendant backgrounds without scanning unrelated ones', () => {
    const env = backgroundFixture()
    env.ancestor.setAttribute('contenteditable', 'true')
    env.controller._handleMutations([{
        type: 'attributes', target: env.ancestor, attributeName: 'contenteditable',
    }])

    assertSuppressed(env.background)
    assertFiltered(env.unrelated)
    assert.equal(env.checks.get(env.background), 1)
    assert.equal(env.checks.get(env.unrelated) || 0, 0)

    env.checks.clear()
    env.ancestor.setAttribute('contenteditable', 'false')
    env.controller._handleMutations([{
        type: 'attributes', target: env.ancestor, attributeName: 'contenteditable',
    }])

    assertFiltered(env.background)
    assert.equal(env.checks.get(env.background), 1)
    assert.equal(env.checks.get(env.unrelated) || 0, 0)
})

// role="textbox" turns a plain span into an editing surface without any element
// being added, so the role attribute must invalidate the containing background.
test('changing a descendant role updates only the containing background', () => {
    const env = backgroundFixture()
    const control = env.background.firstElementChild
    control.setAttribute('role', 'textbox')
    env.controller._handleMutations([{ type: 'attributes', target: control, attributeName: 'role' }])

    assertSuppressed(env.background)
    assertFiltered(env.unrelated)
    assert.equal(env.checks.get(env.background), 1)
    assert.equal(env.checks.get(env.unrelated) || 0, 0)

    env.checks.clear()
    control.removeAttribute('role')
    env.controller._handleMutations([{ type: 'attributes', target: control, attributeName: 'role' }])

    assertFiltered(env.background)
    assert.equal(env.checks.get(env.background), 1)
    assert.equal(env.checks.get(env.unrelated) || 0, 0)
})

// Four records describe a nested section and paragraph in interleaved order. Both
// the background scan and the re-index must collapse them to the outermost subtree
// (minimalRoots) while still noticing that the class change hid, then showed, the
// text. `hidden` drives the rects the index's visibility check reads.
test('overlapping class and style mutations scan one subtree and preserve visibility changes', () => {
    const env = createContentHarness()
    const outer = env.body.appendChild(env.document.createElement('section'))
    const inner = outer.appendChild(env.document.createElement('p'))
    const text = inner.appendChild(env.document.createTextNode('spider'))
    let hidden = false
    inner.getClientRects = () => hidden ? [] : [{}]
    const getComputedStyle = env.context.getComputedStyle
    env.context.getComputedStyle = element => ({
        ...getComputedStyle(element),
        display: element === outer && hidden ? 'none' : 'block',
    })
    env.controller.mode = 'ALWAYS_BLUR'
    const index = env.controller._pageTextIndex
    index.build(env.body)
    const scanned = []
    const scanBackgrounds = env.controller._scanBackgrounds.bind(env.controller)
    env.controller._scanBackgrounds = (...args) => {
        scanned.push(args[0])
        return scanBackgrounds(...args)
    }
    let textVisits = 0
    const indexTextNode = index.indexTextNode.bind(index)
    index.indexTextNode = (node, ...args) => {
        if (node === text) textVisits++
        return indexTextNode(node, ...args)
    }
    const records = [
        { type: 'attributes', target: outer, attributeName: 'class' },
        { type: 'attributes', target: inner, attributeName: 'style' },
        { type: 'attributes', target: outer, attributeName: 'style' },
        { type: 'attributes', target: inner, attributeName: 'class' },
    ]

    hidden = true
    env.controller._handleMutations(records)
    assert.equal(index.getTokenCount('spider'), 0)
    assert.equal(textVisits, 1, 'a nested style record must not reindex the same text again')
    assert.deepEqual(scanned, [outer])

    scanned.length = 0
    textVisits = 0
    hidden = false
    env.controller._handleMutations(records)
    assert.equal(index.getTokenCount('spider'), 1)
    assert.equal(textVisits, 1)
    assert.deepEqual(scanned, [outer])
})
