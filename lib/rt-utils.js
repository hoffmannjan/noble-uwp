'use strict';

// Utility functions for working with NodeRT projections.

var Buffer = require('safe-buffer').Buffer
var debug = require('debug')('noble-uwp');

// Relative path to NodeRT-generaged UWP namespace modules.
var uwpRoot = '../uwp/';

// Require a NodeRt namespace package and load it into the global namespace.
function using(ns) {
	var nsParts = ns.split('.');
	var parentObj = global;

	// Build an object tree as necessary for the namespace hierarchy.
	for (var i = 0; i < nsParts.length - 1; i++) {
		var _nsObj = parentObj[nsParts[i]];
		if (!_nsObj) {
			_nsObj = {};
			parentObj[nsParts[i]] = _nsObj;
		}
		parentObj = _nsObj;
	}

	var lastNsPart = nsParts[nsParts.length - 1];
	var nsPackage = require(uwpRoot + ns.toLowerCase());

	// Merge in any already-loaded sub-namespaces.
	// This allows loading in non-hierarchical order.
	var nsObj = parentObj[lastNsPart];
	if (nsObj) {
		Object.keys(nsObj).forEach(function (key) {
			nsPackage[key] = nsObj[key];
		});
	}
	parentObj[lastNsPart] = nsPackage;
}

// Convert a NodeRT async method from callback to promise.
function promisify(fn, o) {
	return function () {
		for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
			args[_key] = arguments[_key];
		}

		return new Promise(function (resolve, reject) {
			(o ? fn.bind(o) : fn).apply(undefined, args.concat([function (err, result) {
				if (err) reject(err);else resolve(result);
			}]));
		});
	};
}

// Convert a WinRT IVectorView to a JS Array.
function toArray(o) {
	var a = new Array(o.length);
	for (var i = 0; i < a.length; i++) {
		a[i] = o[i];
	}
	return a;
}

// Convert a WinRT IMap to a JS Map.
function toMap(o) {
	var m = new Map();
	for (var i = o.first(); i.hasCurrent; i.moveNext()) {
		m.set(i.current.key, i.current.value);
	}
	return m;
}

// Convert a WinRT IBuffer to a JS Buffer.
function toBuffer(b) {
	// TODO: Use nodert-streams to more efficiently convert the buffer?
	var len = b.length;
	var DataReader = Windows.Storage.Streams.DataReader;
	var r = DataReader.fromBuffer(b);
	var a = new Uint8Array(len);
	for (var i = 0; i < len; i++) {
		a[i] = r.readByte();
	}
	return Buffer.from(a.buffer);
}

// Convert a JS Buffer to a WinRT IBuffer.
function fromBuffer(b) {
	// TODO: Use nodert-streams to more efficiently convert the buffer?
	var len = b.length;
	var DataWriter = Windows.Storage.Streams.DataWriter;
	var w = new DataWriter();
	for (var i = 0; i < len; i++) {
		w.writeByte(b[i]);
	}
	return w.detachBuffer();
}

var keepAliveIntervalId = 0;
var keepAliveIntervalCount = 0;

// Increment or decrement the count of WinRT async tasks.
// While the count is non-zero an interval is used to keep the JS engine alive.
function keepAlive(k) {
	if (k) {
		if (++keepAliveIntervalCount === 1) {
			// The actual duration doesn't really matter: it should be large but not too large.
			keepAliveIntervalId = setInterval(function () {}, 24 * 60 * 60 * 1000);
		}
	} else {
		if (--keepAliveIntervalCount === 0) {
			clearInterval(keepAliveIntervalId);
		}
	}
	debug('keepAlive(' + k + ') => ' + keepAliveIntervalCount);
}

var disposableMap = {};

function trackDisposable(key, obj) {
	if (!obj) {
		return obj;
	}

	if (typeof obj.close !== "function") {
		throw new Error('Object does not have a close function.');
	}

	var disposableList = disposableMap[key];

	if (!disposableList) {
		disposableList = [];
		disposableMap[key] = disposableList;
	}

	for (var i = 0; i < disposableList.length; i++) {
		var disposable = disposableList[i];
		if (Object.is(obj, disposable)) {
			return obj;
		}
	}

	disposableList.push(obj);
	return obj;
}

function trackDisposables(key, array) {
	array.forEach(function (obj) {
		return trackDisposable(key, obj);
	});
	return array;
}

function disposeAll(key) {
	var disposableList = disposableMap[key];

	if (!disposableList) {
		return;
	}

	debug('Disposing %d objects for %s', disposableList.length, key);

	for (var i = 0; i < disposableList.length; i++) {
		var disposable = disposableList[i];
		disposable.close();
	}
}

module.exports = {
	using: using,
	promisify: promisify,
	toArray: toArray,
	toMap: toMap,
	toBuffer: toBuffer,
	fromBuffer: fromBuffer,
	keepAlive: keepAlive,
	trackDisposable: trackDisposable,
	trackDisposables: trackDisposables,
	disposeAll: disposeAll
};
