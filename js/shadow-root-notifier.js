(() => {
    'use strict'

    // attachShadow does not produce a mutation in the host's tree. Notify the
    // isolated content script before the page can populate a new open root.
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow')
    if (!descriptor?.value) return
    const attachShadow = descriptor.value
    const dispatch = EventTarget.prototype.dispatchEvent
    const ShadowEvent = Event

    Object.defineProperty(Element.prototype, 'attachShadow', {
        ...descriptor,
        value: function attachShadowWithNotification() {
            const root = Reflect.apply(attachShadow, this, arguments)
            if (root.mode === 'open') {
                try {
                    Reflect.apply(dispatch, this, [new ShadowEvent('phobiablocker:shadow-root-attached', {
                        bubbles: true, composed: true,
                    })])
                } catch (_) { /* Notification must not change the page's attachShadow result. */ }
            }
            return root
        },
    })
})()
