chrome.contextMenus.create({
    title: 'Unblur',
    contexts: ['image'],
    onclick: (info, tab) => {
        chrome.tabs.sendMessage(tab.id, { type: 'unblur' });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'retriveTarget':
            retriveTarget();
            sendResponse(true);
            break;
            // default:
            //     console.error("Unrecognised message: ", message);
    }
});

let retriveTarget = () => {
    chrome.storage.sync.get('target', (storage) => {
        if (storage['target']) {} else {
            defaultTarget = ["rodent", "mice", "rat", "beaver", "squirrel"];
            chrome.storage.sync.set({ 'target': defaultTarget }, () => {});
        }
    });
}