$(function() {
    $('#unblurBtn').click(function() {
        chrome.tabs.query({ active: true, currentWindow: true },
            function(tabs) {
                chrome.tabs.sendMessage(tabs[0].id, { type: "unblurAll" });
            });
    });
    $('#blurBtn').click(function() {
        chrome.tabs.query({ active: true, currentWindow: true },
            function(tabs) {
                chrome.tabs.sendMessage(tabs[0].id, { type: "blurAll" });
            });
    });
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "getTarget" }, function(count) {
            console.log(target);
        });
    });
});