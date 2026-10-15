/* global importScripts */

// Service worker. Proxies page-text analysis to the offscreen document, keeps
// the validated trigger-word cache, drives the toolbar icon, context menu and
// shortcuts, and relays authenticated frame-tree facts to the content scripts.
importScripts('shared-policy.js', 'storage.js')

const OFFSCREEN_PATH = 'offscreen.html'
// Longer than the content script's own 3000 ms analysis timeout, so the page
// has already failed closed by the time this expires; it only frees the worker.
const OFFSCREEN_ANALYSIS_TIMEOUT_MS = 3500
// One Alt+Shift+W press can reach the worker twice: via chrome.commands and via
// the content script's keydown listener in js.js. A second keyboard call inside
// this window reports the current value instead of toggling back.
const KEYBOARD_TOGGLE_DEBOUNCE_MS = 350
// Per round trip to one frame during an aggregate check. A frame that never
// answers must not stall its parent; a timeout counts as "unknown", never clear.
const FRAME_STATUS_TIMEOUT_MS = 1500
// Delay before the one timer-driven re-send of a PB_URL_CHANGED relay that
// got no ok:true acknowledgement (see sendUrlPolicyUpdate).
const URL_POLICY_RETRY_DELAY_MS = 250
// The first release whose blur curve stores slider values on the current scale.
const BLUR_CURVE_VERSION = '1.3.1'
const {
    DEFAULTS,
    STORAGE_KEYS,
    FAIL_CLOSED_RESULT,
    CLEAR_RESULT,
    FRAME_MESSAGES,
    isStringArray,
    normalizeTargetWords,
    normalizeAnalysisResult,
    convertLegacyBlurSliderValue,
    withTimeout,
} = globalThis.PhobiaBlockerPolicy
const storageApi = globalThis.PhobiaBlockerStorage
let _debugMode = false
// Bumped on every debugMode storage change so a slow startup read that resolves
// later cannot overwrite the newer value.
let _debugModeGeneration = 0
const debug = globalThis.PhobiaBlockerPolicy.createDebugLogger('background', () => _debugMode)
let _offscreenCreatePromise = null
let _cachedTargetWords = null
let _targetWordsLoadPromise = null
let _targetWordsGeneration = 0
let _lastKeyboardWordCoverToggleAt = 0
// tab:frame -> number of subframe navigations between onBeforeNavigate and
// onCommitted/onErrorOccurred. A counter, because overlapping navigations in
// one frame end separately.
const _pendingFrameNavigations = new Map()
// tab:frame -> the newest same-document URL relay the document has not yet
// acknowledged. Until it does, the frame counts as navigating for aggregates.
const _unconfirmedUrlPolicies = new Map()

function frameNavigationKey(tabId, frameId) {
    return `${tabId}:${frameId}`
}

function beginFrameNavigation(details) {
    const key = frameNavigationKey(details.tabId, details.frameId)
    _pendingFrameNavigations.set(key, (_pendingFrameNavigations.get(key) || 0) + 1)
}

function finishFrameNavigation(details) {
    const key = frameNavigationKey(details.tabId, details.frameId)
    const pendingCount = _pendingFrameNavigations.get(key) || 0
    if (pendingCount <= 1) _pendingFrameNavigations.delete(key)
    else _pendingFrameNavigations.set(key, pendingCount - 1)
}

// Pending means a browser navigation in flight or a URL policy the document has
// not acknowledged. The documentId check lets a replacement document in the
// same frame start clean instead of inheriting its predecessor's unconfirmed relay.
function frameNavigationIsPending(tabId, frameId, documentId) {
    const key = frameNavigationKey(tabId, frameId)
    const update = _unconfirmedUrlPolicies.get(key)
    return _pendingFrameNavigations.has(key) || Boolean(update && update.documentId === documentId)
}

// Null on any failure (closed tab, invalid id, API error). Callers treat null
// as "cannot prove anything", never as an empty frame tree.
function getAllTabFrames(tabId) {
    return new Promise((resolve) => {
        try {
            chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
                const error = chrome.runtime.lastError
                resolve(error || !Array.isArray(frames) ? null : frames)
            })
        } catch (_) {
            resolve(null)
        }
    })
}

// Resolves null when the frame is gone, has no listener, or does not answer
// in time; callers treat null as "unknown, stay conservative".
function sendContentMessage(tabId, message, options) {
    return withTimeout(
        Promise.resolve().then(() => chrome.tabs.sendMessage(tabId, message, options)),
        FRAME_STATUS_TIMEOUT_MS,
        'Frame message'
    ).catch(() => null)
}

// Delivers one PB_URL_CHANGED relay and tracks its acknowledgement. Ancestors
// are invalidated before and after, so no aggregate computed in between can
// release this frame under the policy of its previous URL.
function sendUrlPolicyUpdate(update, isRetry = false) {
    if (update.inFlight) return update.inFlight

    beginFrameNavigation(update)
    if (!isRetry) void invalidateFrameAncestors(update.tabId, update.parentFrameId)
    update.inFlight = sendContentMessage(
        update.tabId,
        { target: 'content', type: 'PB_URL_CHANGED', url: update.url },
        { frameId: update.frameId, documentId: update.documentId }
    ).then((response) => {
        const acknowledged = response?.ok === true
        const key = frameNavigationKey(update.tabId, update.frameId)
        // Identity check: a newer relay for the same frame replaces this entry,
        // and only the newest one may be confirmed or retried.
        if (acknowledged && _unconfirmedUrlPolicies.get(key) === update) {
            _unconfirmedUrlPolicies.delete(key)
        } else if (!acknowledged && !isRetry && _unconfirmedUrlPolicies.get(key) === update) {
            // The other retry path (retryUnconfirmedUrlPolicies) runs only when some
            // parent requests an aggregate, which a document without iframes never does.
            // Give every failed relay one timer-driven recovery attempt so such a frame
            // does not stay unconfirmed until its next navigation.
            setTimeout(() => {
                if (_unconfirmedUrlPolicies.get(key) === update) void sendUrlPolicyUpdate(update, true)
            }, URL_POLICY_RETRY_DELAY_MS)
        }
        finishFrameNavigation(update)
        update.inFlight = null
        // Failed retries stay conservative without scheduling another refresh
        // loop. A later aggregate request can make one new bounded attempt.
        if (!isRetry || acknowledged) void invalidateFrameAncestors(update.tabId, update.parentFrameId)
        return acknowledged
    })
    return update.inFlight
}

// Runs at the start of an aggregate request: each still-unconfirmed relay in
// the subtree gets one more bounded attempt, so a lost message does not leave
// the parent blurred forever while nothing else is going to retry it.
function retryUnconfirmedUrlPolicies(tabId, frames) {
    return Promise.all(frames.map((frame) => {
        const update = _unconfirmedUrlPolicies.get(frameNavigationKey(tabId, frame.frameId))
        if (!update || update.documentId !== frame.documentId || update.inFlight) return null
        return sendUrlPolicyUpdate(update, true)
    }))
}

// getAllFrames also lists prerendered and back/forward-cached documents; only
// the active one in a frame owns the content the user can see.
function activeFrames(frames) {
    return frames.filter(frame => !frame.documentLifecycle || frame.documentLifecycle === 'active')
}

// Compared before and after every async gap in an aggregate: any change in
// frame identity, parentage, document or URL voids the statuses collected.
function frameSnapshotSignature(frames) {
    return activeFrames(frames)
        .map(frame => [frame.frameId, frame.parentFrameId, frame.documentId || '', frame.url || ''].join(':'))
        .sort()
        .join('|')
}

function indexFrameTree(frames) {
    const byId = new Map()
    const childrenByParent = new Map()

    activeFrames(frames).forEach((frame) => {
        byId.set(frame.frameId, frame)
        const children = childrenByParent.get(frame.parentFrameId) || []
        children.push(frame)
        childrenByParent.set(frame.parentFrameId, children)
    })
    return { byId, childrenByParent }
}

function collectFrameDescendants(childrenByParent, parentFrameId) {
    const descendants = []
    const visit = (frameId) => {
        for (const child of childrenByParent.get(frameId) || []) {
            descendants.push(child)
            visit(child.frameId)
        }
    }
    visit(parentFrameId)
    return descendants
}

// Reply shape of PB_FRAME_STATUS_REQUEST; anything else counts as no answer.
function isValidFrameStatus(status) {
    return Boolean(
        status && typeof status.allowsUnblur === 'boolean' &&
        Number.isInteger(status.frameElementCount) && status.frameElementCount >= 0 &&
        typeof status.hasUnsupportedFrameOwner === 'boolean'
    )
}

// Answers PB_FRAME_AGGREGATE_REQUEST: may the parent release its cross-origin
// iframes? Only the browser's frame tree is trusted for parentage and document
// identity; a content script reports only its own state. Every async gap is
// bracketed by snapshot checks, and any doubt yields clear=false and no tokens.
async function computeFrameAggregate(message, sender) {
    const tabId = sender.tab?.id
    const parentFrameId = sender.frameId
    const parentDocumentId = sender.documentId
    const epoch = message.epoch
    const requestedCount = message.frameElementCount
    const individualClearance = message.individualClearance === true
    // Content scripts that never sent individualClearance keep the old reply
    // shape without a clearTokens field.
    const result = (ok, clear = false, clearTokens = []) => ({
        ok, clear, epoch, ...(individualClearance ? { clearTokens } : {}),
    })
    const requestIsValid = Number.isInteger(epoch) && epoch >= 0 &&
        Number.isInteger(requestedCount) && requestedCount >= 0 &&
        typeof message.hasUnsupportedFrameOwner === 'boolean'
    if (!requestIsValid || typeof tabId !== 'number' || typeof parentFrameId !== 'number' ||
        typeof parentDocumentId !== 'string') {
        return result(false)
    }

    const before = await getAllTabFrames(tabId)
    if (!before) return result(false)
    const { byId, childrenByParent } = indexFrameTree(before)
    const parent = byId.get(parentFrameId)
    // The requester must be the document currently in that frame; an answer for
    // a document that is being replaced must not reach its successor.
    if (!parent || parent.documentId !== parentDocumentId) {
        return result(false)
    }
    const descendants = collectFrameDescendants(childrenByParent, parentFrameId)
    await retryUnconfirmedUrlPolicies(tabId, [parent, ...descendants])
    // A pending navigation or unconfirmed URL relay on the parent itself means it
    // may be about to re-blur or be replaced; answer ok without clearance so it
    // asks again later.
    if (frameNavigationIsPending(tabId, parentFrameId, parent.documentId)) {
        return result(true)
    }

    const directChildren = childrenByParent.get(parentFrameId) || []
    // The whole-tree verdict requires every DOM owner to be an <iframe> and the DOM
    // owner count to equal the browser's child-frame count: a mismatch means one
    // view hides a frame from the other (an owner still attaching, just removed,
    // or without a tracked document), so nothing can be proven for the whole tree.
    // Frames the worker cannot reach fail separately: their status request yields
    // null. Per-child tokens may still be issued for the subtrees that do line up.
    const allOwnersSupported = !message.hasUnsupportedFrameOwner && directChildren.length === requestedCount
    if (!allOwnersSupported && !individualClearance) return result(true)

    const beforeSignature = frameSnapshotSignature([parent, ...descendants])
    // For the whole-tree verdict any pending descendant navigation is a veto;
    // for per-child tokens the same check runs per subtree instead.
    if (!individualClearance && descendants.some(frame => frameNavigationIsPending(tabId, frame.frameId, frame.documentId))) {
        return result(true)
    }

    // Each descendant is addressed by frameId and documentId, so a reply cannot
    // come from a document that replaced the one in the snapshot.
    const statusPairs = await Promise.all(descendants.map(async (frame) => {
        if (typeof frame.documentId !== 'string') return [frame.frameId, null]
        const status = await sendContentMessage(
            tabId,
            { target: 'content', type: FRAME_MESSAGES.statusRequest },
            { frameId: frame.frameId, documentId: frame.documentId }
        )
        return [frame.frameId, isValidFrameStatus(status) ? status : null]
    }))
    const statuses = new Map(statusPairs)

    // The status round trips were an async gap: re-read the tree and refuse if
    // the subtree changed, since the statuses may describe documents that are gone.
    const after = await getAllTabFrames(tabId)
    if (!after) return result(true)
    const { byId: afterById, childrenByParent: afterChildrenByParent } = indexFrameTree(after)
    const afterParent = afterById.get(parentFrameId)
    if (!afterParent || afterParent.documentId !== parentDocumentId) {
        return result(true)
    }
    const afterDescendants = collectFrameDescendants(afterChildrenByParent, parentFrameId)
    if (frameSnapshotSignature([afterParent, ...afterDescendants]) !== beforeSignature) {
        return result(true)
    }
    if (frameNavigationIsPending(tabId, parentFrameId, afterParent.documentId) || (!individualClearance &&
        afterDescendants.some(frame => frameNavigationIsPending(tabId, frame.frameId, frame.documentId)))) {
        return result(true)
    }

    // A child's subtree is clear only if the child permits release, owns only
    // <iframe>s, its DOM owner count equals its authenticated child count (so
    // neither view hides a frame from the other) and every child agrees in turn.
    // `visiting` guards against a malformed tree with cycles.
    const subtreeIsClear = (frame, visiting = new Set()) => {
        if (visiting.has(frame.frameId) || frameNavigationIsPending(tabId, frame.frameId, frame.documentId)) return false
        const children = childrenByParent.get(frame.frameId) || []

        const status = statuses.get(frame.frameId)
        if (!status || !status.allowsUnblur || status.hasUnsupportedFrameOwner ||
            status.frameElementCount !== children.length) return false

        const nextVisiting = new Set(visiting)
        nextVisiting.add(frame.frameId)
        return children.every(child => subtreeIsClear(child, nextVisiting))
    }

    const clear = allOwnersSupported && directChildren.every(child => subtreeIsClear(child))
    if (clear || !individualClearance) return result(true, clear)

    // A failed sibling must not hide a checked document. The parent receives
    // each fresh ticket privately before its exact child document emits it;
    // only the parent's WindowProxy check can associate it with a DOM owner.
    // No URL matching or durable ticket registry participates in clearance.
    const candidates = directChildren.filter(child => subtreeIsClear(child))
        .map(frame => ({ frame, token: crypto.randomUUID() }))
    if (candidates.length === 0) return result(true)
    // Ticket step 1: the parent learns the tokens before any child posts one, so
    // an unsolicited postMessage can never match a ticket.
    const armed = await sendContentMessage(tabId, {
        target: 'content', type: FRAME_MESSAGES.clearanceArm,
        epoch, tokens: candidates.map(({ token }) => token),
    }, { frameId: parentFrameId, documentId: parentDocumentId })
    if (armed?.ok !== true) return result(true)

    // Ticket step 2: each clear child posts its own token to its parent window
    // (FrameClearance.emit); the browser routes it from exactly that document.
    const emitted = await Promise.all(candidates.map(async ({ frame, token }) => {
        const response = await sendContentMessage(tabId, {
            target: 'content', type: FRAME_MESSAGES.clearanceEmit, token,
        }, { frameId: frame.frameId, documentId: frame.documentId })
        return response?.ok === true ? { frame, token } : null
    }))

    // Emission is another asynchronous boundary. A different parent, child,
    // sibling topology, or pending candidate policy invalidates its proof.
    const finalFrames = await getAllTabFrames(tabId)
    if (!finalFrames) return result(true)
    const finalTree = indexFrameTree(finalFrames)
    const finalParent = finalTree.byId.get(parentFrameId)
    if (!finalParent || finalParent.documentId !== parentDocumentId ||
        frameNavigationIsPending(tabId, parentFrameId, parentDocumentId)) return result(true)
    const finalDescendants = collectFrameDescendants(finalTree.childrenByParent, parentFrameId)
    if (frameSnapshotSignature([finalParent, ...finalDescendants]) !== beforeSignature) return result(true)

    // Ticket step 3: the tokens the parent may approve. subtreeIsClear runs again
    // so a navigation that began during the handshake drops its token.
    return result(true, false, emitted
        .filter(candidate => candidate && subtreeIsClear(candidate.frame))
        .map(({ token }) => token))
}

// Walks from the given frame to the top through the authenticated tree and
// tells every ancestor to drop its aggregate verdict. A frame without a
// documentId has no deliverable document; `seen` guards a malformed tree.
async function invalidateFrameAncestors(tabId, firstAncestorFrameId, knownFrames = null) {
    if (typeof tabId !== 'number' || typeof firstAncestorFrameId !== 'number' ||
        firstAncestorFrameId < 0) return

    const frames = knownFrames || await getAllTabFrames(tabId)
    if (!frames) return
    const { byId } = indexFrameTree(frames)
    const ancestors = []
    const seen = new Set()
    let frameId = firstAncestorFrameId

    while (frameId >= 0 && !seen.has(frameId)) {
        seen.add(frameId)
        const frame = byId.get(frameId)
        if (!frame || typeof frame.documentId !== 'string') break
        ancestors.push(frame)
        frameId = frame.parentFrameId
    }

    await Promise.all(ancestors.map(frame => sendContentMessage(
        tabId,
        { target: 'content', type: FRAME_MESSAGES.aggregateInvalidated },
        { frameId: frame.frameId, documentId: frame.documentId }
    )))
}

// PB_FRAME_STATUS_CHANGED carries no payload on purpose: the sender's identity
// comes from the browser and is honoured only if it is the live document there.
async function invalidateSenderAncestors(sender) {
    const tabId = sender.tab?.id
    if (typeof tabId !== 'number' || typeof sender.frameId !== 'number' ||
        typeof sender.documentId !== 'string') return

    const frames = await getAllTabFrames(tabId)
    if (!frames) return
    const { byId } = indexFrameTree(frames)
    const frame = byId.get(sender.frameId)
    if (!frame || frame.documentId !== sender.documentId) return
    await invalidateFrameAncestors(tabId, frame.parentFrameId, frames)
}

// Manifest V3 allows one offscreen document per extension and createDocument
// rejects when one exists, so check first. The shared promise collapses callers
// that race between the check and the creation.
async function ensureOffscreenDocument() {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH)
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl],
    })

    if (existingContexts.length > 0) return

    if (!_offscreenCreatePromise) {
        _offscreenCreatePromise = chrome.offscreen.createDocument({
            url: OFFSCREEN_PATH,
            // createDocument requires a reason from Chrome's fixed list and none covers
            // "run a library outside the worker". compromise.js needs no DOM (the unit
            // suite runs it in a bare vm context); DOM_PARSER is the closest listed
            // reason and the justification string below is what store review evaluates.
            reasons: ['DOM_PARSER'],
            justification: 'Run NLP text analysis in a single shared document instead of every frame.',
        }).finally(() => {
            _offscreenCreatePromise = null
        })
    }

    await _offscreenCreatePromise
}

// A storage change bumps the generation and drops the in-flight promise, so
// a live promise always belongs to the current generation.
async function loadTargetWordsFromStorage() {
    if (_targetWordsLoadPromise) return _targetWordsLoadPromise
    const generation = _targetWordsGeneration

    const loadPromise = (async () => {
        try {
            // The same validated read every other context uses, so a malformed
            // stored list fails closed here as well instead of reading as empty.
            const values = await storageApi.getWithDefaults([STORAGE_KEYS.targetWords])
            const validWords = normalizeTargetWords(values[STORAGE_KEYS.targetWords]).valid
            if (generation === _targetWordsGeneration) _cachedTargetWords = validWords
            return validWords
        } catch (error) {
            if (generation === _targetWordsGeneration) _cachedTargetWords = null
            console.error('PhobiaBlocker: target-word storage read failed', error)
            throw error
        } finally {
            if (_targetWordsLoadPromise === loadPromise) _targetWordsLoadPromise = null
        }
    })()

    _targetWordsLoadPromise = loadPromise
    return loadPromise
}

// Warm cache on startup
void loadTargetWordsFromStorage().catch(() => {})
// Snapshot the generation first: a debugMode change that lands while this read
// is in flight must win over the stale value the read returns.
const debugModeGeneration = _debugModeGeneration
void storageApi.getWithDefaults(STORAGE_KEYS.debugMode).then(values => {
    if (debugModeGeneration !== _debugModeGeneration) return
    _debugMode = values[STORAGE_KEYS.debugMode] === true
    debug('settings.loaded', () => ({ debugMode: true }))
}).catch(() => {})

// Keep cache fresh
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    if (changes[STORAGE_KEYS.debugMode]) {
        _debugModeGeneration++
        _debugMode = changes[STORAGE_KEYS.debugMode].newValue === true
    }
    debug('settings.changed', () => ({
        keys: Object.keys(changes).filter(key => Object.prototype.hasOwnProperty.call(DEFAULTS, key)),
    }))
    if (!changes[STORAGE_KEYS.targetWords]) return
    // Drop both the cache and any in-flight read: analysis requests arriving
    // before the reload finishes await the fresh list instead of the old one.
    _targetWordsGeneration++
    _cachedTargetWords = null
    _targetWordsLoadPromise = null
    void loadTargetWordsFromStorage().catch(() => {})
})

// Null when the string is not a dotted release number.
function parseVersion(version) {
    if (typeof version !== 'string' || !/^\d+(\.\d+)*$/.test(version)) return null
    return version.split('.').map(Number)
}

// Unparsable versions compare as not-below, so the migration never runs on a guess.
function isVersionBelow(version, reference) {
    const left = parseVersion(version)
    const right = parseVersion(reference)
    if (!left || !right) return false
    const length = Math.max(left.length, right.length)
    for (let index = 0; index < length; index++) {
        const difference = (left[index] || 0) - (right[index] || 0)
        if (difference !== 0) return difference < 0
    }
    return false
}

// The marker lives in local storage: every storage.onChanged listener ignores
// that area, so writing it never surfaces as a settings change in a frame,
// and a synced key would have needed a default every reader validates.
const BLUR_MIGRATION_MARKER_KEY = 'blurCurveMigratedTo'

// Promise wrappers over the callback API; a failure surfaces only through
// chrome.runtime.lastError, which must be read inside the callback.
function readLocalStorage(keys) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, values => {
            const error = chrome.runtime.lastError
            if (error) {
                reject(new Error(error.message))
                return
            }
            resolve(values || {})
        })
    })
}

function writeLocalStorage(values) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(values, () => {
            const error = chrome.runtime.lastError
            if (error) {
                reject(new Error(error.message))
                return
            }
            resolve()
        })
    })
}

// An unreadable marker is reported but does not block the conversion: the
// conversion only ever strengthens the rendered blur, so running it twice
// in that rare case is the safer failure.
async function hasBlurStrengthMigrationRun() {
    try {
        const values = await readLocalStorage([BLUR_MIGRATION_MARKER_KEY])
        return values[BLUR_MIGRATION_MARKER_KEY] === BLUR_CURVE_VERSION
    } catch (error) {
        console.error('PhobiaBlocker: blur strength migration marker is unreadable', error)
        return false
    }
}

// Chrome fires one 'update' per version change; the previous version selects
// the users to migrate and the local marker keeps a repeated event from
// converting an already converted value. Any failure logs and leaves the
// stored value untouched.
async function migrateLegacyBlurStrength(details) {
    if (details.reason !== 'update' || !isVersionBelow(details.previousVersion, BLUR_CURVE_VERSION)) return
    if (await hasBlurStrengthMigrationRun()) return
    try {
        const values = await storageApi.getWithDefaults([STORAGE_KEYS.blurAmount])
        const converted = convertLegacyBlurSliderValue(values[STORAGE_KEYS.blurAmount])
        await storageApi.set({ [STORAGE_KEYS.blurAmount]: converted })
        await writeLocalStorage({ [BLUR_MIGRATION_MARKER_KEY]: BLUR_CURVE_VERSION })
        debug('settings.migrated', () => ({ key: STORAGE_KEYS.blurAmount, from: details.previousVersion }))
    } catch (error) {
        console.error('PhobiaBlocker: blur strength migration failed', error)
    }
}

// Create context menu and initialize storage on extension install/update
chrome.runtime.onInstalled.addListener((details) => {
    void migrateLegacyBlurStrength(details)

    // removeAll first: onInstalled also fires on update and on reload during
    // development, where a bare create() fails with a duplicate-id error.
    chrome.contextMenus.removeAll(() => {
        void chrome.runtime.lastError
        chrome.contextMenus.create({
            id: 'phobia-blocker-unblur',
            title: 'Unblur',
            contexts: ['all']
        }, () => { void chrome.runtime.lastError })
    })

    if (details.reason !== 'install') return

    // Only a fresh install seeds stored defaults. Every reader already falls
    // back to DEFAULTS for a missing key, so an update needs no write.
    void storageApi.initializeMissingDefaults(Object.keys(DEFAULTS)).then(() => {
        _cachedTargetWords = null
        return loadTargetWordsFromStorage()
    }).catch(error => {
        _cachedTargetWords = null
        console.error('PhobiaBlocker: default settings initialization failed', error)
    })
})

// Cross-origin iframe elements cannot expose their owning child document to a
// content script. Browser navigation events provide the authenticated frame
// relationship, so invalidate every ancestor before a child can commit new
// content under a previously clear aggregate verdict.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    // Top-level navigations replace the whole tree and have no ancestor to tell.
    if (details.frameId === 0 || details.parentFrameId < 0) return
    beginFrameNavigation(details)
    void invalidateFrameAncestors(details.tabId, details.parentFrameId)
})

// Both outcomes end the pending navigation. Ancestors are told again because the
// child now holds content (or none) that the earlier verdict never examined.
for (const event of [chrome.webNavigation.onCommitted, chrome.webNavigation.onErrorOccurred]) {
    event.addListener((details) => {
        if (details.frameId === 0 || details.parentFrameId < 0) return
        finishFrameNavigation(details)
        void invalidateFrameAncestors(details.tabId, details.parentFrameId)
    })
}

// pushState, replaceState and fragment changes keep the document but can change
// which site rule applies, and the page gets no event for the first two. Relay
// the URL to the exact document; the strict field checks exist because this
// path addresses a document by identity.
for (const event of [chrome.webNavigation.onHistoryStateUpdated, chrome.webNavigation.onReferenceFragmentUpdated]) {
    event.addListener((details) => {
        if (!details || !Number.isInteger(details.tabId) || details.tabId < 0 ||
            !Number.isInteger(details.frameId) || details.frameId < 0 ||
            !Number.isInteger(details.parentFrameId) ||
            (details.frameId === 0 ? details.parentFrameId !== -1 : details.parentFrameId < 0) ||
            typeof details.documentId !== 'string' || !details.documentId ||
            details.documentLifecycle !== 'active' ||
            typeof details.url !== 'string' || !details.url) return

        // Keep ancestor aggregates conservative until the existing document
        // has applied the policy for its new URL, including overlapping relays.
        const update = { ...details, inFlight: null }
        _unconfirmedUrlPolicies.set(frameNavigationKey(details.tabId, details.frameId), update)
        void sendUrlPolicyUpdate(update)
    })
}

// Entries would otherwise outlive their tab for the worker's lifetime.
chrome.tabs.onRemoved.addListener((tabId) => {
    const prefix = `${tabId}:`
    for (const pending of [_pendingFrameNavigations, _unconfirmedUrlPolicies]) {
        for (const key of pending.keys()) {
            if (key.startsWith(prefix)) pending.delete(key)
        }
    }
})

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'phobia-blocker-unblur' && tab && tab.id !== undefined) {
        // info.frameId targets the right-clicked frame; without it the message
        // would go to every frame in the tab.
        const options = typeof info.frameId === 'number' ? { frameId: info.frameId } : undefined
        chrome.tabs.sendMessage(
            tab.id,
            { target: 'content', type: 'unblur' },
            options,
            () => {
                if (chrome.runtime.lastError) {
                    // The target tab may have navigated before the context-menu click arrived.
                }
            }
        )
    }
})

function toggleWordCover(sendResponse, options = {}) {
    const respond = payload => {
        if (sendResponse) sendResponse(payload)
    }

    if (options.source === 'keyboard') {
        const now = Date.now()
        // The duplicate delivery of one key press (see KEYBOARD_TOGGLE_DEBOUNCE_MS):
        // report the current state rather than undoing the first toggle.
        if (now - _lastKeyboardWordCoverToggleAt < KEYBOARD_TOGGLE_DEBOUNCE_MS) {
            void storageApi.getWithDefaults(STORAGE_KEYS.wordCover).then(values => {
                respond({ ok: true, wordCoverEnabled: values.wordCoverEnabled })
            }).catch(() => respond({ ok: false }))
            return
        }
        _lastKeyboardWordCoverToggleAt = now
    }

    // Toggling is a storage write, not a tab message: every content script and
    // the popup pick the new value up through storage.onChanged.
    void storageApi.getWithDefaults(STORAGE_KEYS.wordCover).then(values => {
        const wordCoverEnabled = !values.wordCoverEnabled
        return storageApi.set({ wordCoverEnabled }).then(() => wordCoverEnabled)
    }).then(wordCoverEnabled => {
        respond({ ok: true, wordCoverEnabled })
    }).catch(error => {
        console.error('PhobiaBlocker: word-cover setting update failed', error)
        respond({ ok: false })
    })
}

// Pre-render all tinted icon variants at service worker startup.
// Kept on globalThis so the browser suite (tests/icon-status.test.js) can
// inspect the rendered variants from the worker context.
globalThis._tintedIcons = {}
const _tintedIcons = globalThis._tintedIcons
const ICON_SIZES = [16, 24, 32, 48, 128]

// action.setIcon needs pixel data per size and a service worker has no <canvas>
// or <img>; OffscreenCanvas plus createImageBitmap is the only drawing path.
async function _preloadTintedIcons() {
    const VARIANTS = [
        { status: 'processing', color: '#F5A623' },
        { status: 'detected',   color: '#E53935' },
    ]
    for (const size of ICON_SIZES) {
        const resp = await fetch(chrome.runtime.getURL(`icons/icon${size}.png`))
        const blob = await resp.blob()
        const bitmap = await createImageBitmap(blob)
        const origCanvas = new OffscreenCanvas(size, size)
        origCanvas.getContext('2d').drawImage(bitmap, 0, 0, size, size)
        _tintedIcons[`idle_${size}`] = origCanvas.getContext('2d').getImageData(0, 0, size, size)
        for (const { status, color } of VARIANTS) {
            const canvas = new OffscreenCanvas(size, size)
            const ctx = canvas.getContext('2d')
            ctx.drawImage(bitmap, 0, 0, size, size)
            // 'color' takes hue and saturation from the fill and keeps the icon's
            // luminance, so the tint reads as the same icon in another colour.
            ctx.globalCompositeOperation = 'color'
            ctx.fillStyle = color
            ctx.fillRect(0, 0, size, size)
            // Keep the original silhouette and transparent padding in every state.
            ctx.globalCompositeOperation = 'destination-in'
            ctx.drawImage(bitmap, 0, 0, size, size)
            _tintedIcons[`${status}_${size}`] = ctx.getImageData(0, 0, size, size)
        }
    }
}

const _preloadPromise = _preloadTintedIcons().catch(() => {})

// Handle icon status updates from content script (soft filter for cross-version compat)
chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.type !== 'iconStatus') return
    if (message.target && message.target !== 'background') return

    const tabId = sender.tab?.id
    if (!tabId) return

    // Wait for the preload so a status sent during worker startup is not lost.
    _preloadPromise.then(() => {
        const imageData = {}
        for (const size of ICON_SIZES) {
            const icon = _tintedIcons[`${message.status}_${size}`]
            // A missing size means the preload failed or the status is unknown;
            // keep the manifest icon rather than show a partial set.
            if (!icon) return
            imageData[size] = icon
        }

        chrome.action.setIcon({
            imageData,
            tabId
        }).catch(() => {})
    })
})

// Ids must be numbers because verdicts are matched back by id; a malformed word
// list becomes null so the request check in analyzeScopes fails the batch closed.
function normalizeScopeRequest(scopes) {
    if (!Array.isArray(scopes)) return []
    return scopes
        .filter((scope) => scope && typeof scope.id === 'number')
        .map((scope) => ({
            id: scope.id,
            words: isStringArray(scope.words) ? [...scope.words] : null,
        }))
}

function failClosedResult(id) {
    return { id, ...FAIL_CLOSED_RESULT }
}

// runtime.sendMessage reaches every extension context; the target field is how
// the offscreen listener claims it. debugMode rides along because the offscreen
// document reads no storage of its own.
function sendOffscreenMessage(payload) {
    return withTimeout(
        ensureOffscreenDocument().then(() => {
            debug('message.sent', () => ({ type: 'PB_ANALYZE_SCOPES', target: 'offscreen' }))
            return chrome.runtime.sendMessage({ ...payload, debugMode: _debugMode })
        }),
        OFFSCREEN_ANALYSIS_TIMEOUT_MS,
        'Offscreen analysis'
    )
}

async function analyzeScopes(scopes) {
    const requestedScopes = normalizeScopeRequest(scopes)
    debug('analysis.requested', () => ({ scopeCount: requestedScopes.length }))
    const requestIds = requestedScopes.map(scope => scope.id)
    // One malformed scope fails the whole batch: a partial answer would leave
    // the caller guessing which scopes were actually analysed.
    const requestIsValid = Array.isArray(scopes) && scopes.length > 0 &&
        requestedScopes.length === scopes.length &&
        requestedScopes.every(scope => Array.isArray(scope.words)) &&
        new Set(requestIds).size === requestIds.length
    if (!requestIsValid) {
        return { results: requestedScopes.map(scope => failClosedResult(scope.id)) }
    }

    if (_cachedTargetWords === null) {
        try {
            await loadTargetWordsFromStorage()
        } catch (_) {
            return {
                results: requestedScopes.map(scope => failClosedResult(scope.id)),
            }
        }
    }

    // An unreadable list stays fail-closed.
    if (!Array.isArray(_cachedTargetWords)) {
        return { results: requestedScopes.map(scope => failClosedResult(scope.id)) }
    }

    // A successfully read but empty trigger list is not a failure: there is
    // nothing to match, so nothing should be blurred. Treating this as
    // fail-closed blurred every image on every site the user visited.
    if (_cachedTargetWords.length === 0) {
        return { results: requestedScopes.map(scope => ({ id: scope.id, ...CLEAR_RESULT })) }
    }

    const response = await sendOffscreenMessage({
        target: 'offscreen',
        type: 'PB_ANALYZE_SCOPES',
        scopes: requestedScopes,
        targetWords: _cachedTargetWords,
    })

    const requestedIds = new Set(requestIds)
    // The offscreen reply is untrusted like any other message: every requested
    // id must come back exactly once as a well-formed verdict, or every scope
    // fails closed.
    const resultsById = new Map()
    let responseIsValid = Boolean(
        response && Array.isArray(response.results) &&
        response.results.length === requestedScopes.length
    )

    if (responseIsValid) {
        for (const result of response.results) {
            if (!result || typeof result.id !== 'number' || !requestedIds.has(result.id) ||
                resultsById.has(result.id)) {
                responseIsValid = false
                break
            }
            const normalized = normalizeAnalysisResult(result)
            if (!normalized) {
                responseIsValid = false
                break
            }
            resultsById.set(result.id, { id: result.id, ...normalized })
        }
    }

    if (!responseIsValid || resultsById.size !== requestedScopes.length) {
        debug('analysis.invalid-response', () => ({ scopeCount: requestedScopes.length }))
        return { results: requestedScopes.map(scope => failClosedResult(scope.id)) }
    }

    debug('analysis.completed', () => ({
        scopeCount: resultsById.size,
        blurredScopeCount: [...resultsById.values()].filter(result => result.shouldBlur).length,
    }))
    return {
        results: requestedScopes.map(scope => resultsById.get(scope.id)),
    }
}

// Handle frame coordination, word-cover toggles and analysis requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== 'background') return

    if (message.type === FRAME_MESSAGES.aggregateRequest) {
        debug('message.received', () => ({ type: FRAME_MESSAGES.aggregateRequest, frameId: sender.frameId }))
        void computeFrameAggregate(message, sender)
            .then(sendResponse)
            .catch(() => sendResponse({
                ok: false, clear: false, epoch: message.epoch,
                ...(message.individualClearance === true ? { clearTokens: [] } : {}),
            }))
        // Returning true keeps the reply channel open for the async sendResponse.
        // Without it Chrome closes the port before the answer exists; the content
        // script then gets no ok:true reply and keeps the iframes blurred.
        return true
    }

    if (message.type === FRAME_MESSAGES.statusChanged) {
        debug('message.received', () => ({ type: FRAME_MESSAGES.statusChanged, frameId: sender.frameId }))
        void invalidateSenderAncestors(sender)
            .then(() => sendResponse({ ok: true }))
            .catch(() => sendResponse({ ok: false }))
        return true
    }

    if (message.type === 'toggleWordCover') {
        debug('message.received', () => ({ type: 'toggleWordCover' }))
        toggleWordCover(sendResponse, { source: message.source })
        return true
    }

    if (message.type !== 'PB_ANALYZE_WORDS') return
    debug('message.received', () => ({ type: 'PB_ANALYZE_WORDS', frameId: sender.frameId }))

    // The content scripts' only analysis request. It is wrapped as a single scope
    // (id 0) so the worker and the offscreen document share one batch protocol and
    // one set of validation rules; nothing else calls analyzeScopes today.
    ;(async () => {
        try {
            if (!isStringArray(message.words)) {
                sendResponse({ ...FAIL_CLOSED_RESULT })
                return
            }
            // analyzeScopes returns exactly one well-formed verdict per scope.
            const { results } = await analyzeScopes([{ id: 0, words: [...message.words] }])
            const { shouldBlur, matchedWords, matchedInputWords } = results[0]
            sendResponse({ shouldBlur, matchedWords, matchedInputWords })
        } catch (error) {
            console.error('PhobiaBlocker: Offscreen analysis failed', error)
            sendResponse({ ...FAIL_CLOSED_RESULT })
        }
    })()

    return true
})

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
    // Keyboard commands carry no sender tab; the active tab of the focused
    // window is the target.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || !tabs[0]) return

        let messageType
        if (command === 'blur-all') messageType = 'blurAll'
        else if (command === 'unblur-all') messageType = 'unblurAll'
        else if (command === 'toggle-word-cover') {
            toggleWordCover(null, { source: 'keyboard' })
            return
        } else {
            return
        }

        chrome.tabs.sendMessage(tabs[0].id, { target: 'content', type: messageType }, () => {
            // The active tab may not accept content-script messages.
            void chrome.runtime.lastError
        })
    })
})
