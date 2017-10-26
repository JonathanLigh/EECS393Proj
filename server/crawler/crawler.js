var https = require('https');
var fileSystem = require('fs');
var exitHook = require('exit-hook');
const regex = require('./regexModule');
const descriptionParser = require('./descriptionParser');

var batchSize = 1;

var testingMode = false;
var triggerExit = false;

var statePath = "state.json";
var state = {
    after: "",
    maxDepthReached: 0,
    maxDepthSubreddit: ""
};

function getReddits(after) {
    return new Promise(function(resolve, reject) {
        function get_json(url, callback) {
            console.log(`Querying ${url}`);
            https.get(url, function(res) {
                var body = '';
                res.on('data', function(chunk) {
                    body += chunk;
                });

                res.on('end', function() {
                    var response = JSON.parse(body);
                    callback(response);
                });

                res.on('error', function(error) {
                    reject(error);
                });
            });
        }

        function buildURL(after) {
            var url = "https://www.reddit.com/reddits.json";
            if (!!batchSize) {
                url += "?limit=" + batchSize;
            }
            if (!!after) {
                url += "&after=" + after;
            }
            return url;
        }

        get_json(buildURL(after, batchSize), function(response) {
            var subreddit;
            for (subreddit in response.data.children) {
                parseSubreddit(response.data.children[subreddit].data);
            }

            resolve(response.data.after);
        });
    });
}

function parseSubreddit(subreddit) {
    var subredditData;
    var fileName = regex.getNameFromURL(subreddit.url)
    if (fileSystem.existsSync(parsedSubredditFolder(testingMode) + fileName + ".json")) {
        subredditData = JSON.parse(fileSystem.readFileSync(parsedSubredditFolder(testingMode) + fileName + ".json"));
        console.log(`Discovered ${subreddit.url}`);
    } else {
        console.log(`Discovered New ${subreddit.url}`);
        subredditData = {
            tags: []
        }
    }

    subredditData.url = subreddit.url;
    subredditData.name = subreddit.name;
    subredditData.total_subscribers = subreddit.subscribers;

    const csvMatcher = /\b[\w\s]+\b/gi;
    var tags = regex.getListOfMatches(subreddit.audience_target, csvMatcher);
    var i;
    for (i in tags) {
        updateTags(subredditData, {
            tag: tags[i],
            mentionDistance: 0
        }, 0);
    }

    subredditData.relatedSubreddits = descriptionParser.getMentionedSubreddits(subreddit);

    writeSubreddit(fileName, subredditData);

    for (i in subredditData.relatedSubreddits) {
        console.log("Updating (" + i + "/" + subredditData.relatedSubreddits.length + "): " + subredditData.relatedSubreddits[i]);
        propagateSubredditData(subredditData.relatedSubreddits[i], subredditData, 1, []);
    }

    console.log(`Finished ${subreddit.url}`);
}

function writeSubreddit(fileName, subredditData) {
    var subredditPath = parsedSubredditFolder(testingMode) + fileName + ".json";
    fileSystem.writeFileSync(subredditPath, JSON.stringify(subredditData));
}

function propagateSubredditData(subredditURL, parentSubredditData, depth, searched) {
    // Statistical analysis
    if (state.maxDepthReached < depth) {
        state.maxDepthReached = depth;
        state.maxDepthSubreddit = subredditURL;
    }
    // This is really inefficient but that is because the db isnt ready yet
    var fileName = regex.getNameFromURL(subredditURL);

    // Handle self referential loops
    if (searched.indexOf(fileName) !== -1) {
        return;
    }

    var subredditData;
    var relatedURL = parentSubredditData.url.replace(/^\/|\/$/g, '');
    if (fileSystem.existsSync(parsedSubredditFolder(testingMode) + fileName + ".json")) {
        subredditData = JSON.parse(fileSystem.readFileSync(parsedSubredditFolder(testingMode) + fileName + ".json"));
        if (subredditData.relatedSubreddits.indexOf(relatedURL) === -1) {
            subredditData.relatedSubreddits.push(relatedURL);
        }
    } else {
        subredditData = {
            url: subredditURL,
            tags: [],
            relatedSubreddits: [relatedURL]
        };
    }
    var updatedTags = false;
    var i;
    for (i in parentSubredditData.tags) {
        updatedTags = updatedTags || updateTags(subredditData, parentSubredditData.tags[i], depth);
    }
    if (updatedTags) {
        writeSubreddit(regex.getNameFromURL(subredditURL), subredditData);
        if (!!subredditData.relatedSubreddits) {
            for (i in subredditData.relatedSubreddits) {
                // we want to update any possible tags that weren't originally referenced.
                var nextFileName = regex.getNameFromURL(subredditData.relatedSubreddits[i]);
                var index = searched.indexOf(nextFileName);
                if (index > -1) {
                    searched.splice(index, 1);
                }
                propagateSubredditData(subredditData.relatedSubreddits[i], subredditData, depth + 1, searched);
            }
        }
    } else {
        searched.push(fileName);
    }
}

// Tags are {tag:"tagName", mentionDistance:X}
function updateTags(subredditData, newTag, depth) {
    var i;
    for (i in subredditData.tags) {
        var existingTag = subredditData.tags[i];
        if (existingTag.tag === newTag.tag) {
            if (existingTag.mentionDistance > (newTag.mentionDistance + depth)) {
                existingTag.mentionDistance = (newTag.mentionDistance + depth);
                return true;
            }
            return false;
        }
    }
    subredditData.tags.push({
        tag: newTag.tag,
        mentionDistance: newTag.mentionDistance + depth
    });
    return true;
}

function continueSearch(after) {
    getReddits(after).then(
        function(after) {
            state.after = after;
            setTimeout(function() {
                continueSearch(after);
            }, 1000);
        },
        function(error) {
            console.log(error);
            process.exit(1);
        });
}

function loadStateJSON(callback) {
    fileSystem.readFile(statePath, (err, data) => {
        if (err) {
            console.log("state.json file not initialized");
        } else {
            if (data.byteLength === 0) {
                console.log("state.json file is empty");
            } else {
                state = JSON.parse(data);
            }
        }
        callback(state.after);
    });
}

exitHook(function() {
    if (triggerExit) {
        if (!testingMode) {
            fileSystem.writeFileSync(statePath, JSON.stringify(state));
            console.log("    Crawler terminated, current state saved as " + state.after);
        }
        process.exit(0);
    }
});

module.exports = {
    crawl: function(size) {
        if (size > 100) {
            console.log("Max batch size is 100");
            size = 100;
        } else if (size < 0) {
            console.log("Min batch size is 1");
            size = 1;
        }
        batchSize = size;
        triggerExit = true;
        loadStateJSON(function(after) {
            console.log("Starting search from " + state.after);
            continueSearch(after);
        });
    },
    parsedSubredditFolder: function(testing) {
        if (testing) {
            return "./parsed_subreddits_test/";
        }
        return "./parsed_subreddits/";
    },
    test() {
        testingMode = true;

        function whenNewData_writeSubreddit_fileCreated() {
            // Given
            var fileName = "a";
            var data = {
                "test": "test"
            }

            // When
            writeSubreddit(fileName, data);

            // Then
            if (fs.existsSync(parsedSubredditFolder(testingMode) + fileName + ".json")) {
                var readData = fs.readFileSync(parsedSubredditFolder(testingMode) + fileName + ".json");
                if (readData.test === data.test) {
                    return true;
                }
            }
            return false;
        }

        function whenExistingData_writeSubreddit_fileUpdated() {
            // Given
            var fileName = "a";
            var data = {
                "test": "test"
            };
            writeSubreddit(fileName, data);
            var updateData = {
                "test": "test2"
            };

            // When
            writeSubreddit(fileName, updateData);

            // Then
            if (fs.existsSync(parsedSubredditFolder(testingMode) + fileName + ".json")) {
                var readData = fs.readFileSync(parsedSubredditFolder(testingMode) + fileName + ".json");
                if (readData.test === updateData.test) {
                    return true;
                }
            }
            return false;
        }

        function whenTagsEmpty_updateTags_tagUpdated() {
            // Given
            var subredditData = {
                tags: []
            };
            var newTag = {
                tag: "tag",
                mentionDistance: 0
            };
            var depth = 0;

            // When
            var updated = updateTags(subredditData, newTag, depth);

            if (updated) {
                if (subredditData.tags.length === 1 && subredditData.tags[0].tag === newTag.tag) {
                    return true;
                }
            }
            return false;
        }

        function whenTagExists_updateTags_closerDistance_tagUpdated() {
            // Given
            var subredditData = {
                tags: [{
                    tag: "tag",
                    mentionDistance: 1
                }]
            };
            var newTag = {
                tag: "tag",
                mentionDistance: 0
            };
            var depth = 0;

            // When
            var updated = updateTags(subredditData, newTag, depth);

            if (updated) {
                if (subredditData.tags.length === 1 && subredditData.tags[0].tag === newTag.tag && subredditData.tags[0].mentionDistance === depth) {
                    return true;
                }
            }
            return false;
        }

        function whenTagExists_updateTags_fartherDistance_tagNotUpdated() {
            // Given
            var subredditData = {
                tags: [{
                    tag: "tag",
                    mentionDistance: 0
                }]
            };
            var newTag = {
                tag: "tag",
                mentionDistance: 0
            };
            var depth = 1;

            // When
            var updated = updateTags(subredditData, newTag, depth);

            if (!updated) {
                if (subredditData.tags.length === 1 && subredditData.tags[0].mentionDistance === 0) {
                    return true;
                }
            }
            return false;
        }
    }
};

/*
updateDescription: function(size) {
    if (size > 100) {
        console.log("Max batch size is 100");
        size = 100;
    } else if (size < 0) {
        console.log("Min batch size is 1");
        size = 1;
    }
    batchSize = size;
    loadStateJSON(function(after) {
        console.log("Starting search from " + state.after);
        continueSearch(after);
    });
}*/

require('make-runnable/custom')({
    printOutputFrame: false
});


//we will move these to the top, but in the mean time they can be here
const chai = require('chai');
const spies = require('chai-spies');
chai.use(spies);
const expect = chai.expect;

/*
For the first few functions I wrote a bunch of example possible tests
that you could run. But it's entirely up to you, also it might be possible for
you to put these tests at the end of the files that they are testing. We can do
this because our test comand runs "mocha filepath" mocha automatically searches
for testing syntax and executes them, that means you can have tests in your
files that only execute during testing. However, I absolutely recomend a great
refactoring now that we have it functioning. -Jonathan
*/

describe('Testing buildURL', () => {

  it('buildURL correctly builds the URL', () => {

  });

  it('buildURL does this if no batchsize', () => {

  });

  it('buildURL does this if no argument specified', () => {

  });

  it('buildURL throws an error when ...', () => {

  });
//etc...
});

describe('Testing parseSubreddit', () => {

  it('parseSubreddit outputs expected value', () => {

  });

  it('parseSubreddit throws an error when expected', () => {

  });

  it('parseSubreddit does this if the subreddit does not exists', () => {

  });

});

describe('Testing writeSubreddit', () => {

  it('writeSubreddit correctly writes out the subreddit with expected values', () => {

  });

  it('writeSubreddit throws an error when expected', () => {

  });

});

describe('Testing propogateSubredditData', () => {

  it('propogateSubredditData outputs expected value', () => {

  });

  it('propogateSubredditData throws an error when expected', () => {

  });

  it('propogateSubredditData does this if the subreddit does not exists', () => {

  });

});

describe('Testing updateTags', () => {

  it('updateTags outputs expected value', () => {

  });

  it('updateTags throws an error when expected', () => {

  });

});

describe('Testing loadStateJSON', () => {

  it('loadStateJSON outputs expected value', () => {

  });

  it('loadStateJSON throws an error when expected', () => {

  });

});