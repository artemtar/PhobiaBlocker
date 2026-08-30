(() => {
    'use strict'

    if (globalThis.PhobiaBlockerPageTextIndex) return

    const EXCLUDED_SELECTOR = [
        'script', 'style', 'noscript', 'input', 'textarea', 'select', 'option',
        'form', '[contenteditable="true"]', '[hidden]', '[aria-hidden="true"]',
    ].join(', ')
    const TOKEN_RE = /[-\p{L}]+/gu
    const VISIBILITY_ATTRIBUTES = new Set(['class', 'style', 'hidden', 'aria-hidden'])

    function tokenize(value) {
        const normalized = typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : ''
        const matches = normalized.match(TOKEN_RE) || []
        return matches.filter(word => (word.match(/\p{L}/gu) || []).length >= 3)
    }

    class PageTextIndex {
        constructor(options = {}) {
            this._textTokens = new Map()
            this._tokenCounts = new Map()
            this._targetWords = new Set()
            this._titleTokens = []
            this._root = null
            this._onDirectMatch = typeof options.onDirectMatch === 'function'
                ? options.onDirectMatch
                : null
            this._isOwnedCover = typeof options.isOwnedCover === 'function'
                ? options.isOwnedCover
                : () => false
        }

        build(root) {
            this.clear()
            this._root = root || document.body || document.documentElement
            if (this._root) this._indexSubtree(this._root)
            this._refreshTitle()
            return this.getWords()
        }

        applyMutations(records) {
            let changed = false

            for (const mutation of Array.isArray(records) ? records : []) {
                if (!mutation || !mutation.target) continue

                if (this._mutationTouchesTitle(mutation)) {
                    changed = this._refreshTitle() || changed
                }

                if (mutation.type === 'characterData') {
                    if (!this._isInsideTitle(mutation.target)) {
                        changed = this.indexTextNode(mutation.target) || changed
                    }
                    continue
                }

                if (mutation.type === 'attributes') {
                    if (VISIBILITY_ATTRIBUTES.has(mutation.attributeName)) {
                        changed = this._reindexSubtree(mutation.target) || changed
                    }
                    continue
                }

                if (mutation.type !== 'childList') continue

                mutation.removedNodes.forEach((node) => {
                    changed = this._removeSubtree(node) || changed
                })
                mutation.addedNodes.forEach((node) => {
                    if (this._isInsideTitle(node)) return
                    changed = this._indexSubtree(node) || changed
                })
            }

            return changed
        }

        getWords() {
            return [...this._tokenCounts.entries()]
                .filter(([, count]) => count > 0)
                .map(([word]) => word)
                .sort()
        }

        setTargetWords(words) {
            const normalized = globalThis.PhobiaBlockerPolicy
                ? globalThis.PhobiaBlockerPolicy.normalizeTargetWords(words).valid
                : []
            this._targetWords = new Set(normalized)
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
                !this._insideOwnedCover(node)) {
                const directMatches = new Set(next.filter(word => this._targetWords.has(word)))
                if (directMatches.size > 0) this._onDirectMatch(node, directMatches)
            }

            return true
        }

        _indexSubtree(node) {
            if (!node) return false
            if (node.nodeType === Node.TEXT_NODE) return this.indexTextNode(node)
            if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return false

            const textNodes = []
            if (node.nodeType === Node.ELEMENT_NODE && this._shouldSkipElement(node)) return false

            try {
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
                let current = walker.nextNode()
                while (current) {
                    textNodes.push(current)
                    current = walker.nextNode()
                }
            } catch (_) {
                return false
            }

            let changed = false
            textNodes.forEach((textNode) => {
                changed = this.indexTextNode(textNode) || changed
            })
            return changed
        }

        _removeSubtree(node) {
            if (!node) return false
            if (node.nodeType === Node.TEXT_NODE) return this.removeTextNode(node)

            let changed = false
            for (const textNode of [...this._textTokens.keys()]) {
                try {
                    if (node === textNode || (node.contains && node.contains(textNode))) {
                        changed = this.removeTextNode(textNode) || changed
                    }
                } catch (_) { /* Detached nodes are already absent from the index. */ }
            }
            return changed
        }

        _reindexSubtree(node) {
            const removed = this._removeSubtree(node)
            const added = this._indexSubtree(node)
            return removed || added
        }

        _addTokens(tokens) {
            tokens.forEach((word) => {
                this._tokenCounts.set(word, (this._tokenCounts.get(word) || 0) + 1)
            })
        }

        _removeTokens(tokens) {
            tokens.forEach((word) => {
                const next = (this._tokenCounts.get(word) || 0) - 1
                if (next > 0) this._tokenCounts.set(word, next)
                else this._tokenCounts.delete(word)
            })
        }

        _refreshTitle() {
            const next = tokenize(document.title || '')
            const unchanged = this._titleTokens.length === next.length &&
                this._titleTokens.every((word, index) => word === next[index])
            if (unchanged) return false

            this._removeTokens(this._titleTokens)
            this._titleTokens = next
            this._addTokens(next)
            return true
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

        _insideOwnedCover(node) {
            let current = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
            while (current) {
                if (this._isOwnedCover(current)) return true
                current = current.parentElement
            }
            return false
        }

        _isEligibleTextNode(node) {
            const parent = node && node.parentElement
            if (!parent) return false

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

    globalThis.PhobiaBlockerPageTextIndex = PageTextIndex
})()
