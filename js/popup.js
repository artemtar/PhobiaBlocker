//TODO
//Tags not loading on first run
$(function () {
    chrome.storage.sync.get("blurVar", function (el) {
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

    var input = document.querySelector('.addFromOutside'),
        button = document.querySelector('.iambutton'),
        tagify = new Tagify(input, {
            pattern: /^.{0,30}$/,
            maxTags: 20,
        });

    button.addEventListener("click", onAddButtonClick)

    tagify.on('edit', updateTarget)
        .on('remove', updateTarget)
        .on('add', updateTarget);

    function updateTarget(e) {
        console.log(e);
        console.log('that was input');
        newTarget = tagify.value.map(e => e['value']);
        console.log(newTarget);
        chrome.storage.sync.set({ target: newTarget});
        chrome.tabs.query({}, function (tabs) {
            var message = { type: "updateTarget" };
            for (var i = 0; i < tabs.length; ++i) {
                chrome.tabs.sendMessage(tabs[i].id, message);
            }
        });
    }

    function onAddButtonClick() {
        tagify.addEmptyTag()
    }
    chrome.storage.sync.get('target', function (el) {
        if (el) {
            target = el['target'];
            tagify.addTags(target);
        } else {
            console.error('Empty target');
        }
    });

    $('#unblurBtn').click(function () {
        chrome.tabs.query({ active: true, currentWindow: true },
            function (tabs) {
                chrome.tabs.sendMessage(tabs[0].id, { type: "unblurAll" });
            });
    });
    $('#blurBtn').click(function () {
        chrome.tabs.query({ active: true, currentWindow: true },
            function (tabs) {
                chrome.tabs.sendMessage(tabs[0].id, { type: "blurAll" });
            });
    });
    $(document).on('input', '#range', function () {
        var blurVar = $(this).val();
        chrome.storage.sync.set({ "blurVar": blurVar }, function () {
            chrome.storage.sync.get("blurVar", function (el) {
                console.log(el['blurVar']);
            });
        });
        chrome.tabs.query({}, function (tabs) {
            var message = { type: "setBlur" };
            for (var i = 0; i < tabs.length; ++i) {
                chrome.tabs.sendMessage(tabs[i].id, message);
            }
        });
    });


});

