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
    $(document).on('input', '#range', function() {
            var blurVar = $(this).val();
            chrome.storage.sync.set({ "blurVar": blurVar }, function() {
                let a = chrome.storage.sync.get(["blurVar"], function(el) {
                    console.log(el.key);
                });
            });
        })
        // chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        //     chrome.tabs.sendMessage(tabs[0].id, { type: "getTarget" }, function(target) {
        //         console.log(target);
        //     });
        // });
});