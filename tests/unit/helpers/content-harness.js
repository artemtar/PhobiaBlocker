const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repoRoot = path.resolve(__dirname, '../../..')

function eventTarget() {
    const listeners = new Map()
    return {
        addEventListener(type, callback) {
            if (!listeners.has(type)) listeners.set(type, new Set())
            listeners.get(type).add(callback)
        },
        removeEventListener(type, callback) { listeners.get(type)?.delete(callback) },
        dispatchEvent(event) { listeners.get(event.type)?.forEach(callback => callback(event)) },
    }
}

class Style {
    constructor() { this.values = new Map() }
    setProperty(name, value, priority = '') {
        // Chromium serializes filter lengths with less precision than the
        // assigned JavaScript number, e.g. 29.978680971459422px -> 29.9787px.
        if (name === 'filter') {
            value = value.replace(/blur\(([\d.]+)px\)/g, (_, amount) => (
                `blur(${Number(Number(amount).toPrecision(6))}px)`
            ))
        }
        this.values.set(name, { value, priority })
    }
    getPropertyValue(name) { return this.values.get(name)?.value || '' }
    getPropertyPriority(name) { return this.values.get(name)?.priority || '' }
    removeProperty(name) { this.values.delete(name) }
    get cssText() {
        return [...this.values].map(([name, { value, priority }]) =>
            `${name}: ${value}${priority ? ' !important' : ''};`).join(' ')
    }
    set cssText(text) {
        this.values.clear()
        for (const declaration of text.split(';')) {
            const colon = declaration.indexOf(':')
            if (colon < 0) continue
            const name = declaration.slice(0, colon).trim()
            const raw = declaration.slice(colon + 1).trim()
            const important = raw.endsWith('!important')
            this.setProperty(name, important ? raw.slice(0, -10).trim() : raw, important ? 'important' : '')
        }
    }
}

// A minimal DOM tree: real parent/child ownership so the index, the cover
// manager and the controller run unchanged. Layout, painting and selectors
// beyond tag and class names stay with the browser suites.
class Node {
    constructor(nodeType) {
        this.nodeType = nodeType
        this.childNodes = []
        this.parentNode = null
    }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null }
    set parentElement(value) { this.parentNode = value }
    get isConnected() {
        for (let current = this; current; current = current.parentNode) {
            if (current.nodeType === 9) return true
        }
        return false
    }
    get firstChild() { return this.childNodes[0] || null }
    get textContent() {
        if (this.nodeType === 3) return this.nodeValue
        return this.childNodes.map(child => child.textContent).join('')
    }
    set textContent(value) {
        if (this.nodeType === 3) {
            this.nodeValue = value
            return
        }
        for (const child of [...this.childNodes]) this.removeChild(child)
        if (value) this.appendChild(new TextNode(value))
    }
    appendChild(child) {
        if (child.nodeType === 11) {
            for (const part of [...child.childNodes]) this.appendChild(part)
            return child
        }
        child.parentNode?.removeChild(child)
        this.childNodes.push(child)
        child.parentNode = this
        return child
    }
    removeChild(child) {
        const index = this.childNodes.indexOf(child)
        if (index === -1) throw new Error('removeChild: the node is not a child of this node')
        this.childNodes.splice(index, 1)
        child.parentNode = null
        return child
    }
    replaceChild(replacement, old) {
        if (!this.childNodes.includes(old)) throw new Error('replaceChild: the node is not a child of this node')
        const next = replacement.nodeType === 11 ? [...replacement.childNodes] : [replacement]
        next.forEach(child => child.parentNode?.removeChild(child))
        this.childNodes.splice(this.childNodes.indexOf(old), 1, ...next)
        old.parentNode = null
        next.forEach((child) => { child.parentNode = this })
        return old
    }
}

class TextNode extends Node {
    constructor(value) {
        super(3)
        this.nodeValue = value
    }
}

class DocumentFragment extends Node {
    constructor() { super(11) }
}

class Element extends Node {
    constructor(tagName = 'DIV') {
        super(1)
        Object.assign(this, eventTarget())
        this.tagName = tagName.toUpperCase()
        this.attributes = new Map()
        this.style = new Style()
        const classes = new Set()
        this.classList = {
            contains: name => classes.has(name),
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
            [Symbol.iterator]: () => classes.values(),
        }
    }
    get className() { return [...this.classList].join(' ') }
    set className(value) {
        this.classList.remove(...[...this.classList])
        this.classList.add(...String(value).split(/\s+/).filter(Boolean))
    }
    getAttribute(name) {
        if (name === 'style') return this.style.cssText
        if (name === 'class') return this.className
        return this.attributes.get(name) ?? null
    }
    setAttribute(name, value) { this.attributes.set(name, value) }
    removeAttribute(name) { this.attributes.delete(name) }
    hasAttribute(name) { return this.attributes.has(name) }
    toggleAttribute(name, enabled) { enabled ? this.setAttribute(name, '') : this.removeAttribute(name) }
    matches(selector) {
        return selector.split(',').some(part => {
            const name = part.trim()
            if (name === '*') return true
            if (name.startsWith('.')) return this.classList.contains(name.slice(1))
            return name === this.tagName.toLowerCase()
        })
    }
    closest(selector) {
        return this.matches(selector) ? this : this.parentElement?.closest(selector) || null
    }
    querySelectorAll(selector) {
        const result = []
        for (const child of this.childNodes) {
            if (!(child instanceof Element)) continue
            if (child.matches(selector)) result.push(child)
            result.push(...child.querySelectorAll(selector))
        }
        return result
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
    getClientRects() { return [{}] }
    getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 100, height: 100 } }
}

class HTMLImageElement extends Element { constructor() { super('IMG') } }
class HTMLVideoElement extends Element { constructor() { super('VIDEO') } }
class HTMLIFrameElement extends Element { constructor() { super('IFRAME') } }
class HTMLPictureElement extends Element {}
class HTMLSourceElement extends Element {}
class HTMLLinkElement extends Element {}
class HTMLStyleElement extends Element {}

// Only browser boundaries are doubled. The complete policy, index and content
// scripts execute unchanged; real-browser checks cover layout and observers.
function createContentHarness() {
    const html = new Element('HTML')
    const body = html.appendChild(new Element('BODY'))
    const document = {
        ...eventTarget(), nodeType: 9, documentElement: html, body,
        readyState: 'loading', title: '', styleSheets: [],
        createElement: tag => new Element(tag),
        createTextNode: value => new TextNode(value),
        createDocumentFragment: () => new DocumentFragment(),
        querySelectorAll: selector => [html, ...html.querySelectorAll('*')].filter(node => node.matches(selector)),
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null },
        createTreeWalker(root) {
            const nodes = []
            const visit = node => {
                for (const child of node.childNodes || []) {
                    if (child.nodeType === 3) nodes.push(child)
                    else visit(child)
                }
            }
            visit(root)
            return { nextNode: () => nodes.shift() || null }
        },
    }
    html.parentNode = document
    const window = eventTarget()
    window.top = window
    const timers = new Map()
    const intervals = new Map()
    const observers = []
    const messages = []
    let nextTimer = 0
    const storage = { getWithDefaults: async () => ({ ...context.PhobiaBlockerPolicy.DEFAULTS }) }
    const context = vm.createContext({
        console, URL, document, window,
        location: { href: 'https://example.com/safe', origin: 'https://example.com' },
        Element, HTMLImageElement, HTMLVideoElement, HTMLIFrameElement,
        HTMLPictureElement, HTMLSourceElement, HTMLLinkElement, HTMLStyleElement,
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9 },
        NodeFilter: { SHOW_TEXT: 4 },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; observers.push(this) }
            observe(target, options) { this.target = target; this.options = options }
            disconnect() {}
        },
        Event: class { constructor(type) { this.type = type } },
        performance: { now: () => 100 }, queueMicrotask,
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
        clearTimeout(id) { timers.delete(id) },
        setInterval(callback, delay) { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id },
        clearInterval(id) { intervals.delete(id) },
        getComputedStyle: element => ({
            backgroundImage: element.style.getPropertyValue('background-image') || 'none',
            filter: element.style.getPropertyValue('filter') || 'none',
            display: 'block', visibility: 'visible', contentVisibility: 'visible', color: 'black',
        }),
        PhobiaBlockerStorage: storage,
        chrome: {
            runtime: {
                onMessage: { addListener: callback => messages.push(callback) },
                sendMessage: async () => ({ shouldBlur: false, matchedWords: [], matchedInputWords: [] }),
            },
            storage: { onChanged: { addListener() {} } },
        },
    })
    for (const file of ['shared-policy.js', 'page-text-index.js', 'js.js']) {
        vm.runInContext(fs.readFileSync(path.join(repoRoot, 'js', file), 'utf8'), context, { filename: file })
    }
    const api = vm.runInContext('({controller, readAndApplySettings, Policy})', context)
    return {
        ...api, context, document, body, html, window, timers, intervals, observers, messages, storage,
        image() { return body.appendChild(new HTMLImageElement()) },
        text(value) { return body.appendChild(new TextNode(value)) },
        async runTimers(delay) {
            for (const [id, timer] of [...timers]) {
                if (timer.delay !== delay) continue
                timers.delete(id)
                await timer.callback()
            }
        },
    }
}

module.exports = { createContentHarness }
