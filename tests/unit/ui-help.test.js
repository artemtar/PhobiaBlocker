const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const source = fs.readFileSync(path.resolve(__dirname, '../../js/ui-help.js'), 'utf8')

function createElement(tagName = 'div') {
    const attributes = new Map()
    const listeners = new Map()
    return {
        tagName: tagName.toUpperCase(),
        children: [],
        parentElement: null,
        style: {},
        hidden: false,
        className: '',
        textContent: '',
        rect: { left: 20, top: 20, right: 48, bottom: 48, width: 28, height: 28 },
        set innerHTML(value) { throw new Error(`Help must render text safely: ${value}`) },
        get isConnected() { return this.connected || !!this.parentElement?.isConnected },
        getAttribute(name) { return attributes.get(name) ?? null },
        setAttribute(name, value) { attributes.set(name, String(value)) },
        removeAttribute(name) { attributes.delete(name) },
        appendChild(child) { child.parentElement = this; this.children.push(child); return child },
        contains(node) { return !!node && (node === this || this.contains(node.parentElement)) },
        matches(selector) {
            return attributes.has('data-tooltip') && (selector === '[data-tooltip]' ||
                (selector === 'button.pb-help[data-tooltip]' && this.tagName === 'BUTTON' &&
                    this.className.split(/\s+/).includes('pb-help')))
        },
        closest(selector) {
            if (this.matches(selector)) return this
            return this.parentElement?.closest(selector) || null
        },
        getBoundingClientRect() { return this.rect },
        addEventListener(type, callback, options) {
            if (!listeners.has(type)) listeners.set(type, [])
            listeners.get(type).push({ callback, once: options?.once })
        },
        emit(type, details = {}) {
            const event = {
                target: this, relatedTarget: null, defaultPrevented: false, stopped: false,
                preventDefault() { this.defaultPrevented = true },
                stopPropagation() { this.stopped = true },
                ...details,
            }
            for (const listener of [...(listeners.get(type) || [])]) {
                listener.callback(event)
                if (listener.once) listeners.get(type).splice(listeners.get(type).indexOf(listener), 1)
            }
            return event
        },
    }
}

// Only DOM geometry/events and the timer boundary are doubled. The production
// script runs unchanged, with no Chrome APIs exposed to help interactions.
function createHelp({ readyState = 'complete', width = 320, height = 240 } = {}) {
    const document = createElement('document')
    const window = createElement('window')
    const body = createElement('body')
    body.connected = true
    document.body = body
    document.readyState = readyState
    document.documentElement = { clientWidth: width, clientHeight: height }
    document.createElement = tag => {
        const element = createElement(tag)
        element.rect = { left: 0, top: 0, right: 260, bottom: 64, width: 260, height: 64 }
        return element
    }
    document.getElementById = id => body.children.find(element => element.id === id) || null
    const timers = new Map()
    let timerId = 0
    const context = vm.createContext({
        document, window,
        setTimeout(callback) { timers.set(++timerId, callback); return timerId },
        clearTimeout(id) { timers.delete(id) },
    })
    const load = () => vm.runInContext(source, context, { filename: 'ui-help.js' })
    load()
    return {
        document, window, body, load,
        get tooltip() { return body.children.find(element => element.getAttribute('role') === 'tooltip') },
        trigger({ help = false, text = 'An explanation.', rect, describedBy } = {}) {
            const element = createElement('button')
            element.className = help ? 'pb-help' : 'setting-button'
            element.setAttribute('type', 'button')
            element.setAttribute('data-tooltip', text)
            if (describedBy) element.setAttribute('aria-describedby', describedBy)
            if (rect) element.rect = rect
            body.appendChild(element)
            return element
        },
        emit(type, target, details) { return document.emit(type, { target, ...details }) },
        flushTimers() {
            for (const [id, callback] of [...timers]) { timers.delete(id); callback() }
        },
    }
}

test('initializes once after DOM readiness even if the script is loaded twice', () => {
    const ui = createHelp({ readyState: 'loading' })
    ui.load()
    assert.equal(ui.tooltip, undefined)
    ui.document.emit('DOMContentLoaded')
    assert.equal(ui.body.children.length, 1)
    assert.equal(ui.tooltip.hidden, true)
})

test('focus renders literal help text and preserves other accessibility descriptions', () => {
    const ui = createHelp()
    const button = ui.trigger({ text: '<img src=x onerror=alert(1)>', describedBy: 'hint error' })
    ui.emit('focusin', button)
    assert.equal(ui.tooltip.hidden, false)
    assert.equal(ui.tooltip.textContent, '<img src=x onerror=alert(1)>')
    assert.equal(button.getAttribute('aria-describedby'), `hint error ${ui.tooltip.id}`)
    button.setAttribute('aria-describedby', `${button.getAttribute('aria-describedby')} newer-hint`)
    ui.emit('keydown', button, { key: 'Escape' })
    assert.equal(ui.tooltip.hidden, true)
    assert.equal(button.getAttribute('aria-describedby'), 'hint error newer-hint')
})

test('pointer can cross the gap into an explanation and keep it visible', () => {
    const ui = createHelp()
    const button = ui.trigger()
    ui.emit('pointerover', button)
    assert.equal(ui.tooltip.hidden, false)
    ui.emit('pointerout', button)
    assert.equal(ui.tooltip.hidden, false)
    ui.tooltip.emit('pointerenter')
    ui.flushTimers()
    assert.equal(ui.tooltip.hidden, false)
    ui.tooltip.emit('pointerleave')
    ui.flushTimers()
    assert.equal(ui.tooltip.hidden, true)
})

test('keyboard focus keeps help open after the pointer leaves, until focus moves away', () => {
    const ui = createHelp()
    const button = ui.trigger()
    ui.emit('focusin', button)
    ui.emit('pointerover', button)
    ui.emit('pointerout', button)
    ui.flushTimers()
    assert.equal(ui.tooltip.hidden, false)
    ui.emit('focusout', button)
    ui.flushTimers()
    assert.equal(ui.tooltip.hidden, true)
})

test('help clicks pin and dismiss without consuming clicks on state-changing controls', () => {
    const ui = createHelp()
    const help = ui.trigger({ help: true })
    const setting = ui.trigger()
    const click = ui.emit('click', help)
    assert.equal(click.defaultPrevented, true)
    assert.equal(click.stopped, true)
    ui.emit('pointerout', help)
    ui.emit('focusout', help)
    ui.flushTimers()
    assert.equal(ui.tooltip.hidden, false)
    ui.emit('click', help)
    assert.equal(ui.tooltip.hidden, true)
    assert.equal(ui.emit('click', setting).defaultPrevented, false)
    ui.emit('click', help)
    assert.equal(ui.tooltip.hidden, false)
    ui.emit('click', ui.body)
    assert.equal(ui.tooltip.hidden, true)
})

test('Escape dismisses focused help until the user deliberately re-enters it', () => {
    const ui = createHelp()
    const button = ui.trigger({ help: true })
    ui.emit('focusin', button)
    ui.emit('pointerover', button)
    ui.emit('click', button)
    ui.emit('keydown', button, { key: 'Escape' })
    ui.emit('pointerout', button)
    ui.flushTimers()
    assert.equal(ui.tooltip.hidden, true)
    ui.emit('pointerover', button)
    assert.equal(ui.tooltip.hidden, false)
})

test('positions help within a narrow viewport and above a trigger near its bottom', () => {
    const ui = createHelp()
    const button = ui.trigger({ rect: { left: 284, right: 312, top: 200, bottom: 228, width: 28, height: 28 } })
    ui.emit('focusin', button)
    assert.equal(ui.tooltip.style.left, '52px')
    assert.equal(ui.tooltip.style.top, '128px')
    button.rect = { left: 0, right: 28, top: 0, bottom: 28, width: 28, height: 28 }
    ui.window.emit('resize')
    assert.equal(ui.tooltip.style.left, '8px')
    assert.equal(ui.tooltip.style.top, '36px')
})

for (const input of ['pointer', 'keyboard']) {
    test(`${input} disclosure activation dismisses help without consuming the click or losing descriptions`, () => {
        const ui = createHelp()
        const button = ui.trigger({ describedBy: 'word-hint' })
        button.setAttribute('aria-expanded', 'false')
        const label = button.appendChild(createElement('span'))
        if (input === 'pointer') ui.emit('pointerover', label)
        ui.emit('focusin', button)
        assert.equal(ui.tooltip.hidden, false)

        // Captured click runs before the application toggles aria-expanded.
        const click = ui.emit('click', input === 'pointer' ? label : button)
        assert.equal(click.defaultPrevented, false)
        assert.equal(click.stopped, false)
        assert.equal(ui.tooltip.hidden, true)
        button.setAttribute('aria-expanded', 'true')
        ui.emit('pointerout', button)
        ui.flushTimers()
        assert.equal(ui.tooltip.hidden, true, 'retained focus must not reopen help over the editor')
        assert.equal(button.getAttribute('aria-describedby'), 'word-hint')

        ui.emit('pointerover', label)
        assert.equal(ui.tooltip.hidden, true, 'expanded section must remain unobscured on re-hover')
        ui.emit('focusout', button)
        ui.emit('focusin', button)
        assert.equal(ui.tooltip.hidden, true, 'expanded section must remain unobscured on refocus')

        ui.emit('click', button)
        button.setAttribute('aria-expanded', 'false')
        ui.emit('pointerout', button)
        ui.flushTimers()
        assert.equal(ui.tooltip.hidden, true, 'collapsing does not immediately reopen the tooltip')
        ui.emit('pointerover', button)
        assert.equal(ui.tooltip.hidden, false, 'collapsed section keeps its explanation on deliberate hover')
    })
}

test('focusing an expanded disclosure clears the previous control explanation', () => {
    const ui = createHelp()
    const help = ui.trigger({ help: true })
    const expanded = ui.trigger()
    expanded.setAttribute('aria-expanded', 'true')
    ui.emit('focusin', help)
    assert.equal(ui.tooltip.hidden, false)
    ui.emit('focusout', help)
    ui.emit('focusin', expanded)
    ui.flushTimers()
    assert.equal(ui.tooltip.hidden, true)
    assert.equal(help.getAttribute('aria-describedby'), null)
})
