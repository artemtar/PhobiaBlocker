// Incremental index of the visible words on a page, plus the word-cover helpers
// shared by early-blur.js and the controller. It tracks words, not elements:
// the verdict is page-wide, so page-wide token counts are all analysis needs.
(() => {
    'use strict'

    if (globalThis.PhobiaBlockerPageTextIndex) return

    const policy = globalThis.PhobiaBlockerPolicy
    if (!policy) throw new Error('PhobiaBlockerPolicy must load before page-text-index.js')

    // Text inside these elements is neither indexed nor covered.
    const EXCLUDED_SELECTOR = [
        'script', 'style', 'noscript', 'input', 'textarea', 'select', 'option',
        // 'form' dates from an input-lag fix (e2819cc) that treated whole forms as
        // editors: it drops every word inside a <form>, labels included, not only the
        // controls listed before it. Narrowing it is an open question.
        'form', '[hidden]', '[aria-hidden="true"]',
    ].join(', ')
    const WORD_RE = policy.WORD_RE
    // validateTargetWord rejects targets with fewer than three letters, so such
    // tokens can never match; dropping them shrinks the list sent for analysis.
    const HAS_THREE_LETTERS_RE = /(?:\P{L}*\p{L}){3}/u
    // The attributes most likely to flip _isEligibleTextNode's answer. Visibility
    // driven by other attributes (CSS attribute selectors, <details open>) is only
    // picked up when the text or the stylesheets change; a deliberate trade-off.
    const VISIBILITY_ATTRIBUTES = new Set(['class', 'style', 'hidden', 'aria-hidden', 'contenteditable'])
    // Grapheme boundaries are what let coveredTextRanges map offsets found in
    // normalized text back onto the original string.
    const TEXT_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

    // A node placed directly in a shadow root has no parentElement; its host stands
    // in as the parent for exclusion, style and editability checks.
    function composedParent(element) {
        return element?.parentElement || element?.getRootNode?.().host || null
    }

    // These scans follow DOM ownership, including open shadow roots. Slot
    // distribution does not change which subtree owns a text or media node.
    function minimalRoots(nodes) {
        const roots = new Set([...nodes].filter(Boolean))
        return [...roots].filter(node => {
            for (let parent = node.parentNode || node.host; parent; parent = parent.parentNode || parent.host) {
                if (roots.has(parent)) return false
            }
            return true
        })
    }

    // isContentEditable follows inheritance from an ancestor's contenteditable and
    // designMode makes a whole document editable; a literal attribute check
    // would miss both and leave covers inside an editor.
    function isEditableElement(node) {
        const element = node?.nodeType === Node.TEXT_NODE ? composedParent(node) : node
        return Boolean(element && (element.isContentEditable ||
            element.ownerDocument?.designMode?.toLowerCase() === 'on'))
    }

    function isEditableDocument(doc) {
        return Boolean(doc && (doc.body?.isContentEditable || doc.designMode?.toLowerCase() === 'on'))
    }

    // Element.closest stops at a shadow root; this keeps walking through the host.
    function closestAcrossRoots(element, selector) {
        for (let current = element; current; current = composedParent(current)) {
            if (current.matches?.(selector)) return current
        }
        return null
    }

    // Selectors and tree walkers stop at a shadow boundary. Visit each open
    // root once; slotted nodes stay in their original tree and are not doubled.
    function collectDomRoots(root) {
        if (!root) return []
        const roots = [root]
        // Index loop on purpose: roots grows while it is being iterated.
        for (let index = 0; index < roots.length; index++) {
            const current = roots[index]
            if (current.shadowRoot) roots.push(current.shadowRoot)
            current.querySelectorAll?.('*').forEach(element => {
                if (element.shadowRoot) roots.push(element.shadowRoot)
            })
        }
        return roots
    }

    // The controller hides, rather than blurs, the background of an element that
    // holds a control: a CSS filter on the container would blur every descendant,
    // including the text being typed, so VisualNode sets background-image: none.
    function containsEditingSurface(element) {
        const isEditingSurface = candidate => {
            if (isEditableElement(candidate) || candidate.matches?.(
                'input, textarea, select, button, [role="textbox"], [role="combobox"]',
            )) return true
            if (candidate.tagName !== 'IFRAME') return false
            try {
                return isEditableDocument(candidate.contentDocument)
            } catch (_) {
                return false
            }
        }
        const pending = element ? [element] : []
        const seen = new Set()
        while (pending.length > 0) {
            const candidate = pending.pop()
            if (seen.has(candidate)) continue
            seen.add(candidate)
            if (isEditingSurface(candidate)) return true
            if (candidate.shadowRoot) pending.push(candidate.shadowRoot)
            // A shadow wrapper can visually contain a slotted control that is
            // outside its DOM subtree. Follow those assignments as well.
            if (candidate.localName === 'slot') {
                pending.push(...(candidate.assignedElements?.({ flatten: true }) || []))
            }
            pending.push(...(candidate.children || []))
        }
        return false
    }

    // Same NFKC + lowercase as validateTargetWord, so page tokens and stored
    // targets compare equal by plain string equality.
    function tokenize(value) {
        const normalized = typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : ''
        return (normalized.match(WORD_RE) || []).filter(word => HAS_THREE_LETTERS_RE.test(word))
    }

    function collectTextNodes(root) {
        const textNodes = []
        try {
            collectDomRoots(root).forEach(tree => {
                const walker = document.createTreeWalker(tree, NodeFilter.SHOW_TEXT)
                let current = walker.nextNode()
                while (current) {
                    textNodes.push(current)
                    current = walker.nextNode()
                }
            })
        } catch (_) {
            // Defensive: the walker only throws for a torn-down or foreign-realm root.
            // Returning [] drops that root's words, which is fail-open for indexing;
            // nothing in history records a case that needed this.
            return []
        }
        return textNodes
    }

    // A cover is a solid bar in the text's own colour so it reads as redaction
    // rather than a styling glitch; a transparent colour falls back to currentColor.
    function coverColorFor(parentElement) {
        try {
            const color = parentElement ? getComputedStyle(parentElement).color : ''
            if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color
        } catch (_) { /* Use the stylesheet's currentColor fallback. */ }
        return 'currentColor'
    }

    // A cover paints the word's own text colour over the word.
    function createWordCover(word, color) {
        const cover = document.createElement('span')
        cover.className = 'phobia-word-cover'
        cover.setAttribute('title', 'Covered by PhobiaBlur')
        cover.setAttribute('aria-label', 'Covered by PhobiaBlur')
        cover.style.setProperty('--phobiablocker-word-cover-color', color)
        cover.textContent = word
        return cover
    }

    // WORD_RE runs on the NFKC-lowercased text, so match offsets are in normalized
    // units. Normalization can change the length (ligatures, full-width forms,
    // Hangul), so those offsets must be mapped back onto the original string.
    function coveredTextRanges(text, shouldCover) {
        const normalized = text.normalize('NFKC').toLowerCase()
        const matches = [...normalized.matchAll(WORD_RE)].filter(match => shouldCover(match[0]))
        if (matches.length === 0) return []
        // ASCII is unchanged by NFKC and keeps its length under toLowerCase, so
        // the offsets map 1:1 and the grapheme walk below can be skipped.
        if (/^\p{ASCII}*$/u.test(text)) {
            return matches.map(match => ({ start: match.index, end: match.index + match[0].length }))
        }

        // Decompose before finding graphemes: compatibility characters can join
        // across their original boundaries (for example, Korean jamo). Keep the
        // source span of every decomposed code unit so covers retain exact text.
        const sourceOffsets = []
        let sourceOffset = 0
        for (const character of text) {
            const end = sourceOffset + character.length
            const span = { start: sourceOffset, end }
            const length = character.normalize('NFKD').length
            for (let offset = 0; offset < length; offset++) sourceOffsets.push(span)
            sourceOffset = end
        }

        // Walk the graphemes of the NFKD form, summing each one's NFKC-lowercase
        // length to track the position in the string the matches were found in.
        // A match spanning several graphemes keeps `start` until the one that ends it.
        const ranges = []
        let matchIndex = 0
        let normalizedOffset = 0
        let start = null
        for (const { segment, index } of TEXT_SEGMENTER.segment(text.normalize('NFKD'))) {
            const normalizedEnd = normalizedOffset + segment.normalize('NFKC').toLowerCase().length
            while (matchIndex < matches.length && matches[matchIndex].index < normalizedEnd) {
                const match = matches[matchIndex]
                if (start === null) start = sourceOffsets[index].start
                if (match.index + match[0].length > normalizedEnd) break
                const end = sourceOffsets[index + segment.length - 1].end
                const previous = ranges[ranges.length - 1]
                // Several normalized words can belong to one original glyph.
                if (previous && start < previous.end) previous.end = end
                else ranges.push({ start, end })
                start = null
                matchIndex++
            }
            if (matchIndex === matches.length) break
            normalizedOffset = normalizedEnd
        }
        return ranges
    }

    // Splits a text node around the words `shouldCover` accepts. Returns null
    // when nothing needs covering, otherwise the replacement fragment plus the
    // nodes inside it so callers can keep their own bookkeeping.
    function splitTextNodeByWords(textNode, shouldCover) {
        const text = textNode.nodeValue || ''
        const fragment = document.createDocumentFragment()
        const plainTextNodes = []
        const covers = []
        let color = null
        let lastIndex = 0

        const appendPlain = (value) => {
            if (!value) return
            const node = document.createTextNode(value)
            plainTextNodes.push(node)
            fragment.appendChild(node)
        }

        for (const { start, end } of coveredTextRanges(text, shouldCover)) {
            // getComputedStyle forces a style flush; pay it once, and only for
            // nodes that actually get a cover.
            if (color === null) color = coverColorFor(composedParent(textNode))
            appendPlain(text.slice(lastIndex, start))
            const cover = createWordCover(text.slice(start, end), color)
            covers.push(cover)
            fragment.appendChild(cover)
            lastIndex = end
        }

        if (covers.length === 0) return null
        appendPlain(text.slice(lastIndex))
        return { fragment, plainTextNodes, covers }
    }

    // Replaces a cover span with its own children. A page can add elements or
    // listeners inside the span, so the children move instead of being
    // flattened to text. Returns the moved nodes.
    function unwrapWordCover(wrapper) {
        const parent = wrapper.parentNode
        if (!parent) return []
        const moved = [...wrapper.childNodes]
        const replacement = document.createDocumentFragment()
        while (wrapper.firstChild) replacement.appendChild(wrapper.firstChild)
        parent.replaceChild(replacement, wrapper)
        return moved
    }

    class PageTextIndex {
        constructor(options = {}) {
            this._textTokens = new Map()
            this._tokenCounts = new Map()
            this._targetWords = new Set()
            this._titleTokens = []
            this._root = null
            // Non-null only while applyMutations runs, so build() and direct
            // indexTextNode calls record no vocabulary deltas.
            this._recentAdded = null
            this._recentRemoved = null
            // Lets the owner cover a trigger word the moment its text node is
            // indexed, independent of the page-wide analysis verdict.
            this._onDirectMatch = typeof options.onDirectMatch === 'function'
                ? options.onDirectMatch
                : null
            this._onOwnedCoverChange = typeof options.onOwnedCoverChange === 'function'
                ? options.onOwnedCoverChange
                : null
            this._isOwnedCover = typeof options.isOwnedCover === 'function'
                ? options.isOwnedCover
                : () => false
            // Lets the ancestor walks below be skipped entirely on the many
            // pages that hold no word covers at all.
            this._hasOwnedCovers = typeof options.hasOwnedCovers === 'function'
                ? options.hasOwnedCovers
                : () => true
        }

        build(root) {
            this.clear()
            this._root = root || document.body || document.documentElement
            if (this._root) this._indexSubtree(this._root)
            this._refreshTitle()
        }

        // Report net vocabulary changes. Removing the last occurrence can clear
        // a verdict; replacing a node with identical text must not restart it.
        applyMutations(records) {
            this._recentAdded = new Set()
            this._recentRemoved = new Set()
            const mutations = (Array.isArray(records) ? records : [])
                .filter(mutation => mutation && mutation.target)
            const changedCovers = new Set()
            const removedRoots = []
            const trackCovers = Boolean(this._onOwnedCoverChange) && this._hasOwnedCovers()

            // Reconciliation can replace a cover's contents synchronously. Drop
            // removed nodes first, including old text no longer inside a cover,
            // and include the replacement text in this batch's net vocabulary.
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    removedRoots.push(...mutation.removedNodes)
                }
                if (!trackCovers || (mutation.type !== 'characterData' && mutation.type !== 'childList')) continue
                const cover = this._findOwnedCover(mutation.target)
                if (cover && cover.isConnected !== false) changedCovers.add(cover)
            }
            minimalRoots(removedRoots).forEach(node => this._removeSubtree(node))
            changedCovers.forEach(cover => this._onOwnedCoverChange(cover))

            const changedRoots = []
            let titleChanged = false
            for (const mutation of mutations) {
                titleChanged = titleChanged || this._mutationTouchesTitle(mutation)

                if (mutation.type === 'characterData') {
                    if (!this._isInsideTitle(mutation.target)) changedRoots.push(mutation.target)
                    continue
                }

                if (mutation.type === 'attributes') {
                    if (VISIBILITY_ATTRIBUTES.has(mutation.attributeName)) changedRoots.push(mutation.target)
                    continue
                }

                if (mutation.type !== 'childList') continue

                mutation.addedNodes.forEach((node) => {
                    if (!this._isInsideTitle(node)) changedRoots.push(node)
                })
            }
            if (titleChanged) this._refreshTitle()
            minimalRoots(changedRoots).forEach(node => this._reindexSubtree(node))

            const added = this._recentAdded
            const removed = this._recentRemoved
            this._recentAdded = null
            this._recentRemoved = null
            return { added, removed }
        }

        // Counts drop to zero are deleted, so every key is a word on the page.
        getWords() {
            return [...this._tokenCounts.keys()]
        }

        get wordCount() {
            return this._tokenCounts.size
        }

        getTokenCount(word) {
            return this._tokenCounts.get(word) || 0
        }

        setTargetWords(words) {
            this._targetWords = new Set(policy.normalizeTargetWords(words).valid)
        }

        clear() {
            this._textTokens.clear()
            this._tokenCounts.clear()
            this._titleTokens = []
            this._root = null
        }

        removeTextNode(node) {
            if (!this._textTokens.has(node)) return false
            this._removeTokens(this._textTokens.get(node))
            this._textTokens.delete(node)
            return true
        }

        indexTextNode(node, options = {}) {
            if (!node || node.nodeType !== Node.TEXT_NODE) return false
            // Title text is tracked by _refreshTitle; indexing it here would count it twice.
            if (this._isInsideTitle(node)) return false

            const previous = this._textTokens.get(node) || []
            const eligible = this._isEligibleTextNode(node)
            const next = eligible ? tokenize(node.nodeValue || '') : []
            const unchanged = previous.length === next.length &&
                previous.every((word, index) => word === next[index])
            if (unchanged) return false

            if (previous.length > 0) this._removeTokens(previous)
            if (next.length === 0) {
                this._textTokens.delete(node)
                return previous.length > 0
            }

            this._textTokens.set(node, next)
            this._addTokens(next)

            // Text already inside an owned cover is the trigger word itself; reporting
            // it would nest a cover in a cover and recurse through the owner's handling.
            if (options.notify !== false && this._onDirectMatch && this._targetWords.size > 0 &&
                !(this._hasOwnedCovers() && this._findOwnedCover(node))) {
                const directMatches = new Set(next.filter(word => this._targetWords.has(word)))
                if (directMatches.size > 0) this._onDirectMatch(node, directMatches)
            }

            return true
        }

        _indexSubtree(node) {
            if (!node) return
            if (node.nodeType === Node.TEXT_NODE) {
                this.indexTextNode(node)
                return
            }
            if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE &&
                node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return
            if (node.nodeType === Node.ELEMENT_NODE && node.matches(EXCLUDED_SELECTOR)) return

            // Editability can be overridden by descendants, so test it per text
            // node. Collect first: callbacks can replace text with word covers.
            collectTextNodes(node).forEach(textNode => this.indexTextNode(textNode))
        }

        // Walks only the removed subtree. The previous implementation scanned
        // every indexed text node per removed node, which is quadratic on pages
        // that churn their DOM (feeds, infinite scroll).
        _removeSubtree(node) {
            if (!node) return
            if (node.nodeType === Node.TEXT_NODE) {
                this.removeTextNode(node)
                return
            }
            if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE &&
                node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return

            collectTextNodes(node).forEach(textNode => this.removeTextNode(textNode))
        }

        // Diff-based: indexTextNode already compares old and new tokens per node
        // and reports no change when the vocabulary is identical, so a class or
        // style toggle that does not alter visible text costs nothing downstream.
        _reindexSubtree(node) {
            // An element that just became hidden or aria-hidden takes its whole
            // subtree out of the vocabulary.
            if (node && node.nodeType === Node.ELEMENT_NODE && node.matches(EXCLUDED_SELECTOR)) {
                this._removeSubtree(node)
                return
            }
            this._indexSubtree(node)
        }

        _addTokens(tokens) {
            // Deltas are net per batch: a word whose last occurrence was removed and
            // then re-added in the same batch cancels out instead of looking new.
            tokens.forEach((word) => {
                const previous = this._tokenCounts.get(word) || 0
                if (previous === 0 && this._recentAdded && !this._recentRemoved.delete(word)) {
                    this._recentAdded.add(word)
                }
                this._tokenCounts.set(word, previous + 1)
            })
        }

        _removeTokens(tokens) {
            // Mirror of _addTokens: a removal cancels an addition from the same batch.
            tokens.forEach((word) => {
                const next = (this._tokenCounts.get(word) || 0) - 1
                if (next > 0) this._tokenCounts.set(word, next)
                else {
                    this._tokenCounts.delete(word)
                    if (next === 0 && this._recentRemoved && !this._recentAdded.delete(word)) {
                        this._recentRemoved.add(word)
                    }
                }
            })
        }

        // <title> sits in <head> and never has a client rect, so its text would
        // fail the visibility test below. The tab title is still text the user
        // sees, so it is indexed from document.title as its own token list.
        _refreshTitle() {
            const next = tokenize(document.title || '')
            const unchanged = this._titleTokens.length === next.length &&
                this._titleTokens.every((word, index) => word === next[index])
            if (unchanged) return

            this._removeTokens(this._titleTokens)
            this._titleTokens = next
            this._addTokens(next)
        }

        _mutationTouchesTitle(mutation) {
            if (this._isInsideTitle(mutation.target)) return true
            if (mutation.type !== 'childList') return false
            return [...mutation.addedNodes, ...mutation.removedNodes].some(node => this._isInsideTitle(node))
        }

        _isInsideTitle(node) {
            const element = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
            return Boolean(element && (element.tagName === 'TITLE' || element.closest?.('title')))
        }

        _shouldSkipElement(element) {
            if (!element || !element.matches) return false
            return isEditableElement(element) || element.matches(EXCLUDED_SELECTOR)
        }

        _findOwnedCover(node) {
            let current = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
            while (current) {
                if (this._isOwnedCover(current)) return current
                current = current.parentElement
            }
            return null
        }

        _isEligibleTextNode(node) {
            const parent = composedParent(node)
            // Only an explicit false counts as disconnected, matching the controller's
            // checks, so DOM stubs that lack isConnected are still indexed.
            if (!parent || node.isConnected === false) return false

            if (this._shouldSkipElement(parent) || closestAcrossRoots(parent, EXCLUDED_SELECTOR)) return false

            // Only text the user can actually see counts, so hidden templates, menus
            // and SEO text do not blur a page whose visible content is clean. This is
            // why the controller rebuilds the index whenever stylesheets change.
            try {
                if (parent.getClientRects().length === 0) return false
                const style = getComputedStyle(parent)
                if (!style || style.display === 'none' || style.visibility === 'hidden' ||
                    style.visibility === 'collapse' || style.contentVisibility === 'hidden') {
                    return false
                }
            } catch (_) {
                return false
            }

            return true
        }
    }

    // Shared with the early-blur shim and the controller's word covers so the
    // exclusion list and cover markup cannot drift between them.
    Object.assign(PageTextIndex, {
        EXCLUDED_SELECTOR, collectDomRoots, composedParent, closestAcrossRoots, minimalRoots,
        collectTextNodes, splitTextNodeByWords, unwrapWordCover,
        isEditableElement, isEditableDocument, containsEditingSurface,
    })

    globalThis.PhobiaBlockerPageTextIndex = PageTextIndex
})()
