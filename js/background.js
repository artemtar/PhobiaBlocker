chrome.contextMenus.create({
    title: 'Unblur',
    contexts: ['image'],
    onclick: function(info, tab) {
        chrome.tabs.sendMessage(tab.id, { type: 'unblur' });
    }
});

chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {
        localStorage["target"] = request.target;
    }
);