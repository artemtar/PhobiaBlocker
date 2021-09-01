//TODO
//Tags not loading on first run
$(() => {
    chrome.storage.sync.get("blurValueAmount", function(storage) {
        if (el['blurValueAmount']) {
            $('#range').val(storage['blurValueAmount']);
        } else {
            // console.log('will you work')
            // var blurValueAmount = getComputedStyle(document.documentElement).getPropertyValue('--blurValueAmount');
            // console.log("well " + blurValueAmount);
            $('#range').val(2);
        }
    });

    var input = document.querySelector('.addFromOutside'),
        button = document.querySelector('.addWordBtn'),
        tagify = new Tagify(input, {
            pattern: /^.{0,30}$/,
            maxTags: 20,
        });

    button.addEventListener("click", onAddButtonClick)

    function updateTarget(e) {
        newTarget = tagify.value.map(e => e['value']);
        chrome.storage.sync.set({ target: newTarget });
        chrome.tabs.query({}, function(tabs) {
            var message = { type: "updateTarget" };
            for (var i = 0; i < tabs.length; ++i) {
                chrome.tabs.sendMessage(tabs[i].id, message);
            }
        });
    }

    tagify.on('edit', updateTarget)
          .on('remove', updateTarget)
          .on('add', updateTarget);

    function onAddButtonClick() {
        tagify.addEmptyTag()
    }
    chrome.storage.sync.get('target', function(el) {
        if (el) {
            target = el['target'];
            tagify.addTags(target);
        } else {
            console.error('Empty target');
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
        var blurValueAmount = $(this).val();
        chrome.storage.sync.set({ "blurValueAmount": blurValueAmount }, function() {
            chrome.storage.sync.get("blurValueAmount", function(el) {
                console.log(el['blurValueAmount']);
            });
        });
        chrome.tabs.query({}, function(tabs) {
            var message = { type: "setBlur" };
            for (var i = 0; i < tabs.length; ++i) {
                chrome.tabs.sendMessage(tabs[i].id, message);
            }
        });
    });


});