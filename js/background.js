// Create context menu on extension install/update
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'phobia-blocker-unblur',
        title: 'Unblur',
        contexts: ['all']
    })
})

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'phobia-blocker-unblur') {
        chrome.tabs.sendMessage(tab.id, { type: 'unblur' }).catch(err => {
            console.error('Failed to send unblur message:', err)
        })
    }
})

// chrome.tabs.insertCSS({file:"./css/style.css"})

// function injectedFunction() {
//   document.body.style.backgroundColor = 'orange';
// }

// chrome.action.onClicked.addListener((tab) => {
//   chrome.scripting.executeScript({
//     target: { tabId: tab.id },
//     function: injectedFunction
//   });
// });

// chrome.tabs.onCreated.addListener(do_something);
// chrome.tabs.onUpdated.addListener(function(tabId, info, tab) {
//     if (info.status == 'complete') do_something(tab);
// });

// function do_something(tab) {
//     var tabUrl = tab.url;
//     console.log('tab')
//     console.log(tabUrl)
//     if (tabUrl != -1) {
//         // if(tabUrl != 'chrome://newtab/'){
//         // changeBgkColour() here:
//         chrome.tabs.insertCSS(tab.id, {
//             file: "./css/style.css"
//         })
//     }
// }