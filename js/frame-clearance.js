(() => {
    'use strict'

    // Same idempotence guard as shared-policy.js: if this file ever runs a second
    // time in a world that already executed it, keep the first copy. A second run
    // here would also add a second capture listener bound to a different `active`.
    if (globalThis.PhobiaBlockerFrameClearance) return
    const { FRAME_MESSAGES } = globalThis.PhobiaBlockerPolicy
    // Shape of crypto.randomUUID(), which the service worker mints once per clear
    // child. arm() and emit() refuse anything else; _receive needs no shape test
    // because only arm-time tokens can be keys of the ticket map.
    const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
    // The listener is registered once at module scope; js.js constructs the
    // instance later in the same document_start batch, so the two are joined
    // through this slot and the newest instance owns the listener.
    let active = null

    // Install before page scripts. Tickets arrive privately through runtime;
    // only the checked child document is asked to post one. Consume its event
    // here before ordinary page listeners can observe or relay the ticket.
    // This is a stale-document/owner guard, not a security boundary against a
    // hostile page that can also rewrite the extension's DOM/CSS projection.
    window.addEventListener('message', event => active?._receive(event), true)

    class FrameClearance {
        constructor({ frames, fingerprint, isCurrent, canClear, onClear }) {
            this._frames = frames
            this._fingerprint = fingerprint
            this._isCurrent = isCurrent
            this._canClear = canClear
            this._onClear = onClear
            this.reset()
            active = this
        }

        reset() {
            clearTimeout(this._expiry)
            this._expiry = null
            this._epoch = null
            this._tickets = new Map()
            this._owners = new Map()
            this._armed = false
        }

        // Step 1 of the ticket protocol: the controller calls this just before it
        // sends PB_FRAME_AGGREGATE_REQUEST with the same epoch. arm and approve
        // for any other epoch are refused, so a ticket minted for an earlier
        // request can never release a frame after the topology moved on.
        begin(epoch) {
            this.reset()
            this._epoch = epoch
        }

        // Step 2: the service worker sends PB_FRAME_CLEARANCE_ARM with the tokens
        // of the children it found clear, before it tells any child to emit.
        // One arm per request: a second one would re-snapshot the owners under
        // tickets that are already outstanding. More tokens than iframes means
        // the worker's frame tree does not describe this document; refuse.
        // A duplicate token would collapse into one ticket and defeat the count check
        // below; the worker never mints duplicates, so refuse the whole arm.
        arm(epoch, tokens) {
            if (epoch !== this._epoch || !this._isCurrent(epoch) || this._armed ||
                !Array.isArray(tokens) || tokens.length === 0 ||
                tokens.some(token => typeof token !== 'string' || !TOKEN.test(token)) ||
                new Set(tokens).size !== tokens.length) return false
            const frames = this._frames()
            if (tokens.length > frames.length) return false
            this._armed = true
            // Snapshot every iframe's window and fingerprint now. A ticket is matched by
            // event.source against this snapshot and _valid re-checks it, so an iframe
            // that was detached, re-inserted or changed src/srcdoc/sandbox between arm
            // and link is not released (in-place navigation is canClear's job below).
            frames.forEach(element => this._owners.set(element, {
                element, source: element.contentWindow, fingerprint: this._fingerprint(element),
            }))
            tokens.forEach(token => this._tickets.set(token, { owner: null, approved: false }))
            // Arm, emit and approve all happen inside one aggregate request, which
            // the controller itself times out after 3 s. A ticket still unmatched
            // by then belongs to a request that has already failed; this backstop
            // forgets it even if the controller never got to call approve().
            this._expiry = setTimeout(() => this.reset(), 3000)
            return true
        }

        // isConnected and contentWindow catch an iframe removed and re-inserted
        // (new WindowProxy); the fingerprint catches a changed src or sandbox.
        // The WindowProxy survives an in-place navigation, so source identity
        // alone cannot tell the checked document from its successor: canClear
        // defers to the controller's pending-navigation guard for that.
        _valid(owner) {
            return Boolean(owner?.source && owner.element.isConnected &&
                owner.element.contentWindow === owner.source &&
                this._fingerprint(owner.element) === owner.fingerprint &&
                this._canClear(owner.element))
        }

        // Step 3b, parent side: the child's PB_FRAME_CLEARANCE_LINK arrives here.
        // A real postMessage is isTrusted; a page calling dispatchEvent with a
        // forged MessageEvent is not and is ignored.
        _receive(event) {
            if (!event.isTrusted || event.data?.type !== FRAME_MESSAGES.clearanceLink) return
            const ticket = this._tickets.get(event.data.token)
            if (!ticket) return
            // Only a message carrying a known ticket is swallowed; all other page
            // traffic passes through untouched.
            event.stopImmediatePropagation()
            // First claim wins: a replay of the same token by another window
            // cannot re-bind the ticket.
            if (ticket.owner || !this._isCurrent(this._epoch)) return
            // The sender must be exactly one iframe from the arm-time snapshot;
            // zero matches means a window this document does not own.
            const owners = [...this._owners.values()].filter(owner => owner.source === event.source)
            if (owners.length !== 1 || !this._valid(owners[0])) return
            ticket.owner = owners[0]
            // The child's postMessage and the worker's reply race; whichever
            // arrives second completes the release. approve() covers the other order.
            if (ticket.approved) this._onClear(ticket.owner.element)
        }

        // Step 4: the controller passes response.clearTokens from the aggregate
        // reply, or [] when the reply failed or timed out. Tokens the worker did
        // not confirm are deleted so a late link for them is ignored. Returns the
        // frames already linked; a frame whose link arrives later goes via onClear.
        approve(epoch, tokens) {
            const cleared = new Set()
            if (epoch !== this._epoch || !this._isCurrent(epoch)) return cleared
            const approved = new Set(Array.isArray(tokens) ? tokens : [])
            for (const [token, ticket] of this._tickets) {
                if (!approved.has(token)) {
                    this._tickets.delete(token)
                    continue
                }
                ticket.approved = true
                if (this._valid(ticket.owner)) cleared.add(ticket.owner.element)
            }
            return cleared
        }

        // Step 3a, child side: runs in the clear child document on
        // PB_FRAME_CLEARANCE_EMIT. The parent may be cross-origin and its origin is
        // not known here, hence '*'. The token is single-use, bound to one epoch and
        // matched to this window by the parent, so a wrong recipient gains nothing.
        static emit(token) {
            if (typeof token !== 'string' || !TOKEN.test(token) || window.parent === window) return false
            try {
                window.parent.postMessage({ type: FRAME_MESSAGES.clearanceLink, token }, '*')
                return true
            } catch (_) {
                return false
            }
        }
    }

    globalThis.PhobiaBlockerFrameClearance = FrameClearance
})()
