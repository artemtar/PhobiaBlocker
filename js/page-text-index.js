(() => {
    'use strict'

    if (globalThis.PhobiaBlockerPageTextIndex) return

    const policy = globalThis.PhobiaBlockerPolicy
    if (!policy) throw new Error('PhobiaBlockerPolicy must load before page-text-index.js')

    // Text inside these elements is neither indexed nor covered.
    const EXCLUDED_SELECTOR = [
        'script', 'style', 'noscript', 'input', 'textarea', 'select', 'option',
        'form', '[contenteditable="true"]', '[hidden]', '[aria-hidden="true"]',
    ].join(', ')
    const WORD_RE = policy.WORD_RE
    const HAS_THREE_LETTERS_RE = /(?:\P{L}*\p{L}){3}/u
    const VISIBILITY_ATTRIBUTES = new Set(['class', 'style', 'hidden', 'aria-hidden'])
    const TEXT_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

    function tokenize(value) {
        const normalized = typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : ''
        return (normalized.match(WORD_RE) || []).filter(word => HAS_THREE_LETTERS_RE.test(word))
    }

    function collectTextNodes(root) {
        const textNodes = []
        try {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
            let current = walker.nextNode()
            while (current) {
                textNodes.push(current)
                current = walker.nextNode()
            }
        } catch (_) {
            return []
        }
        return textNodes
    }

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
        cover.setAttribute('title', 'Covered by PhobiaBlocker')
        cover.setAttribute('aria-label', 'Covered by PhobiaBlocker')
        cover.style.setProperty('--phobiablocker-word-cover-color', color)
        cover.textContent = word
        return cover
    }

    function coveredTextRanges(text, shouldCover) {
        const normalized = text.normalize('NFKC').toLowerCase()
        const matches = [...normalized.matchAll(WORD_RE)].filter(match => shouldCover(match[0]))
        if (matches.length === 0) return []
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
            if (color === null) color = coverColorFor(textNode.parentElement)
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
            this._recentAdded = null
            this._recentRemoved = null
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
            const trackCovers = Boolean(this._onOwnedCoverChange) && this._hasOwnedCovers()

            // Reconciliation can replace a cover's contents synchronously. Drop
            // removed nodes first, including old text no longer inside a cover,
            // and include the replacement text in this batch's net vocabulary.
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    mutation.removedNodes.forEach(node => this._removeSubtree(node))
                }
                if (!trackCovers || (mutation.type !== 'characterData' && mutation.type !== 'childList')) continue
                const cover = this._findOwnedCover(mutation.target)
                if (cover && cover.isConnected !== false) changedCovers.add(cover)
            }
            changedCovers.forEach(cover => this._onOwnedCoverChange(cover))

            for (const mutation of mutations) {
                if (this._mutationTouchesTitle(mutation)) this._refreshTitle()

                if (mutation.type === 'characterData') {
                    if (!this._isInsideTitle(mutation.target)) this.indexTextNode(mutation.target)
                    continue
                }

                if (mutation.type === 'attributes') {
                    if (VISIBILITY_ATTRIBUTES.has(mutation.attributeName)) this._reindexSubtree(mutation.target)
                    continue
                }

                if (mutation.type !== 'childList') continue

                mutation.addedNodes.forEach((node) => {
                    if (!this._isInsideTitle(node)) this._indexSubtree(node)
                })
            }

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
            if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return
            if (node.nodeType === Node.ELEMENT_NODE && this._shouldSkipElement(node)) return

            // Finish collecting before callbacks can replace text with word covers.
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
            if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return

            collectTextNodes(node).forEach(textNode => this.removeTextNode(textNode))
        }

        // Diff-based: indexTextNode already compares old and new tokens per node
        // and reports no change when the vocabulary is identical, so a class or
        // style toggle that does not alter visible text costs nothing downstream.
        _reindexSubtree(node) {
            if (node && node.nodeType === Node.ELEMENT_NODE && this._shouldSkipElement(node)) {
                this._removeSubtree(node)
                return
            }
            this._indexSubtree(node)
        }

        _addTokens(tokens) {
            tokens.forEach((word) => {
                const previous = this._tokenCounts.get(word) || 0
                if (previous === 0 && this._recentAdded && !this._recentRemoved.delete(word)) {
                    this._recentAdded.add(word)
                }
                this._tokenCounts.set(word, previous + 1)
            })
        }

        _removeTokens(tokens) {
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
            return element.matches(EXCLUDED_SELECTOR)
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
            const parent = node && node.parentElement
            if (!parent || node.isConnected === false) return false

            if (parent.closest && parent.closest(EXCLUDED_SELECTOR)) return false

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
    Object.assign(PageTextIndex, { EXCLUDED_SELECTOR, collectTextNodes, splitTextNodeByWords, unwrapWordCover })

    globalThis.PhobiaBlockerPageTextIndex = PageTextIndex
})()
