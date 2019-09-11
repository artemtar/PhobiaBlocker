var inProsess = 0;

var doHeavyCompute = function(mutation) {
    // dosomething with mutation
    inProsess += 1;
    return new Promise((resolve, err) => {
        resolve(2 + 2);
    });
};

var promiseWraper = async function(mutation, callback) {
    var res = await doHeavyCompute(mutation);
    callback(inProsess);
    inProsess -= 1;
    return res
}

var printEverySecond = function(i) {
    if (i % 2 == 0) {
        console.log('i am second ' + i);
    }
}

myList = [];
var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
        myList.concat(promiseAnalizer($(mutation.target), printEverySecond));
    });
});