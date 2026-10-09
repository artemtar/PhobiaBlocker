(() => {
    'use strict'

    if (globalThis.PhobiaBlockerFrameClearance) return
    const { FRAME_MESSAGES } = globalThis.PhobiaBlockerPolicy
    const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
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

        begin(epoch) {
            this.reset()
            this._epoch = epoch
        }

        arm(epoch, tokens) {
            if (epoch !== this._epoch || !this._isCurrent(epoch) || this._armed ||
                !Array.isArray(tokens) || tokens.length === 0 ||
                tokens.some(token => typeof token !== 'string' || !TOKEN.test(token)) ||
                new Set(tokens).size !== tokens.length) return false
            const frames = this._frames()
            if (tokens.length > frames.length) return false
            this._armed = true
            frames.forEach(element => this._owners.set(element, {
                element, source: element.contentWindow, fingerprint: this._fingerprint(element),
            }))
            tokens.forEach(token => this._tickets.set(token, { owner: null, approved: false }))
            this._expiry = setTimeout(() => this.reset(), 3000)
            return true
        }

        _valid(owner) {
            return Boolean(owner?.source && owner.element.isConnected &&
                owner.element.contentWindow === owner.source &&
                this._fingerprint(owner.element) === owner.fingerprint &&
                this._canClear(owner.element))
        }

        _receive(event) {
            if (!event.isTrusted || event.data?.type !== FRAME_MESSAGES.clearanceLink) return
            const ticket = this._tickets.get(event.data.token)
            if (!ticket) return
            event.stopImmediatePropagation()
            if (ticket.owner || !this._isCurrent(this._epoch)) return
            const owners = [...this._owners.values()].filter(owner => owner.source === event.source)
            if (owners.length !== 1 || !this._valid(owners[0])) return
            ticket.owner = owners[0]
            if (ticket.approved) this._onClear(ticket.owner.element)
        }

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
