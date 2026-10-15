(() => {
    'use strict'

    // attachShadow does not produce a mutation in the host's tree. Notify the
    // isolated content script before the page can populate a new open root.
    // Declarative shadow roots (template shadowrootmode) never call attachShadow;
    // the controller re-checks candidate hosts itself for those.
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow')
    // No native data property means attachShadow is missing or another script
    // already turned it into an accessor; do not wrap what is not the native.
    // The controller's declarative re-checks and polling still find roots.
    if (!descriptor?.value) return
    const attachShadow = descriptor.value
    // Capture the natives at load. This runs in the page's world, so a page that
    // later replaces dispatchEvent or Event could otherwise break or observe the
    // notification through its own wrapper.
    const dispatch = EventTarget.prototype.dispatchEvent
    const ShadowEvent = Event

    // Spread the original descriptor so writable/configurable/enumerable stay
    // intact and libraries that patch attachShadow themselves keep working.
    Object.defineProperty(Element.prototype, 'attachShadow', {
        ...descriptor,
        value: function attachShadowWithNotification() {
            // Call the native first so its exceptions (NotSupportedError on a second
            // attach or a disallowed host, TypeError on a bad init) propagate unchanged
            // and the page sees native behaviour.
            const root = Reflect.apply(attachShadow, this, arguments)
            // Only open roots: the isolated world can reach a root only through
            // host.shadowRoot, which is null for a closed one, so nothing could be
            // styled or indexed there anyway and the event would merely tell page
            // listeners that a closed root exists. Closed roots are a known limitation.
            if (root.mode === 'open') {
                try {
                    // No detail payload on purpose: the page can dispatch this event name itself,
                    // so the controller trusts only the host.shadowRoot it reads from the DOM.
                    // composed lets the event leave nested shadow trees so the controller's
                    // capture listener on document (which reads composedPath()[0]) sees it.
                    Reflect.apply(dispatch, this, [new ShadowEvent('phobiablocker:shadow-root-attached', {
                        bubbles: true, composed: true,
                    })])
                } catch (_) { /* Notification must not change the page's attachShadow result. */ }
            }
            return root
        },
    })
})()
