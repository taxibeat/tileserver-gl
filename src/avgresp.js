#!/usr/bin/env node

'use strict';

module.exports = {avgresp: avgresp, getAverageResp: getAverageResp};


var history;
var samples;

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
        }

        samples[currentIndex] = time;
    }

    return function avgresp(req, res, next) {
        startTime = process.hrtime();

        onHeaders(res, function onHeaders() {
            var diff = process.hrtime(startTime);
            var time = diff[0] * 1e3 + diff[1] * 1e-6

            updateAverage(time);
        })
    }
}

function getAverageResp() {
    var sum = samples.reduce(function(total, val){
        return total + val;
    });

    var avg = sum/history;
}
