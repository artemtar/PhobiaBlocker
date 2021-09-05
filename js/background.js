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
        case 'setInitialTargetWords':
            setInitialTargetWords();
            sendResponse({complete: true});
            break;
    }
    return true;
});

let setInitialTargetWords = () => {
    chrome.storage.sync.get('target', (storage) => {
        if (!storage['target']) {
            defaultTarget = ["rodent", "mice", "rat", "beaver", "squirrel"];
            chrome.storage.sync.set({ 'target': defaultTarget });
        }
    });
}

// chrome.storage.onChanged.addListener(function (changes, namespace) {
//   for (let [key, { oldValue, newValue }] of Object.entries(changes)) {
//     console.log(
//       `Storage key "${key}" in namespace "${namespace}" changed.`,
//       `Old value was "${oldValue}", new value is "${newValue}".`
//     );
//   }
// });

function logStorageChange(changes, area) {
  console.log("Change in storage area: " + area);
 
  var changedItems = Object.keys(changes);
 
  for (item of changedItems) {
    console.log(item + " has changed:");
    console.log("Old value: ");
    console.log(changes[item].oldValue);
    console.log("New value: ");
    console.log(changes[item].newValue);
  }
}

chrome.storage.onChanged.addListener(logStorageChange);