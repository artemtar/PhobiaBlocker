// How PageTextIndex and WordCoverManager react when the page edits text that sits
// inside one of our own cover spans, removes or re-inserts covers, or carries text
// whose Unicode normalization changes its length. The invariant: a trigger word is
// never left readable because a cover went stale, and page markup is never lost.
const assert = require('node:assert/strict')
const test = require('node:test')
const { createContentHarness } = require('./helpers/content-harness')

// A standalone index with a hand-made owned cover: a plain span whose ownership is
// the `owned` set, no WordCoverManager. That isolates the index's reconciliation
// requests; `onChange` lets a test perform the reconciliation itself.
function coveredText(value = 'spider', onChange = () => {}) {
    const env = createContentHarness()
    const wrapper = env.body.appendChild(env.document.createElement('span'))
    const owned = new Set([wrapper])
    const text = wrapper.appendChild(env.document.createTextNode(value))
    const changedCovers = []
    const index = new env.context.PhobiaBlockerPageTextIndex({
        isOwnedCover: element => owned.has(element),
        onOwnedCoverChange(cover) {
            changedCovers.push(cover)
            onChange({ cover, index, env, text, owned })
        },
    })
    index.setTargetWords(['spider', 'snake'])
    index.build(env.body)
    return { ...env, index, wrapper, text, owned, changedCovers }
}

// Any text change inside a cover is reported, even when the token is unchanged:
// 'SPIDER!' still tokenizes to 'spider' (NFKC, lowercase, WORD_RE drops the '!'),
// yet the cover no longer wraps exactly the word and must be rebuilt.
for (const [value, expectedWords] of [
    ['garden', ['garden']],
    ['snake', ['snake']],
    ['', []],
    ['SPIDER!', ['spider']],
]) {
    test(`editing covered text to ${JSON.stringify(value)} requests cover reconciliation`, () => {
        const { index, wrapper, text, changedCovers } = coveredText()
        text.nodeValue = value

        index.applyMutations([{ type: 'characterData', target: text }])

        assert.equal(changedCovers.length, 1)
        assert.equal(changedCovers[0], wrapper)
        assert.deepEqual([...index.getWords()], expectedWords)
        assert.equal(index.getTokenCount('spider'), value === 'SPIDER!' ? 1 : 0)
    })
}

// A browser delivers both records in one batch when a script swaps the text node
// and edits it; the cover must be reconciled once, against the final content.
test('replacing an owned cover child requests one reconciliation for the final content', () => {
    const { index, wrapper, text, changedCovers, document } = coveredText()
    wrapper.removeChild(text)
    const replacement = wrapper.appendChild(document.createTextNode('snake'))

    index.applyMutations([
        { type: 'childList', target: wrapper, removedNodes: [text], addedNodes: [replacement] },
        { type: 'characterData', target: replacement },
    ])

    assert.equal(changedCovers.length, 1)
    assert.equal(changedCovers[0], wrapper)
    assert.deepEqual([...index.getWords()], ['snake'])
    assert.equal(index.getTokenCount('snake'), 1)
})

// The returned delta is what the controller feeds to _handleVocabularyChange:
// losing the last 'spider' is the removal that can lift a blur verdict.
test('emptying an owned cover requests reconciliation and removes its last indexed word', () => {
    const { index, wrapper, text, changedCovers } = coveredText()
    wrapper.removeChild(text)

    const delta = index.applyMutations([
        { type: 'childList', target: wrapper, removedNodes: [text], addedNodes: [] },
    ])

    assert.equal(changedCovers.length, 1)
    assert.equal(changedCovers[0], wrapper)
    assert.equal(index.wordCount, 0)
    assert.deepEqual([...delta.removed], ['spider'])
})

// Only characterData and childList records count as a cover change. A reconciliation
// unwraps and re-covers, which would discard a reveal the user made on that word, so
// the class/style writes of the projection itself and the body-level record for the
// cover's own insertion must not trigger one.
test('projection attributes and initial cover insertion do not reset an existing reveal', () => {
    const { index, wrapper, body, changedCovers } = coveredText()

    index.applyMutations([
        { type: 'attributes', target: wrapper, attributeName: 'class' },
        { type: 'attributes', target: wrapper, attributeName: 'style' },
        { type: 'childList', target: body, removedNodes: [], addedNodes: [wrapper] },
    ])

    assert.deepEqual(changedCovers, [])
    assert.equal(index.getTokenCount('spider'), 1)
})

// The removal and the edit arrive in one batch. A detached cover has nothing to
// reconcile, and its words must leave the vocabulary rather than keep a page blurred.
test('edits in a detached owned cover do not request reconciliation or retain page words', () => {
    const { index, wrapper, text, body, changedCovers } = coveredText()
    body.removeChild(wrapper)
    text.nodeValue = 'snake'

    index.applyMutations([
        { type: 'childList', target: body, removedNodes: [wrapper], addedNodes: [] },
        { type: 'characterData', target: text },
    ])

    assert.deepEqual(changedCovers, [])
    assert.equal(index.wordCount, 0)
})

// The callback does what WordCoverManager.reconcileCover does: drop the old text
// from the index, disown and detach the cover, and index the replacement with
// notify:false. The batch must then skip the detached original (it is no longer
// eligible) and report the net change spider -> snake in a single delta.
test('synchronous reconciliation contributes net words without indexing its detached source again', () => {
    const { index, text } = coveredText('spider', ({ cover, index, env, text, owned }) => {
        index.removeTextNode(text)
        owned.delete(cover)
        env.body.removeChild(cover)
        const replacement = env.body.appendChild(env.document.createTextNode('snake'))
        index.indexTextNode(replacement, { notify: false })
    })
    text.nodeValue = 'snake'

    const delta = index.applyMutations([{ type: 'characterData', target: text }])

    assert.equal(index.getTokenCount('spider'), 0)
    assert.equal(index.getTokenCount('snake'), 1)
    assert.equal(text.isConnected, false)
    assert.deepEqual([...delta.added], ['snake'])
    assert.deepEqual([...delta.removed], ['spider'])
})

// The real manager and index run against the harness DOM tree.
// build() covers 'spider' through the index's onDirectMatch callback, and `mutate`
// runs the controller's full mutation path. The controller itself is left at its
// construction state (ALWAYS_BLUR, settings never applied), so no analysis is
// scheduled and only the cover and index behaviour is under test.
function wordCoverHarness() {
    const env = createContentHarness()
    const manager = env.controller._wordCoverManager
    const index = env.controller._pageTextIndex
    manager.configure({ ...env.Policy.DEFAULTS, targetWords: ['spider', 'snake'], wordCoverEnabled: true }, 'ANALYZE')
    env.body.appendChild(env.document.createTextNode('spider'))
    index.build(env.body)
    return {
        ...env, manager, index,
        cover: () => env.body.querySelector('.phobia-word-cover'),
        mutate: records => env.controller._handleMutations(records),
    }
}

test('covered text changed to an ordinary word loses its cover', () => {
    const env = wordCoverHarness()
    const wrapper = env.cover()
    wrapper.firstChild.nodeValue = 'garden'

    env.mutate([{ type: 'characterData', target: wrapper.firstChild }])

    assert.equal(env.cover(), null)
    assert.equal(env.body.textContent, 'garden')
    assert.equal(env.manager.ownsWrapper(wrapper), false)
    assert.equal(env.index.getTokenCount('spider'), 0)
    assert.equal(env.index.getTokenCount('garden'), 1)
})

// A reveal belongs to the word the user saw. Once the text changes, the wrapper is
// unwrapped and the new trigger gets a fresh, covered span, not the uncover class.
test('editing a revealed word to another trigger covers the replacement', () => {
    const env = wordCoverHarness()
    const wrapper = env.cover()
    assert.equal(env.manager.revealContextWord(wrapper.firstChild), true)
    wrapper.firstChild.nodeValue = 'snake'

    env.mutate([{ type: 'characterData', target: wrapper.firstChild }])

    assert.equal(env.cover()?.textContent, 'snake')
    assert.equal(env.body.querySelector('.phobia-word-permanent-uncover'), null)
    assert.equal(env.index.getTokenCount('spider'), 0)
    assert.equal(env.index.getTokenCount('snake'), 1)
})

// The page replaced the cover's child with <strong>snake</strong>. Unwrapping moves
// that element out intact instead of flattening it to text, and re-indexing covers
// 'snake' inside the strong, so the new cover's parent is the page's element.
test('cover textContent replacement preserves page-added markup and re-covers matching text', () => {
    const env = wordCoverHarness()
    const wrapper = env.cover()
    const removed = wrapper.firstChild
    wrapper.removeChild(removed)
    const emphasis = env.document.createElement('strong')
    emphasis.textContent = 'snake'
    wrapper.appendChild(emphasis)

    env.mutate([{ type: 'childList', target: wrapper, removedNodes: [removed], addedNodes: [emphasis] }])

    assert.equal(env.body.querySelector('strong'), emphasis)
    assert.equal(env.cover()?.parentElement, emphasis)
    assert.equal(env.cover()?.textContent, 'snake')
    assert.equal(env.manager.ownsWrapper(wrapper), false)
    assert.equal(env.index.getTokenCount('spider'), 0)
    assert.equal(env.index.getTokenCount('snake'), 1)
})

// A class record on an owned wrapper goes through repairProjection, which re-asserts
// whichever projection applies; for a revealed word that is the uncover class, so no
// .phobia-word-cover appears while the wrapper stays owned.
test('projection-only changes preserve a word reveal until its text changes', () => {
    const env = wordCoverHarness()
    const wrapper = env.cover()
    env.manager.revealContextWord(wrapper.firstChild)

    env.mutate([{ type: 'attributes', target: wrapper, attributeName: 'class' }])

    assert.equal(env.cover(), null)
    assert.equal(env.body.querySelector('.phobia-word-permanent-uncover'), wrapper)
    assert.equal(env.manager.ownsWrapper(wrapper), true)
})

// "Reveal current content" deactivates the manager; a trigger typed afterwards is
// indexed but not re-covered until a settings change calls configure() again.
test('unblurAll stays revealed when the page changes an unwrapped word', () => {
    const env = wordCoverHarness()
    env.controller.unblurAll()
    const text = env.body.firstChild
    text.nodeValue = 'snake'

    env.mutate([{ type: 'characterData', target: text }])

    assert.equal(env.cover(), null)
    assert.equal(env.body.textContent, 'snake')
    assert.equal(env.index.getTokenCount('snake'), 1)
})

// prune() unwraps a disconnected wrapper and strips its classes, so when the page
// re-attaches the very same node it is plain text again: it is indexed, matched and
// given a new cover span nested inside the old one.
test('removing a cover releases retained ownership and reinsertion can be covered again', () => {
    const env = wordCoverHarness()
    const wrapper = env.cover()
    env.manager.revealContextWord(wrapper.firstChild)
    env.body.removeChild(wrapper)

    env.mutate([{ type: 'childList', target: env.body, removedNodes: [wrapper], addedNodes: [] }])

    assert.equal(env.manager._ownedWrappers.size, 0)
    assert.equal(env.index.getTokenCount('spider'), 0)
    assert.equal(wrapper.classList.contains('phobia-word-permanent-uncover'), false)
    assert.equal(wrapper.classList.contains('phobia-word-cover'), false)

    env.body.appendChild(wrapper)
    env.mutate([{ type: 'childList', target: env.body, removedNodes: [], addedNodes: [wrapper] }])

    assert.equal(env.cover()?.textContent, 'spider')
    assert.equal(env.index.getTokenCount('spider'), 1)
    assert.equal(env.manager._ownedWrappers.size, 1)
})

// The wrapper still has a parent inside the detached container, so unwrapping moves
// its text into the container; a page that re-inserts the container gets its text back.
test('removing a subtree unwraps owned covers without dropping its child elements', () => {
    const env = wordCoverHarness()
    const wrapper = env.cover()
    const container = env.document.createElement('section')
    env.body.appendChild(container)
    container.appendChild(wrapper)
    env.body.removeChild(container)

    env.mutate([{ type: 'childList', target: env.body, removedNodes: [container], addedNodes: [] }])

    assert.equal(env.manager._ownedWrappers.size, 0)
    assert.equal(container.querySelector('.phobia-word-cover'), null)
    assert.equal(container.textContent, 'spider')
    assert.equal(env.index.getTokenCount('spider'), 0)
})

// NFKC composes 'e' + U+0301 into 'é', so the decomposed spelling tokenizes to the
// same 'café' while the cover must keep the original code units. 'cafe' and
// 'cafeteria' are distinct tokens and stay uncovered. `parts` pins the surrounding
// text nodes; the sibling <strong> and <em> prove unwrapping touched only the <p>.
for (const [name, value, covered, parts] of [
    ['composed accents', 'Before (café), CAFÉ; cafeteria, cafe — café.',
        ['café', 'CAFÉ', 'café'], ['Before (', 'café', '), ', 'CAFÉ', '; cafeteria, cafe — ', 'café', '.']],
    ['decomposed accents', 'Before (cafe\u0301), CAFE\u0301; cafeteria, cafe — cafe\u0301.',
        ['cafe\u0301', 'CAFE\u0301', 'cafe\u0301'],
        ['Before (', 'cafe\u0301', '), ', 'CAFE\u0301', '; cafeteria, cafe — ', 'cafe\u0301', '.']],
]) {
    test(`word covers preserve ${name}, surrounding text and child elements when unwrapped`, () => {
        const env = createContentHarness()
        const manager = env.controller._wordCoverManager
        const index = env.controller._pageTextIndex
        manager.configure({ ...env.Policy.DEFAULTS, targetWords: ['café'], wordCoverEnabled: true }, 'ANALYZE')
        const before = env.body.appendChild(env.document.createElement('strong'))
        before.textContent = 'Header'
        const paragraph = env.body.appendChild(env.document.createElement('p'))
        paragraph.textContent = value
        const after = env.body.appendChild(env.document.createElement('em'))
        after.textContent = 'Footer'

        index.build(env.body)

        const covers = paragraph.querySelectorAll('.phobia-word-cover')
        assert.deepEqual(covers.map(cover => cover.textContent), covered)
        assert.deepEqual(paragraph.childNodes.map(node => node.textContent), parts)
        assert.equal(paragraph.textContent, value)
        assert.equal(index.getTokenCount('café'), 3)
        assert.equal(index.getTokenCount('cafe'), 1)
        assert.equal(index.getTokenCount('cafeteria'), 1)
        assert.deepEqual(env.body.childNodes, [before, paragraph, after])

        // Page-owned markup inserted inside a cover must survive unwrapping.
        const text = covers[0].firstChild
        const emphasis = env.document.createElement('strong')
        emphasis.appendChild(text)
        covers[0].appendChild(emphasis)
        manager.revealAll()

        assert.equal(paragraph.querySelector('.phobia-word-cover'), null)
        assert.equal(paragraph.textContent, value)
        assert.equal(paragraph.querySelector('strong'), emphasis)
        assert.equal(emphasis.firstChild, text)
        assert.equal(index.getTokenCount('café'), 3)
        assert.deepEqual(env.body.childNodes, [before, paragraph, after])
    })
}

// Cases where NFKC changes the string length, so match offsets found in the
// normalized text must be mapped back onto the original: circled letters and the
// ffi ligature fold to ASCII; compatibility jamo compose into syllables; a mark
// that does not compose stays attached to its grapheme, so the cover includes it;
// U+FDFA expands to several words, and two targets inside it merge into one cover.
for (const [name, targets, value, expected] of [
    ['compatibility letters', ['cafe', 'ffi'], 'ⓒⓐⓕⓔ, ﬃ; xﬃ.', ['ⓒⓐⓕⓔ', 'ﬃ']],
    ['compatibility jamo composition', ['가나다'], 'Before ㄱㅏㄴㅏㄷㅏ, after 가나다.', ['ㄱㅏㄴㅏㄷㅏ', '가나다']],
    ['noncomposing marks', ['abcq'], 'abcq\u0301tail, abcq\u0301!', ['abcq\u0301', 'abcq\u0301']],
    ['overlapping normalized tokens', ['الله', 'عليه'], 'Before ﷺ, after ﷺ.', ['ﷺ', 'ﷺ']],
]) {
    test(`shared word splitter preserves original ranges for ${name}`, () => {
        const env = createContentHarness()
        const helper = env.context.PhobiaBlockerPageTextIndex
        const text = env.text(value)
        // This is the same direct helper contract used by early-blur.js.
        const split = helper.splitTextNodeByWords(text, word => targets.includes(word))

        assert.ok(split)
        assert.deepEqual([...split.covers].map(cover => cover.textContent), expected)
        assert.equal(split.fragment.textContent, value)
        env.body.replaceChild(split.fragment, text)
        split.covers.forEach(cover => helper.unwrapWordCover(cover))
        assert.equal(env.body.textContent, value)
        assert.equal(env.body.querySelector('.phobia-word-cover'), null)
    })
}
