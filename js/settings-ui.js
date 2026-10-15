// Small DOM helpers shared by the popup and the settings page.
(() => {
    'use strict'

    if (globalThis.PhobiaBlockerSettingsUi) return

    const REMOVE_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9 3L3 9M3 3L9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'

    function createRemoveButton({ className, label, disabled, onClick }) {
        const button = document.createElement('button')
        button.className = className
        button.disabled = disabled === true
        button.innerHTML = REMOVE_ICON
        button.title = `Remove ${label}`
        button.addEventListener('click', onClick)
        return button
    }

    // The stylesheet owns the track colours; only the fill position comes from
    // here, so sliders read correctly in both light and dark mode.
    function setSliderProgress(slider, value) {
        if (!slider) return
        const max = parseInt(slider.max, 10) || 100
        slider.style.setProperty('--pb-progress', `${(Number(value) / max) * 100}%`)
    }

    // Storage reads race with storage.onChanged events. One revision counter
    // per page makes sure a stale response never overwrites a newer one.
    function createRevisionedReader(storage) {
        let revision = 0
        const keyRevisions = new Map()

        return {
            get revision() { return revision },

            // A change that arrives before the initial load finishes forces
            // that load to read again.
            invalidate() { revision += 1 },

            // Repeats the full read until no invalidate() or refresh() happened
            // while it was in flight, so the initial snapshot never predates a
            // change the page has already been notified about.
            async loadAll(keys) {
                let loadRevision
                let values
                do {
                    loadRevision = revision
                    values = await storage.getWithDefaults(keys)
                } while (loadRevision !== revision)
                return values
            },

            // Reads `keys` and hands back only the values no newer refresh has
            // since claimed, so overlapping refreshes never regress a key.
            refresh(keys, onValues, onError) {
                const current = ++revision
                keys.forEach(key => keyRevisions.set(key, current))
                return storage.getWithDefaults(keys).then((loaded) => {
                    const values = Object.fromEntries(keys
                        .filter(key => keyRevisions.get(key) === current)
                        .map(key => [key, loaded[key]]))
                    if (Object.keys(values).length > 0) onValues(values)
                }).catch((error) => {
                    // A failure only matters while this read still owns a key; a
                    // superseded read must not lock keys a newer read has refreshed.
                    if (keys.some(key => keyRevisions.get(key) === current)) onError(error)
                })
            },
        }
    }

    globalThis.PhobiaBlockerSettingsUi = Object.freeze({
        createRemoveButton,
        setSliderProgress,
        createRevisionedReader,
    })
})()
