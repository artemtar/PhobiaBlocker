// The ticket protocol only releases a child whose own verdict is clear. A
// same-origin rich-text editor must stay readable even while this document's
// verdict is blur, and blurring the whole iframe would blur the text being
// typed. The parent instead asks the child controller to protect the media
// inside and drops its own whole-frame filter only after an acknowledgement.
(() => {
    'use strict'

    // Same idempotence guard as shared-policy.js: keep the first copy if this file
    // ever runs twice in one world. js.js captured that copy's class, and the
    // token prefix and counter below belong to it.
    if (globalThis.PhobiaBlockerEditorFrames) return

    const PageTextIndex = globalThis.PhobiaBlockerPageTextIndex
    if (!PageTextIndex) throw new Error('PhobiaBlockerPageTextIndex must load before editor-frames.js')

    const REQUEST_ATTRIBUTE = 'data-phobiablocker-editor-request'
    const ACK_ATTRIBUTE = 'data-phobiablocker-editor-ack'
    const REQUEST_EVENT = 'phobiablocker:editor-frame-request'
    const READY_EVENT = 'phobiablocker:editor-frame-ready'
    // The random prefix makes this document's tokens distinct from any ack already
    // in the markup (a page saved with the extension's attributes, or written by
    // another content-script world), so a counter restarting at 1 cannot match a
    // stale ack; the counter makes each request distinct so an older ack from this
    // document is not mistaken for the current one.
    const TOKEN_PREFIX = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    let nextToken = 0

    // Both identity checks must agree before the document is trusted: a document
    // whose browsing context is gone has a null defaultView, and a window this
    // element does not host (frameElement differs) is not ours. Cross-origin
    // access throws and simply means "not ours".
    function frameDocument(frame, ownerDocument) {
        try {
            if (frame?.localName !== 'iframe' || frame.ownerDocument !== ownerDocument || !frame.isConnected) return null
            const child = frame.contentDocument
            if (!child || child.defaultView !== frame.contentWindow || child.defaultView.frameElement !== frame) return null
            return child
        } catch (_) {
            return null
        }
    }

    // Child side. Resolve the hosting <iframe> through frameElement, then confirm
    // the parent would resolve back to this document, so a request attribute is
    // only honoured from the element that really hosts us.
    function actualOwner(child) {
        try {
            const owner = child.defaultView?.frameElement
            return owner && frameDocument(owner, owner.ownerDocument) === child ? owner : null
        } catch (_) {
            return null
        }
    }

    function isEditable(child) {
        try {
            return PageTextIndex.isEditableDocument(child) === true
        } catch (_) {
            return false
        }
    }

    function restoreAttribute(element, name, original, written) {
        // A page can replace our attribute while protection is active.
        if (element.getAttribute(name) !== written) return
        if (original === null) element.removeAttribute(name)
        else element.setAttribute(name, original)
    }

    class EditorFrames {
        constructor({ applyInheritedProtection, onFrameReady } = {}) {
            this._document = document
            this._applyInheritedProtection = typeof applyInheritedProtection === 'function'
                ? applyInheritedProtection : () => false
            this._onFrameReady = typeof onFrameReady === 'function' ? onFrameReady : () => {}
            this._requests = new Map()
            // Re-entrancy guards. Every step of the handshake is a synchronous DOM
            // event or attribute write, and the controller callbacks re-apply media,
            // which calls release() again, so each path must refuse to nest.
            this._dispatching = new Set()
            this._handlingReady = new Set()
            this._inheritedRequest = null
            this._ack = null
            this._owner = null
            this._lastOwnerValue = null
            this._applying = false
            this._refreshing = false
            this._clearing = false
            this._notifying = false
            // Child side: watch our own <iframe> element in the parent document
            // (same origin, so the observer may cross). A request the parent wrote
            // before this document was listening is still picked up from the attribute.
            this._ownerObserver = new MutationObserver(() => {
                if (this._owner?.getAttribute(REQUEST_ATTRIBUTE) !== this._lastOwnerValue) this.refresh()
            })
            this._onRequestEvent = event => {
                // The parent dispatches the request on the document itself (release, _forget);
                // a same-named event bubbling up from an element is page traffic and ignored.
                if (event.target === this._document) this._syncInheritedProtection()
            }
            // Parent side: a child announced that its controller can now answer
            // requests. Ignore it while we are the ones dispatching to that frame,
            // and only for an iframe that this document actually owns.
            this._onReadyEvent = event => {
                // event.target is retargeted to the shadow host when the iframe sits inside a
                // shadow root; the composed path still starts at the iframe itself.
                const frame = event.composedPath()[0]
                if (this._clearing || this._dispatching.has(frame) || this._handlingReady.has(frame) ||
                    !frameDocument(frame, this._document)) return
                this._handlingReady.add(frame)
                try {
                    this._onFrameReady(frame)
                } finally {
                    this._handlingReady.delete(frame)
                }
            }
            this._bindDocumentListeners()
        }

        _bindDocumentListeners() {
            // document.open() can remove listeners while keeping the document,
            // isolated-world state, and owner observer alive. Stable callbacks
            // make repeated registrations harmless when listeners remain.
            this._document.addEventListener(REQUEST_EVENT, this._onRequestEvent)
            this._document.addEventListener(READY_EVENT, this._onReadyEvent, true)
        }

        // Release the outer filter only after this exact child document has
        // synchronously applied the parent's requested media protection.
        // The request and ack live in the shared DOM, so a same-origin page script
        // could forge the ack. Like frame-clearance.js this is a stale-document and
        // owner guard, not a boundary against a hostile page of the same origin.
        release(frame, blurred) {
            if (this._clearing || this._dispatching.has(frame)) return false
            const child = frameDocument(frame, this._document)
            if (!child || !isEditable(child)) {
                this._forget(frame)
                return false
            }

            let entry = this._requests.get(frame)
            // The child navigated: the entry describes a dead document, so restore
            // its attribute and start over against the new one.
            if (entry && entry.document !== child) {
                this._forget(frame)
                entry = null
            }
            const previous = frame.getAttribute(REQUEST_ATTRIBUTE)
            if (!entry) entry = { document: child, original: previous, written: null }
            // The page replaced our attribute meanwhile; that value, not ours, is
            // what _forget must put back later.
            else if (previous !== entry.written) entry.original = previous
            const token = `${TOKEN_PREFIX}-${++nextToken}`
            entry.written = `${blurred === true ? 'blur' : 'clear'}:${token}`
            this._requests.set(frame, entry)
            this._dispatching.add(frame)
            try {
                frame.setAttribute(REQUEST_ATTRIBUTE, entry.written)
                child.dispatchEvent(new Event(REQUEST_EVENT))
                // The child's handler ran synchronously inside dispatchEvent. Re-check
                // that nothing was swapped underneath and that this request's own
                // token was acknowledged; an older ack still on <html> must not count.
                return this._requests.get(frame) === entry &&
                    frameDocument(frame, this._document) === child && isEditable(child) &&
                    frame.getAttribute(REQUEST_ATTRIBUTE) === entry.written &&
                    child.documentElement?.getAttribute(ACK_ATTRIBUTE) === token
            } catch (_) {
                return false
            } finally {
                this._dispatching.delete(frame)
            }
        }

        // Called after the controller is ready and when editing/settings state
        // changes. No settings, page text, or event-provided commands cross here.
        refresh() {
            if (this._refreshing || this._applying || this._clearing) return
            this._refreshing = true
            try {
                this._bindDocumentListeners()
                this._syncInheritedProtection()
                this._notifyParent()
            } finally {
                this._refreshing = false
            }
        }

        // Called when this document's controller disables protection. Readiness is
        // still announced so the parent re-evaluates: a disabled child never acks,
        // so the parent keeps its own filter over the iframe.
        clear() {
            if (this._clearing) return
            this._clearing = true
            try {
                for (const frame of this._requests.keys()) this._forget(frame)
                this._resetInheritedProtection()
                this._watchOwner(null)
            } finally {
                this._clearing = false
            }
            this._notifyParent()
        }

        // Housekeeping from the mutation handler and the periodic poll: a navigated
        // child, a document that stopped being editable or a page that rewrote the
        // request attribute invalidates the entry; _forget restores the attribute
        // and tells both documents.
        prune() {
            for (const [frame, entry] of this._requests) {
                if (frameDocument(frame, this._document) !== entry.document || !isEditable(entry.document) ||
                    frame.getAttribute(REQUEST_ATTRIBUTE) !== entry.written) this._forget(frame)
            }
        }

        _forget(frame) {
            const entry = this._requests.get(frame)
            if (!entry) return
            this._requests.delete(frame)
            restoreAttribute(frame, REQUEST_ATTRIBUTE, entry.original, entry.written)
            // Navigation can leave both the previous document and a newly
            // initialized document holding inherited state from this owner.
            const current = frameDocument(frame, this._document)
            for (const child of new Set([entry.document, current])) {
                if (child) child.dispatchEvent(new Event(REQUEST_EVENT))
            }
        }

        _watchOwner(owner) {
            if (owner === this._owner) return
            this._ownerObserver.disconnect()
            this._owner = owner
            this._lastOwnerValue = owner?.getAttribute(REQUEST_ATTRIBUTE) ?? null
            if (owner) this._ownerObserver.observe(owner, { attributes: true, attributeFilter: [REQUEST_ATTRIBUTE] })
        }

        // Child side of the handshake: read the parent's request from our own
        // <iframe> element, apply it through the controller and ack on <html>.
        _syncInheritedProtection() {
            if (this._applying || this._clearing) return false
            this._applying = true
            try {
                const owner = actualOwner(this._document)
                this._watchOwner(owner)
                const value = owner?.getAttribute(REQUEST_ATTRIBUTE) ?? null
                this._lastOwnerValue = value
                const match = typeof value === 'string' ? /^(blur|clear):([a-z0-9-]+)$/.exec(value) : null
                if (!owner || !isEditable(this._document) || !match) {
                    this._resetInheritedProtection()
                    return false
                }

                const request = { owner, value }
                this._inheritedRequest = request
                // Drop the previous ack before applying, so a failed application
                // leaves no stale token for the parent to accept.
                this._restoreAck()
                let applied = false
                try {
                    applied = this._applyInheritedProtection(match[1] === 'blur') === true
                } catch (_) { /* Without a completed scan, the outer filter stays. */ }

                // The callback can change editing state, settings, or the DOM.
                if (this._inheritedRequest !== request || actualOwner(this._document) !== owner ||
                    owner.getAttribute(REQUEST_ATTRIBUTE) !== value || !isEditable(this._document)) {
                    this._resetInheritedProtection()
                    return false
                }
                const root = this._document.documentElement
                // The ack is the only thing that lets the parent drop its filter, so
                // it is written last and only when the controller reports the media
                // inside as protected (settings applied, background scan succeeded).
                if (!applied || !root) return false
                this._ack = { root, original: root.getAttribute(ACK_ATTRIBUTE), written: match[2] }
                root.setAttribute(ACK_ATTRIBUTE, match[2])
                return true
            } finally {
                this._applying = false
            }
        }

        _restoreAck() {
            if (!this._ack) return
            const { root, original, written } = this._ack
            this._ack = null
            restoreAttribute(root, ACK_ATTRIBUTE, original, written)
        }

        _resetInheritedProtection() {
            const hadRequest = this._inheritedRequest !== null
            this._inheritedRequest = null
            this._restoreAck()
            if (hadRequest) {
                try {
                    this._applyInheritedProtection(false)
                } catch (_) { /* A stopped controller cannot acknowledge release. */ }
            }
        }

        _notifyParent() {
            if (this._notifying || this._clearing) return
            const owner = actualOwner(this._document)
            if (!owner) return
            this._notifying = true
            try {
                // Dispatched on our own <iframe> element in the parent document. composed lets
                // the parent's capture listener on document see it even when the iframe sits
                // inside a shadow root; that listener recovers the iframe via composedPath().
                owner.dispatchEvent(new Event(READY_EVENT, { bubbles: true, composed: true }))
            } finally {
                // Readiness can synchronously produce a fresh parent request.
                // If its event is not delivered, observing that response must
                // not emit readiness again forever. This is only the observer
                // baseline: the unhandled request gets no ACK, so release still
                // fails closed and a later explicit refresh can retry it.
                if (this._owner === owner && actualOwner(this._document) === owner) {
                    this._lastOwnerValue = owner.getAttribute(REQUEST_ATTRIBUTE)
                }
                this._notifying = false
            }
        }
    }

    globalThis.PhobiaBlockerEditorFrames = EditorFrames
})()
