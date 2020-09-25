chrome.contextMenus.create({
    title: 'Unblur',
    contexts: ['image'],
    onclick: function(info, tab) {
        chrome.tabs.sendMessage(tab.id, { type: 'unblur' });
    }
});

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    switch (message.type) {
        case 'retriveTarget':
            retriveTarget();
            sendResponse(true);
            break;
            // default:
            //     console.error("Unrecognised message: ", message);
    }
});

let retriveTarget = function() {
    chrome.storage.sync.get('target', function(el) {
        if (el['target']) {} else {
            defaultTarget = ["rodent", "mice", "rat", "beaver", "squirrel"];
            chrome.storage.sync.set({ 'target': defaultTarget }, function() {});
        }
    });
}