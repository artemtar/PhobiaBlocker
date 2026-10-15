// Supplementary explanations shared by the popup and settings pages.
(() => {
    'use strict'

    function initializeHelp() {
        if (document.getElementById('pb-ui-tooltip')) return

        const tooltip = document.createElement('div')
        tooltip.id = 'pb-ui-tooltip'
        tooltip.className = 'pb-tooltip'
        tooltip.setAttribute('role', 'tooltip')
        tooltip.hidden = true
        document.body.appendChild(tooltip)

        // One bubble serves every control. activeTarget is the control it currently
        // describes; hovered/focused remember the inputs so the bubble can fall back
        // to whichever is still engaged; dismissedTarget suppresses re-showing after
        // Escape or activation until the pointer or focus deliberately re-enters.
        let activeTarget = null
        let hoveredTarget = null
        let focusedTarget = null
        let dismissedTarget = null
        let pinned = false
        let tooltipHovered = false
        let hideTimer

        const findTarget = node => node?.closest?.('[data-tooltip]') || null

        // Adds or removes only the tooltip id in aria-describedby so the control's
        // own descriptions (and any added while the bubble was open) survive.
        function describe(target, enabled) {
            const ids = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
            const descriptions = ids.filter(id => id !== tooltip.id)
            if (enabled) descriptions.push(tooltip.id)
            if (descriptions.length) target.setAttribute('aria-describedby', descriptions.join(' '))
            else target.removeAttribute('aria-describedby')
        }

        function hide() {
            clearTimeout(hideTimer)
            if (activeTarget) describe(activeTarget, false)
            activeTarget = null
            tooltip.hidden = true
        }

        function dismiss(target = activeTarget) {
            dismissedTarget = target
            pinned = false
            tooltipHovered = false
            hide()
        }

        function position() {
            if (!activeTarget) return
            // A re-render can detach the control, or its disclosure can open, between
            // show and a later resize/scroll; drop the bubble rather than float it.
            if (!activeTarget.isConnected || activeTarget.getAttribute('aria-expanded') === 'true') {
                dismiss()
                return
            }
            const bounds = activeTarget.getBoundingClientRect()
            const size = tooltip.getBoundingClientRect()
            const viewport = document.documentElement
            // Centre under the control, clamped to the viewport with an 8 px margin:
            // the action popup is narrow, so edge controls would otherwise clip.
            // Prefer below; flip above only when below would overflow the bottom.
            const margin = 8
            const maxLeft = Math.max(margin, viewport.clientWidth - size.width - margin)
            const maxTop = Math.max(margin, viewport.clientHeight - size.height - margin)
            const left = Math.min(maxLeft, Math.max(margin, bounds.left + (bounds.width - size.width) / 2))
            const below = bounds.bottom + margin
            const above = bounds.top - size.height - margin
            const top = below <= maxTop ? below : above
            tooltip.style.left = `${left}px`
            tooltip.style.top = `${Math.min(maxTop, Math.max(margin, top))}px`
        }

        function show(target) {
            if (!target || target === dismissedTarget) return
            // Once a disclosure is open, its content takes the place of the
            // supplementary explanation. Keep hover and focus clear of it.
            if (target.getAttribute('aria-expanded') === 'true') {
                hide()
                return
            }
            const text = target.getAttribute('data-tooltip')
            if (!text) return
            clearTimeout(hideTimer)
            if (activeTarget && activeTarget !== target) describe(activeTarget, false)
            activeTarget = target
            tooltip.textContent = text
            tooltip.hidden = false
            describe(target, true)
            position()
        }

        // The delay lets the pointer cross the gap between a control and its bubble
        // (pointerout fires before pointerenter on the tooltip) and lets a pinned or
        // still-focused control keep its help after the pointer leaves.
        function scheduleHide() {
            clearTimeout(hideTimer)
            // 150 ms is the conventional tooltip grace period: long enough to move
            // diagonally into the bubble, short enough not to linger over the next
            // control. Nothing in the CSS depends on the exact value.
            hideTimer = setTimeout(() => {
                if (pinned || tooltipHovered) return
                const target = hoveredTarget || focusedTarget
                if (target && target !== dismissedTarget) show(target)
                else hide()
            }, 150)
        }

        // pointerover/out also fire when moving between a control's own children;
        // relatedTarget inside the control means no real enter or leave happened.
        document.addEventListener('pointerover', (event) => {
            const target = findTarget(event.target)
            if (!target || target.contains(event.relatedTarget)) return
            hoveredTarget = target
            // While pinned the hover is remembered but must not steal the bubble.
            if (pinned) return
            dismissedTarget = null
            show(target)
        })

        document.addEventListener('pointerout', (event) => {
            const target = findTarget(event.target)
            if (!target || target.contains(event.relatedTarget)) return
            if (hoveredTarget === target) hoveredTarget = null
            scheduleHide()
        })

        document.addEventListener('focusin', (event) => {
            const target = findTarget(event.target)
            if (!target) return
            focusedTarget = target
            // Focus moving to a different control releases a pin; refocusing the
            // pinned help button itself keeps it.
            if (target !== activeTarget) pinned = false
            dismissedTarget = null
            show(target)
        })

        document.addEventListener('focusout', (event) => {
            const target = findTarget(event.target)
            if (!target || target.contains(event.relatedTarget)) return
            if (focusedTarget === target) focusedTarget = null
            scheduleHide()
        })

        // Capture help clicks before any containing row can change a setting.
        // Other controls retain their normal click and keyboard behavior.
        document.addEventListener('click', (event) => {
            const help = event.target.closest?.('button.pb-help[data-tooltip]')
            if (help) {
                event.preventDefault()
                event.stopPropagation()
                if (activeTarget === help && pinned) dismiss()
                else {
                    dismissedTarget = null
                    pinned = true
                    show(help)
                }
            } else if (!tooltip.contains(event.target)) {
                // Clicks inside the bubble (selecting its text) keep it open.
                // Activation keeps focus on the control. Suppress its tooltip
                // until deliberate re-entry, before its own click handler runs.
                dismiss(findTarget(event.target) || activeTarget)
            }
        }, true)

        // In Chrome's toolbar popup Escape also closes the popup itself, so this
        // path is mainly useful on the settings page; clicking the help button
        // again is the dismissal that works in both.
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && activeTarget) dismiss()
        })

        tooltip.addEventListener('pointerenter', () => {
            tooltipHovered = true
            clearTimeout(hideTimer)
        })
        tooltip.addEventListener('pointerleave', () => {
            tooltipHovered = false
            scheduleHide()
        })
        window.addEventListener('resize', position)
        // scroll does not bubble; capture catches scrolling inside nested panels.
        document.addEventListener('scroll', position, true)
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeHelp, { once: true })
    } else {
        initializeHelp()
    }
})()
