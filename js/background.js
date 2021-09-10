
chrome.contextMenus.create({
    title: 'Unblur',
    contexts: ['all'],
    onclick: (info, tab) => {
        chrome.tabs.sendMessage(tab.id, { type: 'unblur' })
    }
})
