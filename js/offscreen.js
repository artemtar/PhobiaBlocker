(() => {
    'use strict'

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
        const key = JSON.stringify(rawWords ?? [])
        if (key === targetArtifacts.key) return

        const expandedRawTargets = expandTargetWords(rawWords)
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

    function analyzeWords(words) {
        if (!Array.isArray(words) || targetArtifacts.normalizedTargetSet.size === 0) {
            return { shouldBlur: false, matchedWords: [] }
        }

        const uniqueWords = normalizeWords(words)
        if (uniqueWords.length === 0) {
            return { shouldBlur: false, matchedWords: [] }
        }

        const prefixFilteredWords = uniqueWords.filter((word) =>
            targetArtifacts.prefixSet.has(word.slice(0, 2))
        )
        if (prefixFilteredWords.length === 0) {
            return { shouldBlur: false, matchedWords: [] }
        }

        const normalizedPageWords = normalizeWords(
            nlp(prefixFilteredWords)
                .normalize(NORMALIZE_PARAMS)
                .out('array')
        )

        const matchedWords = [...new Set(
            normalizedPageWords.filter((word) => targetArtifacts.normalizedTargetSet.has(word))
        )]

        return {
            shouldBlur: matchedWords.length > 0,
            matchedWords,
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
            rebuildTargetWordArtifacts(message.targetWords)
            sendResponse({ results: analyzeScopes(message.scopes) })
            return
        }

        if (message.type === 'PB_ANALYZE_WORDS') {
            rebuildTargetWordArtifacts(message.targetWords)
            sendResponse(analyzeWords(message.words))
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
