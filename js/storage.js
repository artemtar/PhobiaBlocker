// Promise wrapper over chrome.storage.sync that validates every value against
// shared-policy.js on the way in and on the way out. The content scripts treat a
// rejection as "blur everything" and the UI pages refuse to edit, so one invalid
// value fails closed instead of being guessed at.
(() => {
    'use strict'

    if (globalThis.PhobiaBlockerStorage) return

    const policy = globalThis.PhobiaBlockerPolicy
    if (!policy) throw new Error('PhobiaBlockerPolicy must load before storage.js')

    function normalizeKeys(keys) {
        if (Array.isArray(keys)) return [...keys]
        if (typeof keys === 'string') return [keys]
        throw new TypeError('Storage keys must be a string or an array of strings')
    }

    // DEFAULTS holds frozen arrays, so a caller that pushed onto one would throw;
    // stored and written arrays are copied too so no result aliases the caller's
    // input or another caller's value.
    function cloneValue(value) {
        return Array.isArray(value) ? [...value] : value
    }

    function cloneDefaultValue(name) {
        if (!Object.prototype.hasOwnProperty.call(policy.DEFAULTS, name)) {
            throw new Error(`No default exists for storage key: ${name}`)
        }
        return cloneValue(policy.DEFAULTS[name])
    }

    // Older releases saved the slider's string .value (for example '50'). Coerce
    // only the two numeric keys, so a string under any other key still fails
    // validation instead of being guessed at.
    function normalizeLegacyStoredValue(name, value) {
        const isLegacyNumericKey = name === policy.STORAGE_KEYS.blurAmount ||
            name === policy.STORAGE_KEYS.previewStrength
        if (!isLegacyNumericKey || typeof value !== 'string' || value.trim() === '') return value

        const numericValue = Number(value)
        return Number.isFinite(numericValue) ? numericValue : value
    }

    function getRaw(keys) {
        return new Promise((resolve, reject) => {
            chrome.storage.sync.get(keys, values => {
                // The callback API reports failure only through lastError, which
                // must be read inside the callback or Chrome logs an unchecked error.
                const error = chrome.runtime.lastError
                if (error) {
                    reject(new Error(error.message))
                    return
                }
                resolve(values || {})
            })
        })
    }

    // A missing key gets its default, but an invalid one throws rather than being
    // replaced: substituting a default would silently analyse against the wrong
    // trigger list or flip a toggle, either of which could reveal media.
    async function getWithDefaults(keys) {
        const names = normalizeKeys(keys)
        const values = await getRaw(names)
        const result = {}

        for (const name of names) {
            const stored = normalizeLegacyStoredValue(name, values[name])
            if (stored === undefined) {
                result[name] = cloneDefaultValue(name)
                continue
            }

            if (!policy.isValidStoredValue(name, stored)) {
                throw new Error(`Invalid stored value for ${name}`)
            }
            result[name] = cloneValue(stored)
        }

        return result
    }

    // Validated before anything reaches Chrome, so sync storage never holds a
    // value that would make every page of every signed-in device fail closed.
    function normalizeValues(values) {
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
            throw new TypeError('Storage values must be an object')
        }

        const validatedValues = {}
        for (const [name, value] of Object.entries(values)) {
            if (!policy.isValidStoredValue(name, value)) {
                throw new Error(`Invalid stored value for ${name}`)
            }
            validatedValues[name] = cloneValue(value)
        }
        return validatedValues
    }

    function set(values) {
        let normalizedValues
        try {
            normalizedValues = normalizeValues(values)
        } catch (error) {
            // A rejection instead of a throw, so validation and Chrome failures
            // reach the caller through the same .catch path.
            return Promise.reject(error)
        }

        return new Promise((resolve, reject) => {
            chrome.storage.sync.set(normalizedValues, () => {
                const error = chrome.runtime.lastError
                if (error) {
                    reject(new Error(error.message))
                    return
                }
                resolve(normalizedValues)
            })
        })
    }

    // Writes only the keys that are absent: sync storage may already carry the
    // user's settings from another device, and an install must not reset them.
    async function initializeMissingDefaults(keys) {
        const names = normalizeKeys(keys)
        const values = await getRaw(names)
        const missing = {}

        for (const name of names) {
            if (values[name] !== undefined) continue
            missing[name] = cloneDefaultValue(name)
        }

        if (Object.keys(missing).length === 0) return {}
        return set(missing)
    }

    globalThis.PhobiaBlockerStorage = Object.freeze({
        getRaw,
        getWithDefaults,
        set,
        initializeMissingDefaults,
    })
})()
