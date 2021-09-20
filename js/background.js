
chrome.contextMenus.create({
    title: 'Unblur',
    contexts: ['all'],
    onclick: (info, tab) => {
        chrome.tabs.sendMessage(tab.id, { type: 'unblur' })
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