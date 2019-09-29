$(function() {
    chrome.storage.sync.get("blurVar", function(el) {
        if (el['blurVar']) {
            $('#range').val(el['blurVar']);
            console.log("gotten " + el['blurVar']);
        } else {
            // console.log('will you work')
            // var blurVar = getComputedStyle(document.documentElement).getPropertyValue('--blurVar');
            // console.log("well " + blurVar);
            $('#range').val(2);
        }
    });
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
            chrome.storage.sync.get("blurVar", function(el) {
                console.log(el['blurVar']);
            });
        });
        chrome.tabs.query({}, function(tabs) {
            var message = { type: "setBlur" };
            for (var i = 0; i < tabs.length; ++i) {
                chrome.tabs.sendMessage(tabs[i].id, message);
            }
        });
    })
});