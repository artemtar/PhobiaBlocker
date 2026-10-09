const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const scripts = ['compromise.min.js', 'shared-policy.js', 'offscreen.js'].map(file =>
    new vm.Script(fs.readFileSync(path.join(__dirname, '../../js', file), 'utf8'), {
        filename: file,
    })
)

function loadAnalysis() {
    let onMessage
    const context = vm.createContext({
        URL,
        console,
        chrome: {
            runtime: {
                onMessage: { addListener(listener) { onMessage = listener } },
            },
        },
    })
    scripts.forEach(script => script.runInContext(context))

    return {
        policy: context.PhobiaBlockerPolicy,
        analyze(targetWords, words) {
            let response
            onMessage({
                target: 'offscreen',
                type: 'PB_ANALYZE_SCOPES',
                targetWords,
                scopes: [{ id: 7, words }],
            }, {}, result => { response = result })
            assert.ok(response, 'analysis should synchronously return a response')
            return JSON.parse(JSON.stringify(response.results[0]))
        },
    }
}

const { policy, analyze } = loadAnalysis()

for (const word of ['blood-red', 'spider-man', 'near-death', 'a-b-c', 'café', '火山灰']) {
    test(`accepted trigger ${word} matches its exact page token`, () => {
        assert.equal(policy.validateTargetWord(word).valid, true)
        const result = analyze([word], [word])
        assert.equal(result.shouldBlur, true)
        assert.deepEqual(result.matchedInputWords, [word])
        assert.ok(result.matchedWords.length > 0)
    })
}

for (const target of ['blood-red', 'spider-man', 'near-death', 'a-b-c']) {
    test(`compound trigger ${target} leaves clean page text clear`, () => {
        assert.deepEqual(analyze([target], ['garden', 'flowers']), {
            id: 7,
            shouldBlur: false,
            matchedWords: [],
            matchedInputWords: [],
        })
    })
}

for (const [target, words] of [
    ['blood-red', ['blood', 'red', 'blood-reddish']],
    ['spider-man', ['spider', 'man', 'men', 'spider-mania']],
    ['near-death', ['near', 'death', 'deaths', 'near-deathly']],
    ['spider', ['spiderman', 'spidery']],
]) {
    test(`${target} does not match separate components or partial tokens`, () => {
        assert.equal(analyze([target], words).shouldBlur, false)
    })
}

for (const [target, pageWord, normalized] of [
    ['spider', 'spiders', 'spider'],
    ['spiders', 'spider', 'spider'],
    ['mouse', 'mice', 'mouse'],
    ['mice', 'mouse', 'mouse'],
    ['crawl', 'crawling', 'crawl'],
    ['crawling', 'crawl', 'crawl'],
    ['fall', 'fell', 'fall'],
    ['run', 'ran', 'run'],
    ['eat', 'ate', 'eat'],
]) {
    test(`${target} still matches the inflection ${pageWord}`, () => {
        assert.deepEqual(analyze([target], [pageWord]), {
            id: 7,
            shouldBlur: true,
            matchedWords: [normalized],
            matchedInputWords: [pageWord],
        })
    })
}

test('a punctuation-prefixed page word still matches its normalized trigger', () => {
    assert.deepEqual(analyze(['spider'], ['garden', '-spider', 'flowers']), {
        id: 7,
        shouldBlur: true,
        matchedWords: ['spider'],
        matchedInputWords: ['-spider'],
    })
})

test('literal compounds and normal inflections coexist in one analysis', () => {
    const result = analyze(['spider-man', 'mouse'], ['spider-man', 'mice', 'man'])
    assert.equal(result.shouldBlur, true)
    assert.deepEqual(result.matchedInputWords.sort(), ['mice', 'spider-man'])
    assert.deepEqual(result.matchedWords.sort(), ['mouse', 'spider-man'])
})

test('normalization keeps each match associated with its original page word', () => {
    const result = analyze(
        ['fall', 'spider', 'mouse', 'spider-man'],
        ['garden', 'near-death', '---', 'fell', 'spider-man', 'mice', '-spider', 'flowers']
    )
    assert.deepEqual(result, {
        id: 7,
        shouldBlur: true,
        matchedWords: ['fall', 'mouse', 'spider', 'spider-man'],
        matchedInputWords: ['fell', 'spider-man', 'mice', '-spider'],
    })
})

test('matching retains original words across a large page vocabulary', () => {
    const words = Array.from({ length: 600 }, (_, index) => (
        `garden${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`
    ))
    words[255] = 'fell'
    words[256] = 'spider-man'
    words[511] = 'mice'
    words[512] = '-spider'

    assert.deepEqual(analyze(['fall', 'spider', 'mouse', 'spider-man'], words), {
        id: 7,
        shouldBlur: true,
        matchedWords: ['fall', 'mouse', 'spider', 'spider-man'],
        matchedInputWords: ['fell', 'spider-man', 'mice', '-spider'],
    })
})

test('kana-only page text stays clear for unrelated triggers', () => {
    assert.deepEqual(analyze(['spider'], ['アルインコ', 'パナソニック']), {
        id: 7,
        shouldBlur: false,
        matchedWords: [],
        matchedInputWords: [],
    })
})

test('words after a dropped kana token retain their normalized and literal matches', () => {
    assert.deepEqual(analyze(
        ['fall', 'mouse', 'spider-man'],
        ['garden', 'アルインコ', 'fell', 'near-death', 'mice', 'spider-man']
    ), {
        id: 7,
        shouldBlur: true,
        matchedWords: ['fall', 'mouse', 'spider-man'],
        matchedInputWords: ['fell', 'mice', 'spider-man'],
    })
})

test('a literal Japanese trigger mixed with a Latin trigger matches only its own word', () => {
    assert.deepEqual(analyze(['アルインコ', 'spider'], ['garden', 'アルインコ']), {
        id: 7,
        shouldBlur: true,
        matchedWords: ['アルインコ'],
        matchedInputWords: ['アルインコ'],
    })
    assert.deepEqual(analyze(['アルインコ', 'spider'], ['garden', 'パナソニック']), {
        id: 7,
        shouldBlur: false,
        matchedWords: [],
        matchedInputWords: [],
    })
})

for (const rule of [
    'example.com/gallery/',
    'https://example.com/gallery/',
    'http://EXAMPLE.COM/gallery/',
    '*.example.com/gallery/',
]) {
    test(`${rule} uses a canonical directory path`, () => {
        const parsed = policy.parseSiteRule(rule)
        assert.equal(parsed.valid, true)
        assert.equal(parsed.normalized, 'example.com/gallery')
        assert.equal(parsed.path, '/gallery')
        for (const url of [
            'https://example.com/gallery',
            'https://example.com/gallery/',
            'https://example.com/gallery/photo',
            'http://example.com/gallery/photo?size=large#image',
            'https://media.example.com/gallery/photo',
        ]) {
            assert.equal(policy.matchesSiteRule(url, rule), true, url)
        }
        for (const url of [
            'https://example.com/gallery-other',
            'https://example.com/galleries/photo',
            'https://unrelatedexample.com/gallery/photo',
        ]) {
            assert.equal(policy.matchesSiteRule(url, rule), false, url)
        }
    })
}

test('domain and root rules continue to cover every descendant path', () => {
    for (const rule of ['example.com', 'example.com/', 'https://example.com/']) {
        assert.equal(policy.parseSiteRule(rule).normalized, 'example.com')
        assert.equal(policy.matchesSiteRule('https://example.com/gallery/photo', rule), true)
        assert.equal(policy.matchesSiteRule('https://media.example.com/gallery/photo', rule), true)
    }
})

test('directory rules preserve blacklist precedence over whitelist and global disable', () => {
    const settings = {
        phobiaBlockerEnabled: false,
        whitelistedSites: ['example.com'],
        blacklistedSites: ['https://example.com/gallery/'],
    }
    assert.equal(policy.resolveProtectionMode(settings, 'https://example.com/gallery/photo'), 'ALWAYS_BLUR')
    assert.equal(policy.resolveProtectionMode(settings, 'https://example.com/gallery-other'), 'DISABLED')
    assert.equal(policy.resolveProtectionMode({
        whitelistedSites: ['example.com/gallery/'],
    }, 'https://example.com/gallery/photo'), 'DISABLED')
    assert.equal(policy.resolveProtectionMode({
        whitelistedSites: ['example.com/gallery/'],
    }, 'https://example.com/gallery-other'), 'ANALYZE')
})

for (const [rule, pathname] of [
    ['example.com/café', '/caf%C3%A9'],
    ['https://EXAMPLE.COM/写真/', '/%E5%86%99%E7%9C%9F'],
    ['*.example.com/travel photos/', '/travel%20photos'],
    ['example.com/caf%c3%a9', '/caf%C3%A9'],
    ['example.com/caf%C3%A9', '/caf%c3%a9'],
]) {
    test(`${rule} matches the URL-encoded path and its descendants`, () => {
        assert.equal(policy.parseSiteRule(rule).valid, true)
        for (const url of [
            `https://example.com${pathname}`,
            `https://example.com${pathname}/`,
            `https://example.com${pathname}/photo?size=large#image`,
            `http://media.example.com${pathname}/photo`,
        ]) {
            assert.equal(policy.matchesSiteRule(url, rule), true, url)
        }
        for (const url of [
            `https://example.com${pathname}-other`,
            `https://unrelatedexample.com${pathname}/photo`,
        ]) {
            assert.equal(policy.matchesSiteRule(url, rule), false, url)
        }
    })
}

test('encoded path comparison preserves case and reserved-byte boundaries', () => {
    for (const [rule, pathname, matches] of [
        ['example.com/café', '/Caf%C3%A9', false],
        ['example.com/café', '/caf%C3%89', false],
        ['example.com/a%2fb', '/a%2Fb/photo', true],
        ['example.com/a%2Fb', '/a/b/photo', false],
        ['example.com/a', '/a%2Fb/photo', false],
        ['example.com/a%2F', '/a%2f/photo', true],
        ['example.com/a%2F', '/a/photo', false],
        ['example.com/a%252Fb', '/a%252Fb/photo', true],
        ['example.com/a%252Fb', '/a%2Fb/photo', false],
        ['example.com/a%2Fb', '/a%252Fb/photo', false],
        ['example.com/%41', '/A', false],
        ['example.com/100% done', '/100%%20done/photo', true],
    ]) {
        assert.equal(policy.matchesSiteRule(`https://example.com${pathname}`, rule), matches, `${rule}: ${pathname}`)
    }
})

test('encoded path punctuation does not change query and fragment validation', () => {
    for (const rule of ['example.com/café?q=x', 'example.com/café#photo']) {
        assert.equal(policy.parseSiteRule(rule).valid, false)
        assert.equal(policy.matchesSiteRule('https://example.com/caf%C3%A9', rule), false)
    }
    const rule = 'example.com/café%3fsize%23image'
    assert.equal(policy.parseSiteRule(rule).valid, true)
    assert.equal(policy.matchesSiteRule('https://example.com/caf%C3%A9%3Fsize%23image/photo?q=x#hash', rule), true)
    assert.equal(policy.matchesSiteRule('https://example.com/caf%C3%A9?size#image', rule), false)
})

test('site path comparison follows URL dot-segment normalization', () => {
    for (const rule of ['example.com/old/../café/', 'example.com/old/%2e%2e/café/']) {
        assert.equal(policy.matchesSiteRule('https://example.com/caf%C3%A9/photo', rule), true)
        assert.equal(policy.matchesSiteRule('https://example.com/caf%C3%A9-other', rule), false)
    }
    assert.equal(policy.matchesSiteRule('https://example.com/photo', 'example.com/old/..'), true)
})

test('URL-encoded site paths preserve protection-mode precedence', () => {
    const settings = {
        phobiaBlockerEnabled: false,
        whitelistedSites: ['example.com'],
        blacklistedSites: ['example.com/café'],
    }
    assert.equal(policy.resolveProtectionMode(settings, 'https://media.example.com/caf%c3%a9/photo'), 'ALWAYS_BLUR')
    assert.equal(policy.resolveProtectionMode(settings, 'https://example.com/caf%C3%A9-other'), 'DISABLED')
    assert.equal(policy.resolveProtectionMode({
        whitelistedSites: ['example.com/travel photos'],
    }, 'https://example.com/travel%20photos/photo'), 'DISABLED')
    assert.equal(policy.resolveProtectionMode({
        whitelistedSites: ['example.com/travel photos'],
    }, 'https://example.com/travel%20photos-other'), 'ANALYZE')
})

for (const [rule, normalized, pathname, siblingPath] of [
    ['example.com/travel photos /', 'example.com/travel photos%20', '/travel%20photos%20', '/travel%20photos'],
    ['https://example.com/café  ///', 'example.com/café%20%20', '/caf%C3%A9%20%20', '/caf%C3%A9'],
    ['example.com/photos\u00a0/', 'example.com/photos%C2%A0', '/photos%C2%A0', '/photos'],
    ['example.com/photos\t \n/', 'example.com/photos%20', '/photos%20', '/photos'],
]) {
    test(`${JSON.stringify(rule)} preserves terminal path whitespace through storage`, () => {
        const parsed = policy.parseSiteRule(rule)
        assert.equal(parsed.valid, true)
        for (const storedRule of [rule, parsed.normalized]) {
            assert.equal(policy.matchesSiteRule(`https://example.com${pathname}`, storedRule), true)
            assert.equal(policy.matchesSiteRule(`https://media.example.com${pathname}/image`, storedRule), true)
            assert.equal(policy.matchesSiteRule(`https://example.com${siblingPath}/image`, storedRule), false)
            assert.equal(policy.resolveProtectionMode({
                whitelistedSites: [storedRule],
            }, `https://example.com${pathname}/image`), 'DISABLED')
            assert.equal(policy.resolveProtectionMode({
                whitelistedSites: [storedRule],
            }, `https://example.com${siblingPath}/image`), 'ANALYZE')
        }
        assert.equal(parsed.normalized, normalized)
        assert.equal(policy.parseSiteRule(parsed.normalized).normalized, normalized)
    })
}
