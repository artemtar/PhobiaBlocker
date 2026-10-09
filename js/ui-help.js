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

        let activeTarget = null
        let hoveredTarget = null
        let focusedTarget = null
        let dismissedTarget = null
        let pinned = false
        let tooltipHovered = false
        let hideTimer

        const findTarget = node => node?.closest?.('[data-tooltip]') || null

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
            if (!activeTarget.isConnected || activeTarget.getAttribute('aria-expanded') === 'true') {
                dismiss()
                return
            }
            const bounds = activeTarget.getBoundingClientRect()
            const size = tooltip.getBoundingClientRect()
            const viewport = document.documentElement
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

        function scheduleHide() {
            clearTimeout(hideTimer)
            hideTimer = setTimeout(() => {
                if (pinned || tooltipHovered) return
                const target = hoveredTarget || focusedTarget
                if (target && target !== dismissedTarget) show(target)
                else hide()
            }, 150)
        }

        document.addEventListener('pointerover', (event) => {
            const target = findTarget(event.target)
            if (!target || target.contains(event.relatedTarget)) return
            hoveredTarget = target
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
                // Activation keeps focus on the control. Suppress its tooltip
                // until deliberate re-entry, before its own click handler runs.
                dismiss(findTarget(event.target) || activeTarget)
            }
        }, true)

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
        document.addEventListener('scroll', position, true)
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeHelp, { once: true })
    } else {
        initializeHelp()
    }
})()
