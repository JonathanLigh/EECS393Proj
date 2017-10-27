var https = require('https');
var fileSystem = require('fs');
var exitHook = require('exit-hook');
const regex = require('./regexModule');
const descriptionParser = require('./descriptionParser');

var batchSize = 1;

var logging = false;

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

        get_json(buildURL(after, batchSize), function(response) {
            var subreddit;
            for (subreddit in response.data.children) {
                parseSubreddit(response.data.children[subreddit].data);
            }

            resolve(response.data.after);
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

function parseSubreddit(subreddit) {
    var subredditData;
    var fileName = regex.getNameFromURL(subreddit.url)
    if (fileSystem.existsSync(parsedSubredditDir(testingMode) + fileName + ".json")) {
        subredditData = JSON.parse(fileSystem.readFileSync(parsedSubredditDir(testingMode) + fileName + ".json"));
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
        updateTag(subredditData, {
            tag: tags[i],
            mentionDistance: 0
        }, 0);
    }

    subredditData.relatedSubreddits = descriptionParser.getMentionedSubreddits(subreddit);

    writeSubreddit(fileName, subredditData);

    for (i = 0; i < subredditData.relatedSubreddits.length; i++) {
        console.log("Updating (" + (i + 1) + "/" + subredditData.relatedSubreddits.length + "): " + subredditData.relatedSubreddits[i]);
        propagateSubredditData(subredditData.relatedSubreddits[i], subredditData, 1, []);
    }

    console.log(`Finished ${subreddit.url}`);
}

function writeSubreddit(fileName, subredditData) {
    var subredditPath = parsedSubredditDir(testingMode) + fileName + ".json";
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
    var existed = fileSystem.existsSync(parsedSubredditDir(testingMode) + fileName + ".json");
    if (existed) {
        if (logging) {
            console.log("Updating Subreddit: " + subredditURL);
        }
        subredditData = JSON.parse(fileSystem.readFileSync(parsedSubredditDir(testingMode) + fileName + ".json"));
        if (subredditData.relatedSubreddits.indexOf(relatedURL) === -1) {
            subredditData.relatedSubreddits.push(relatedURL);
        }
    } else {
        if (logging) {
            console.log("Creating New Subreddit: " + subredditURL);
        }
        subredditData = {
            url: subredditURL,
            tags: [],
            relatedSubreddits: [relatedURL]
        };
    }
    var updatedTags = false;
    var i;
    for (i in parentSubredditData.tags) {
        updatedTags = updatedTags || updateTag(subredditData, parentSubredditData.tags[i], depth);
    }
    if (updatedTags || !existed) {
        writeSubreddit(regex.getNameFromURL(subredditURL), subredditData);
        if (logging) {
            console.log("Subreddit Saved: " + subredditURL);
        }
        if (updatedTags && !!subredditData.relatedSubreddits) {
            for (i in subredditData.relatedSubreddits) {
                // we want to update any possible tags that weren't originally referenced.
                var nextFileName = regex.getNameFromURL(subredditData.relatedSubreddits[i]);
                var index = searched.indexOf(nextFileName);
                if (index > -1) {
                    searched.splice(index, 1);
                    if (logging) {
                        console.log("Need to scan " + nextFileName + " again in case changes relate.");
                    }
                }
                if (logging) {
                    console.log("Updating (" + i + "/" + subredditData.relatedSubreddits.length + "): " + subredditData.relatedSubreddits[i]);
                }
                propagateSubredditData(subredditData.relatedSubreddits[i], subredditData, depth + 1, searched);
            }
        }
    } else {
        if (logging) {
            console.log("Finished: " + subredditURL);
        }
        searched.push(fileName);
    }
}

// Tags are {tag:"tagName", mentionDistance:X}
function updateTag(subredditData, newTag, depth) {
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
    if (logging) {
        console.log("Exit Hook Triggered");
    }
    if (triggerExit) {
        if (!testingMode) {
            fileSystem.writeFileSync(statePath, JSON.stringify(state));
            console.log("    Crawler terminated, current state saved as " + state.after);
        }
        process.exit(0);
    }
});

const parsedSubredditDir = (testing) => {
    if (testing) {
        return "./server/crawler/parsed_subreddits_test/";
    }
    return "./parsed_subreddits/";
};

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
    parsedSubredditDir: parsedSubredditDir,
    _buildURL: function(after) {
        testingMode = true;
        return buildURL(after);
    },
    _parseSubreddit: function(subreddit) {
        testingMode = true;
        return parseSubreddit(subreddit);
    },
    _writeSubreddit: function(fileName, subredditData) {
        testingMode = true;
        return writeSubreddit(fileName, subredditData);
    },
    _propagateSubredditData: function(subredditURL, parentSubredditData, depth, searched) {
        testingMode = true;
        return propagateSubredditData(subredditURL, parentSubredditData, depth, searched);
    },
    _updateTag: function(subredditData, newTag, depth) {
        testingMode = true;
        return updateTag(subredditData, newTag, depth);
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
