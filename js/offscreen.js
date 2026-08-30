/* global nlp */

(() => {
    'use strict'

    const policy = globalThis.PhobiaBlockerPolicy
    if (!policy) throw new Error('PhobiaBlockerPolicy must load before offscreen.js')

    const NORMALIZE_PARAMS = Object.freeze({
        whitespace: true,
        unicode: true,
        contractions: true,
        acronyms: true,
        possessives: true,
        plurals: true,
        verbs: true,
    })

    const WORD_RE = /^[-\p{L}]+$/u
    const FAIL_CLOSED_RESULT = Object.freeze({
        shouldBlur: true,
        matchedWords: [],
        matchedInputWords: [],
    })

    let targetArtifacts = {
        key: '',
        expandedRawTargets: [],
        normalizedTargetSet: new Set(),
        prefixSet: new Set(),
    }

    function normalizeWords(words) {
        if (!Array.isArray(words)) return []
        return [...new Set(
            words
                .map((word) => typeof word === 'string' ? word.toLowerCase().trim() : '')
                .filter((word) => word.length > 2 && WORD_RE.test(word))
        )]
    }

    function buildPrefixSet(words) {
        const prefixes = new Set()
        words.forEach((word) => {
            if (typeof word !== 'string' || word.length < 2) return
            prefixes.add(word.slice(0, 2))
        })
        return prefixes
    }

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
        if (validatedTargets.length === 0) {
            throw new TypeError('Analysis requires at least one valid target word')
        }
        const key = JSON.stringify(validatedTargets)
        if (key === targetArtifacts.key) return

        const expandedRawTargets = expandTargetWords(validatedTargets)
        const normalizedWords = expandedRawTargets.length > 0
            ? normalizeWords(nlp(expandedRawTargets).normalize(NORMALIZE_PARAMS).out('array'))
            : []
        const prefixSet = buildPrefixSet([...expandedRawTargets, ...normalizedWords])

        targetArtifacts = {
            key,
            expandedRawTargets,
            normalizedTargetSet: new Set(normalizedWords),
            prefixSet,
        }
    }

    function normalizePageWord(word) {
        try {
            return normalizeWords(
                nlp(word)
                    .normalize(NORMALIZE_PARAMS)
                    .out('array')
            )
        } catch (_) {
            return normalizeWords([word])
        }
    }

    function analyzeWords(words) {
        if (!Array.isArray(words) || targetArtifacts.normalizedTargetSet.size === 0) {
            return { ...FAIL_CLOSED_RESULT }
        }

        const uniqueWords = normalizeWords(words)
        if (uniqueWords.length === 0) {
            return { shouldBlur: false, matchedWords: [], matchedInputWords: [] }
        }

        const prefixFilteredWords = uniqueWords.filter((word) =>
            targetArtifacts.prefixSet.has(word.slice(0, 2))
        )
        if (prefixFilteredWords.length === 0) {
            return { shouldBlur: false, matchedWords: [], matchedInputWords: [] }
        }

        const normalizedPageWords = normalizeWords(
            nlp(prefixFilteredWords)
                .normalize(NORMALIZE_PARAMS)
                .out('array')
        )

        const matchedWords = new Set(
            normalizedPageWords.filter((word) => targetArtifacts.normalizedTargetSet.has(word))
        )
        const matchedInputWords = new Set()

        prefixFilteredWords.forEach((word) => {
            const normalizedPageWords = normalizePageWord(word)
            const normalizedMatches = normalizedPageWords.filter((normalizedWord) =>
                targetArtifacts.normalizedTargetSet.has(normalizedWord)
            )
            if (normalizedMatches.length === 0) return
            matchedInputWords.add(word)
        })

        return {
            shouldBlur: matchedWords.size > 0,
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
        if (!message || message.target !== 'offscreen') return

        if (message.type === 'PB_ANALYZE_SCOPES') {
            try {
                rebuildTargetWordArtifacts(message.targetWords)
                if (!Array.isArray(message.scopes) || message.scopes.some(scope => (
                    !scope || typeof scope.id !== 'number' || !Array.isArray(scope.words) ||
                    scope.words.some(word => typeof word !== 'string')
                ))) {
                    throw new TypeError('Analysis scopes must contain numeric IDs and string word arrays')
                }
                sendResponse({ results: analyzeScopes(message.scopes) })
            } catch (error) {
                console.error('PhobiaBlocker: invalid scoped analysis request', error)
                const scopes = Array.isArray(message.scopes) ? message.scopes : []
                sendResponse({
                    results: scopes
                        .filter(scope => scope && typeof scope.id === 'number')
                        .map(scope => ({ id: scope.id, ...FAIL_CLOSED_RESULT })),
                })
            }
            return
        }

        if (message.type === 'PB_ANALYZE_WORDS') {
            try {
                rebuildTargetWordArtifacts(message.targetWords)
                if (!Array.isArray(message.words)) throw new TypeError('Analysis words must be an array')
                sendResponse(analyzeWords(message.words))
            } catch (error) {
                console.error('PhobiaBlocker: invalid analysis request', error)
                sendResponse({ ...FAIL_CLOSED_RESULT })
            }
            return
        }

        if (message.type === 'PB_PING') {
            sendResponse({ ok: true })
        }
    })

    chrome.runtime.sendMessage({
        target: 'background',
        type: 'PB_OFFSCREEN_READY',
    }).catch(() => {})
})()
