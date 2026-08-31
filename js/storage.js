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

    function cloneValue(value) {
        return Array.isArray(value) ? [...value] : value
    }

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
                const error = chrome.runtime.lastError
                if (error) {
                    reject(new Error(error.message))
                    return
                }
                resolve(values || {})
            })
        })
    }

    async function getWithDefaults(keys) {
        const names = normalizeKeys(keys)
        const values = await getRaw(names)
        const result = {}

        for (const name of names) {
            const stored = normalizeLegacyStoredValue(name, values[name])
            if (stored === undefined) {
                if (!Object.prototype.hasOwnProperty.call(policy.DEFAULTS, name)) {
                    throw new Error(`No default exists for storage key: ${name}`)
                }
                result[name] = cloneValue(policy.DEFAULTS[name])
                continue
            }

            if (!policy.isValidStoredValue(name, stored)) {
                throw new Error(`Invalid stored value for ${name}`)
            }
            result[name] = cloneValue(stored)
        }

        return result
    }

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

    async function initializeMissingDefaults(keys) {
        const names = normalizeKeys(keys)
        const values = await getRaw(names)
        const missing = {}

        for (const name of names) {
            if (values[name] !== undefined) continue
            if (!Object.prototype.hasOwnProperty.call(policy.DEFAULTS, name)) {
                throw new Error(`No default exists for storage key: ${name}`)
            }
            missing[name] = cloneValue(policy.DEFAULTS[name])
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
