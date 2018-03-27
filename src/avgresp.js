#!/usr/bin/env node
'use strict';

module.exports = {
    avgresp: avgresp,
    getAverageResp: getAverageResp
};


var history;
var samples;
var fullhistory = false;

/**
 * Create middleware to record and output average response times
 * @param  {Object} options
 * @return {function}
 */
function avgresp(options) {

    var opts = options || {};

    history = 50;
    samples = new Array(history);
    var currentIndex = 0;

    function updateAverage(time) {
        if (currentIndex == history - 1) {
            currentIndex = 0;
            fullhistory = true;
        }

        samples[currentIndex] = time;
        currentIndex++;
    }

    return function avgresp(req, res, next) {
        var startTime = process.hrtime();

        res.on('finish', function() {
            var diff = process.hrtime(startTime);
            var time = diff[0] * 1e3 + diff[1] * 1e-6

            updateAverage(time);
        })

        next();
    }
}

function getAverageResp() {
    var sum = 0;
    if (samples.length > 0) {
        sum = samples.reduce(function(total, val) {
            return total + val;
        },0);
    }

    var historySize = history;

    if (!fullhistory) {
        historySize = samples.reduce(function(total, val) {
            return total?++total:1;
        },0)
    }
    if (historySize == 0) return 0;

    return sum / historySize;
}
