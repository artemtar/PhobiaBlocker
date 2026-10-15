// Runs the real offscreen analyser, with the bundled compromise.js, and the shared
// site-rule policy. Analysis is exercised through the PB_ANALYZE_SCOPES message the
// service worker sends, so the per-scope verdict shape asserted here is the one the
// worker validates before relaying a verdict to a frame.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

// Pre-compiled so loadAnalysis can run them in any number of fresh contexts;
// today one context serves every test.
const scripts = ['compromise.min.js', 'shared-policy.js', 'offscreen.js'].map(file =>
    new vm.Script(fs.readFileSync(path.join(__dirname, '../../js', file), 'utf8'), {
        filename: file,
    })
)

// The offscreen script touches no DOM and no storage; it only registers an
// onMessage listener, which is captured here and driven directly.
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
        // The scope id (7) is arbitrary and is echoed back; the worker matches replies to
        // frames by it. The listener answers synchronously or ignores the message, so a
        // missing response means the request was not accepted, never that the answer is
        // still pending.
        analyze(targetWords, words) {
            let response
            onMessage({
                target: 'offscreen',
                type: 'PB_ANALYZE_SCOPES',
                targetWords,
                scopes: [{ id: 7, words }],
            }, {}, result => { response = result })
            assert.ok(response, 'analysis should synchronously return a response')
            // Arrays built inside the vm have a different Array.prototype, and strict
            // deepEqual compares prototypes; the JSON round-trip re-creates them here.
            return JSON.parse(JSON.stringify(response.results[0]))
        },
    }
}

const { policy, analyze } = loadAnalysis()

// Every word validateTargetWord accepts must be matchable on a page. matchedWords
// is not pinned because normalize() folds café to 'cafe'; the compounds and the
// kanji take the literal path, where the raw token is the match.
for (const word of ['blood-red', 'spider-man', 'near-death', 'a-b-c', 'café', '火山灰']) {
    test(`accepted trigger ${word} matches its exact page token`, () => {
        assert.equal(policy.validateTargetWord(word).valid, true)
        const result = analyze([word], [word])
        assert.equal(result.shouldBlur, true)
        assert.deepEqual(result.matchedInputWords, [word])
        assert.ok(result.matchedWords.length > 0)
    })
}

// Hyphenated targets are excluded from NLP expansion (it would split them and may
// expand one component only) and matched literally; a page without the exact
// token must stay clear.
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

// A compound must not blur a page that only mentions one of its parts ('man' for
// spider-man), and a plain target must not match a longer word that contains it.
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

// expandTargetWords adds plural, singular and tense forms of each target, so
// whichever base form compromise picks for the page word also exists for the
// target. `normalized` is that base form, reported in matchedWords, while
// matchedInputWords keeps the page's own spelling for the popup.
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

// WORD_RE lets a token start with a hyphen (a dash glued to a word), so '-spider'
// reaches the analyser; compromise strips the punctuation during normalization.
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

// matchedWords lists the NLP matches in page order and then the literal compound;
// matchedInputWords follows page order throughout. '---' passes the hyphen-and-letter
// token filter and compromise keeps it, so it fills a slot that can never match;
// near-death is an unrelated compound.
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

// Page words are normalized in batches of 256 (NORMALIZE_BATCH_SIZE in offscreen.js).
// The matches sit on the last and first slot of consecutive batches, so an off-by-one
// in the batch offset would attribute a match to a neighbouring filler word.
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

// compromise drops kana-only tokens from a batch, so the entry count no longer
// matches the input and the analyser re-normalizes that batch word by word.
// The fallback must still produce a clear verdict, not a fail-closed one.
test('kana-only page text stays clear for unrelated triggers', () => {
    assert.deepEqual(analyze(['spider'], ['アルインコ', 'パナソニック']), {
        id: 7,
        shouldBlur: false,
        matchedWords: [],
        matchedInputWords: [],
    })
})

// Without the per-word fallback the dropped token would shift every later entry
// by one slot, and 'fell' would be reported as the match for 'アルインコ'.
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

// With only literal targets the NLP pass is skipped entirely; the Latin trigger
// forces it to run, so this covers the literal check alongside normalization.
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

// Scheme, host case, a '*.' wildcard and trailing slashes are all dropped on parse.
// A path rule covers the directory and its descendants on the host and every
// subdomain, but never a sibling that merely shares the prefix (gallery-other).
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

// Fail-closed precedence: a blacklist match beats the whitelist and the global
// off switch; a whitelist match beats the always-on toggle; a path rule applies
// only inside its directory.
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

// The stored rule keeps the path's raw Unicode and spaces; matching serializes it
// through URL so they compare against the percent-encoded pathname of the page.
// Escape hex case is unified without decoding, so %c3%a9 and %C3%A9 are one path.
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

// Escapes are never decoded: %2F must not become a directory separator (a%2Fb would
// otherwise widen to a/b and its children), %41 is not the letter A, and %252F is
// a different byte sequence from %2F. Letter case inside the path still matters.
// A lone '%' in '100% done' is kept verbatim by the URL parser, hence '%%20'.
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

// A raw '?' or '#' is rejected because rules match the path only; their encoded
// forms are ordinary path characters and stay literal, so the rule does not match
// a URL whose actual query or fragment spells the same text.
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

// The URL parser resolves '..' and its encoded form '%2e%2e' in the rule as a
// browser would in the address bar; 'old/..' collapses to the root, which turns
// the rule into a whole-host rule.
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

// Removing trailing slashes can expose trailing whitespace, which a later trim()
// (on save, on reload) would silently eat, turning the rule into one for the
// neighbouring path without the space. parseSiteRule percent-encodes only that
// trailing run; tabs and newlines are dropped as browsers do. Re-parsing the
// normalized form must be a no-op.
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
