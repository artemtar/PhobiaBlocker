/* global nlp */

// Offscreen document: the one NLP context every frame shares. It answers
// PB_ANALYZE_SCOPES from the service worker and never talks to pages directly.
(() => {
    'use strict'

    const policy = globalThis.PhobiaBlockerPolicy
    if (!policy) throw new Error('PhobiaBlockerPolicy must load before offscreen.js')

    const { FAIL_CLOSED_RESULT, CLEAR_RESULT } = policy
    let debugMode = false
    const debug = policy.createDebugLogger('offscreen', () => debugMode)
    // compromise normalize() options. Targets and page words go through the
    // same set so inflections and surface noise fold onto one comparable form.
    const NORMALIZE_PARAMS = Object.freeze({
        whitespace: true,
        unicode: true,
        contractions: true,
        acronyms: true,
        possessives: true,
        plurals: true,
        verbs: true,
    })

    // Page words are normalized in groups of this size: one nlp() call over a
    // whole vocabulary builds a large document, and a dropped token (see the
    // fallback in analyzeWords) costs only a per-word re-run of its batch.
    const NORMALIZE_BATCH_SIZE = 256
    // Anchored twin of the shared WORD_RE: it validates one whole token here
    // rather than finding tokens inside text.
    const WORD_RE = /^[-\p{L}]+$/u

    // Cached per distinct target list and rebuilt only when the key changes, so
    // repeated requests from many frames skip the expansion work.
    let targetArtifacts = {
        key: '',
        literalTargetSet: new Set(),
        normalizedTargetSet: new Set(),
    }

    function normalizeWords(words) {
        if (!Array.isArray(words)) return []
        return [...new Set(
            words
                .map((word) => typeof word === 'string' ? word.toLowerCase().trim() : '')
                // Drop empty, two-character and non-letter tokens before they reach the sets:
                // roughly validateTargetWord's three-letter floor (hyphens count here), so
                // page noise that could never equal a valid target is not normalized.
                .filter((word) => word.length > 2 && WORD_RE.test(word))
        )]
    }

    // Generates the inflections of each target so that, whichever base form
    // normalize() picks for a page word, some variant of the target lands on it
    // too. Hyphenated targets are kept out by the caller and matched literally.
    function expandTargetWords(rawWords) {
        const expandedWords = []
        const safeWords = Array.isArray(rawWords) ? rawWords : []

        safeWords.forEach((rawWord) => {
            if (typeof rawWord !== 'string') return
            const word = rawWord.trim()
            if (!word) return

            expandedWords.push(word.toLowerCase())

            const nlpWord = nlp(word)
            const plural = nlpWord.nouns().toPlural().text()
            if (plural) expandedWords.push(plural.toLowerCase())

            const singular = nlpWord.nouns().toSingular().text()
            if (singular) expandedWords.push(singular.toLowerCase())

            const pastTense = nlpWord.verbs().toPastTense().text()
            if (pastTense) expandedWords.push(pastTense.toLowerCase())

            const presentTense = nlpWord.verbs().toPresentTense().text()
            if (presentTense) expandedWords.push(presentTense.toLowerCase())

            const gerund = nlpWord.verbs().toGerund().text()
            if (gerund) expandedWords.push(gerund.toLowerCase())
        })

        return normalizeWords(expandedWords)
    }

    function rebuildTargetWordArtifacts(rawWords) {
        if (!Array.isArray(rawWords)) {
            throw new TypeError('Analysis target words must be an array')
        }

        const validatedTargets = policy.normalizeTargetWords(rawWords).valid
        // The worker answers CLEAR itself for an empty list and never sends one,
        // so no valid target here means a malformed request: fail closed.
        if (validatedTargets.length === 0) {
            throw new TypeError('Analysis requires at least one valid target word')
        }
        const key = JSON.stringify(validatedTargets)
        if (key === targetArtifacts.key) return

        // NLP splits hyphenated words and can expand just one component
        // (for example, spider-man becomes man). Match compounds literally.
        const expandedRawTargets = expandTargetWords(
            validatedTargets.filter(word => !word.includes('-'))
        )
        // Targets take the same normalize() pass as page words, so the comparison
        // happens in compromise's output form rather than in raw spelling.
        const normalizedWords = expandedRawTargets.length > 0
            ? normalizeWords(nlp(expandedRawTargets).normalize(NORMALIZE_PARAMS).out('array'))
            : []
        targetArtifacts = {
            key,
            literalTargetSet: new Set(validatedTargets),
            normalizedTargetSet: new Set(normalizedWords),
        }
        debug('analysis.targets-normalized', () => ({
            literalTargetCount: targetArtifacts.literalTargetSet.size,
            normalizedTargetCount: targetArtifacts.normalizedTargetSet.size,
        }))
    }

    function analyzeWords(words) {
        // No prepared targets means the rebuild threw or never ran; never answer
        // clear from an unprepared state.
        if (!Array.isArray(words) || targetArtifacts.literalTargetSet.size === 0) {
            return { ...FAIL_CLOSED_RESULT }
        }

        const uniqueWords = normalizeWords(words)
        if (uniqueWords.length === 0) return { ...CLEAR_RESULT }

        // Normalization can change the first letters (fell -> fall), so raw
        // prefixes cannot safely exclude a page word before NLP processes it.
        const normalizedPageWords = new Array(uniqueWords.length)
        // If no target survived normalize() (all hyphenated, or tokens compromise drops
        // such as kana-only words) there is nothing to compare normalized page words
        // against, so the NLP pass is skipped and only the literal check below runs.
        if (targetArtifacts.normalizedTargetSet.size > 0) {
            // Bounded batches keep the NLP library's large-document work small.
            for (let start = 0; start < uniqueWords.length; start += NORMALIZE_BATCH_SIZE) {
                const batch = uniqueWords.slice(start, start + NORMALIZE_BATCH_SIZE)
                // NLP can drop entire phrases, including kana-only words. Retry
                // that batch individually to preserve every original input slot.
                let entries = nlp(batch).normalize(NORMALIZE_PARAMS).json({ terms: false })
                if (entries.length !== batch.length) {
                    debug('analysis.normalization-fallback', () => ({ wordCount: batch.length }))
                    entries = batch.map(word => ({
                        text: nlp(word).normalize(NORMALIZE_PARAMS).text(),
                    }))
                }
                entries.forEach((entry, index) => {
                    // A normalized form that is no longer one valid token (a space from a split
                    // compound, an empty or tiny result) leaves undefined in its slot; Set.has
                    // never matches undefined, so that page word can only match literally.
                    normalizedPageWords[start + index] = normalizeWords([entry.text])[0]
                })
            }
        }

        const matchedWords = new Set(
            normalizedPageWords.filter((word) => targetArtifacts.normalizedTargetSet.has(word))
        )
        // literalTargetSet holds every validated target as typed. The raw-token check
        // is what catches targets normalize() cannot represent: hyphenated compounds
        // (split into words) and tokens compromise drops outright, such as kana-only
        // words. A Latin target spelled exactly as on the page matches here too.
        const hasLiteralMatch = uniqueWords.some(word => targetArtifacts.literalTargetSet.has(word))
        if (matchedWords.size === 0 && !hasLiteralMatch) return { ...CLEAR_RESULT }

        // Map each match back to the page token it came from: getTriggeredWords in
        // js.js counts matchedInputWords against the page's token index for the
        // popup, while matchedWords are the normalized forms and only a display
        // fallback. normalizedPageWords is reused so the mapping is index-exact.
        const matchedInputWords = new Set()
        uniqueWords.forEach((word, index) => {
            if (!targetArtifacts.normalizedTargetSet.has(normalizedPageWords[index])) {
                if (!targetArtifacts.literalTargetSet.has(word)) return
                matchedWords.add(word)
            }
            matchedInputWords.add(word)
        })

        return {
            shouldBlur: true,
            matchedWords: [...matchedWords],
            matchedInputWords: [...matchedInputWords],
        }
    }

    function analyzeScopes(scopes) {
        if (!Array.isArray(scopes)) return []
        return scopes
            .filter((scope) => scope && typeof scope.id === 'number')
            .map((scope) => ({
                id: scope.id,
                ...analyzeWords(scope.words),
            }))
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || message.target !== 'offscreen' || message.type !== 'PB_ANALYZE_SCOPES') return
        // This document reads no storage; the worker forwards its debug flag.
        debugMode = message.debugMode === true
        debug('message.received', () => ({ type: 'PB_ANALYZE_SCOPES' }))

        try {
            rebuildTargetWordArtifacts(message.targetWords)
            if (!Array.isArray(message.scopes) || message.scopes.some(scope => (
                !scope || typeof scope.id !== 'number' || !Array.isArray(scope.words) ||
                scope.words.some(word => typeof word !== 'string')
            ))) {
                throw new TypeError('Analysis scopes must contain numeric IDs and string word arrays')
            }
            const results = analyzeScopes(message.scopes)
            debug('analysis.completed', () => ({
                scopeCount: results.length,
                inputWordCount: message.scopes.reduce((count, scope) => count + scope.words.length, 0),
                blurredScopeCount: results.filter(result => result.shouldBlur).length,
                matchedWordCount: results.reduce((count, result) => count + result.matchedInputWords.length, 0),
            }))
            sendResponse({ results })
        } catch (error) {
            console.error('PhobiaBlocker: invalid scoped analysis request', error)
            // Answer fail-closed for every scope the request named, so the
            // worker's per-id check still sees a complete reply and each frame blurs.
            const scopes = Array.isArray(message.scopes) ? message.scopes : []
            sendResponse({
                results: scopes
                    .filter(scope => scope && typeof scope.id === 'number')
                    .map(scope => ({ id: scope.id, ...FAIL_CLOSED_RESULT })),
            })
        }
    })
})()
