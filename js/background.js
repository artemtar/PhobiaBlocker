chrome.contextMenus.create({
    title: 'Unblur',
    contexts: ['image'],
    onclick: (info, tab) => {
        console.log('unblur')
        chrome.tabs.sendMessage(tab.id, { type: 'unblur' });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'retriveTargetWords':
            retriveTargetWords();
            sendResponse(true);
            break;
    }
});

let retriveTargetWords = () => {
    chrome.storage.sync.get('target', (storage) => {
        if (storage['target']) {} else {
            defaultTarget = ["rodent", "mice", "rat", "beaver", "squirrel"];
            chrome.storage.sync.set({ 'target': defaultTarget });
        }
    });
}