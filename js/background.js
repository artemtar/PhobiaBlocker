chrome.contextMenus.create({
    title: 'Unblur',
    contexts: ['image'],
    onclick: function(info, tab) {
        chrome.tabs.sendMessage(tab.id, 'unblur');
    }
});