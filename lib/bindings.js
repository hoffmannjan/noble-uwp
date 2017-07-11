'use strict';

// Noble bindings for Windows UWP BLE APIs

var events = require('events');
var util = require('util');
var debug = require('debug')('noble-uwp');
var rt = require('./rt-utils');

// Note the load order here is important for cross-namespace dependencies.
rt.using('Windows.Foundation');
rt.using('Windows.Storage.Streams');
rt.using('Windows.Devices.Enumeration');
rt.using('Windows.Devices.Bluetooth.GenericAttributeProfile');
rt.using('Windows.Devices.Bluetooth');
rt.using('Windows.Devices.Bluetooth.Advertisement');
rt.using('Windows.Devices.Radios');

var BluetoothLEDevice = Windows.Devices.Bluetooth.BluetoothLEDevice;
var BluetoothCacheMode = Windows.Devices.Bluetooth.BluetoothCacheMode;

var BluetoothLEAdvertisementWatcher = Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher;
var BluetoothLEScanningMode = Windows.Devices.Bluetooth.Advertisement.BluetoothLEScanningMode;
var BluetoothLEAdvertisementType = Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementType;
var BluetoothLEAdvertisementDataTypes = Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementDataTypes;
var BluetoothLEAdvertisementWatcherStatus = Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcherStatus;

var GattCharacteristicProperties = Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties;
var GattDeviceService = Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceService;
var GattServiceUuids = Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceUuids;
var GattCommunicationStatus = Windows.Devices.Bluetooth.GenericAttributeProfile.GattCommunicationStatus;
var GattClientCharacteristicConfigurationDescriptorValue = Windows.Devices.Bluetooth.GenericAttributeProfile.GattClientCharacteristicConfigurationDescriptorValue;

var Radio = Windows.Devices.Radios.Radio;
var RadioKind = Windows.Devices.Radios.RadioKind;
var RadioState = Windows.Devices.Radios.RadioState;

var DataReader = Windows.Storage.Streams.DataReader;

var NobleBindings = function NobleBindings() {
	this._radio = null;
	this._radioState = 'unknown';
	this._deviceMap = {};
	this._listenerMap = {};
};

util.inherits(NobleBindings, events.EventEmitter);

NobleBindings.prototype.init = function () {
	var _this = this;

	this._advertisementWatcher = new BluetoothLEAdvertisementWatcher();
	this._advertisementWatcher.scanningMode = BluetoothLEScanningMode.active;
	this._advertisementWatcher.on('received', this._onAdvertisementWatcherReceived.bind(this));
	this._advertisementWatcher.on('stopped', this._onAdvertisementWatcherStopped.bind(this));

	debug('initialized');

	rt.promisify(Radio.getRadiosAsync)().then(function (radiosList) {
		radiosList = rt.toArray(radiosList);
		_this._radio = radiosList.find(function (radio) {
			return radio.kind === RadioKind.bluetooth;
		});
		if (_this._radio) {
			debug('found bluetooth radio: %s', _this._radio.name);
		} else {
			debug('no bluetooth radio found');
		}
		_this._updateRadioState();
	}).catch(function (ex) {
		debug('failed to get radios: %s', ex.stack);
		_this._updateRadioState();
	});
};

NobleBindings.prototype.startScanning = function (serviceUuids, allowDuplicates) {
	if (this._advertisementWatcher.status !== BluetoothLEAdvertisementWatcherStatus.started) {
		allowDuplicates = !!allowDuplicates;
		debug('startScanning(%s, %s)', serviceUuids ? serviceUuids.join() : '', allowDuplicates);
		this._advertisementWatcher.start();
		rt.keepAlive(true);
	}
};

NobleBindings.prototype.stopScanning = function () {
	if (this._advertisementWatcher.status === BluetoothLEAdvertisementWatcherStatus.started) {
		debug('stopScanning()');
		this._advertisementWatcher.stop();
		rt.keepAlive(false);
	}
};

NobleBindings.prototype.connect = function (deviceUuid) {
	var _this2 = this;

	debug('connect(%s)', deviceUuid);

	var deviceRecord = this._deviceMap[deviceUuid];
	if (!deviceRecord) {
		throw new Error('Invalid or unknown device UUID: ' + deviceUuid);
	}

	if (!deviceRecord.connectable) {
		throw new Error("Device is not connectable: " + deviceRecord.formattedAddress);
	}

	rt.promisify(BluetoothLEDevice.fromBluetoothAddressAsync)(deviceRecord.address).then(function (device) {
		debug('got bluetooth device: %s (%s)', device.name, device.deviceInformation.kind);
		deviceRecord.device = rt.trackDisposable(deviceUuid, device);

		_this2.emit('connect', deviceUuid, null);
	}).catch(function (ex) {
		debug('failed to get device %s: %s', deviceRecord.formattedAddress, ex.stack);
		_this2.emit('connect', deviceUuid, ex);
	});
};

NobleBindings.prototype.disconnect = function (deviceUuid) {
	debug('disconnect(%s)', deviceUuid);

	var deviceRecord = this._deviceMap[deviceUuid];
	if (!deviceRecord) {
		throw new Error('Invalid or unknown device UUID: ' + deviceUuid);
	}

	if (deviceRecord.device) {
		deviceRecord.device = null;
		deviceRecord.serviceMap = {};
		deviceRecord.characteristicMap = {};
		deviceRecord.descriptorMap = {};

		rt.disposeAll(deviceUuid);

		this.emit('disconnect', deviceUuid);
	}
};

NobleBindings.prototype.updateRssi = function (deviceUuid) {
	debug('updateRssi(%s)', deviceUuid);

	// TODO: Retrieve updated RSSI
	var rssi = 0;

	this.emit('rssiUpdate', deviceUuid, rssi);
};

NobleBindings.prototype.discoverServices = function (deviceUuid, filterServiceUuids) {
	var _this3 = this;

	if (filterServiceUuids && filterServiceUuids.length === 0) {
		filterServiceUuids = null;
	}

	debug('discoverServices(%s, %s)', deviceUuid, filterServiceUuids ? filterServiceUuids.join() : '(all)');

	var deviceRecord = this._deviceMap[deviceUuid];
	if (!deviceRecord) {
		throw new Error('Invalid or unknown device UUID: ' + deviceUuid);
	}

	var device = deviceRecord.device;
	if (!device) {
		throw new Error('Device is not connected. UUID: ' + deviceUuid);
	}

	rt.promisify(device.getGattServicesAsync, device)(BluetoothCacheMode.uncached).then(function (result) {
		checkCommunicationResult(deviceUuid, result);

		var services = rt.trackDisposables(deviceUuid, rt.toArray(result.services));
		var serviceUuids = services.map(function (s) {
			return formatUuid(s.uuid);
		}).filter(filterUuids(filterServiceUuids));

		debug(deviceUuid + ' services: %o', serviceUuids);
		_this3.emit('servicesDiscover', deviceUuid, serviceUuids);
	}).catch(function (ex) {
		debug('failed to get GATT services for device %s: %s', deviceUuid, ex.stack);
		_this3.emit('servicesDiscover', deviceUuid, ex);
	});
};

NobleBindings.prototype.discoverIncludedServices = function (deviceUuid, serviceUuid, filterServiceUuids) {
	var _this4 = this;

	if (filterServiceUuids && filterServiceUuids.length === 0) {
		filterServiceUuids = null;
	}

	debug('discoverIncludedServices(%s, %s, %s)', deviceUuid, serviceUuid, filterServiceUuids ? filterServiceUuids.join() : '(all)');

	this._getCachedServiceAsync(deviceUuid, serviceUuid).then(function (service) {
		rt.promisify(service.getIncludedServicesAsync, service)(BluetoothCacheMode.uncached).then(function (result) {
			checkCommunicationResult(deviceUuid, result);

			var includedServices = rt.trackDisposables(deviceUuid, rt.toArray(result.services));
			var includedServiceUuids = includedServices.map(function (s) {
				return formatUuid(s.uuid);
			}).filter(filterUuids(filterServiceUuids));

			debug(deviceUuid + ' ' + serviceUuid + ' included services: ' + includedServiceUuids);
			_this4.emit('includedServicesDiscover', deviceUuid, serviceUuid, includedServiceUuids);
		});
	}).catch(function (ex) {
		debug('failed to get GATT included services for device %s: %s', deviceUuid, +ex.stack);
		_this4.emit('includedServicesDiscover', deviceUuid, serviceUuid, ex);
	});
};

NobleBindings.prototype.discoverCharacteristics = function (deviceUuid, serviceUuid, filterCharacteristicUuids) {
	var _this5 = this;

	if (filterCharacteristicUuids && filterCharacteristicUuids.length === 0) {
		filterCharacteristicUuids = null;
	}

	debug('discoverCharacteristics(%s, %s, %s', deviceUuid, serviceUuid, filterCharacteristicUuids ? filterCharacteristicUuids.join() : '(all)');

	this._getCachedServiceAsync(deviceUuid, serviceUuid).then(function (service) {
		return rt.promisify(service.getCharacteristicsAsync, service)(BluetoothCacheMode.uncached).then(function (result) {
			checkCommunicationResult(deviceUuid, result);

			var characteristics = rt.toArray(result.characteristics).filter(function (c) {
				return filterUuids(filterCharacteristicUuids)(formatUuid(c.uuid));
			}).map(function (c) {
				return {
					uuid: formatUuid(c.uuid),
					properties: characteristicPropertiesToStrings(c.characteristicProperties)
				};
			});

			debug('%s %s characteristics: %o', deviceUuid, serviceUuid, characteristics.map(function (c) {
				return c.uuid;
			}));
			_this5.emit('characteristicsDiscover', deviceUuid, serviceUuid, characteristics);
		});
	}).catch(function (ex) {
		debug('failed to get GATT characteristics for device %s: %s', deviceUuid, ex.stack);
		_this5.emit('characteristicsDiscover', deviceUuid, serviceUuid, ex);
	});
};

NobleBindings.prototype.read = function (deviceUuid, serviceUuid, characteristicUuid) {
	var _this6 = this;

	debug('read(%s, %s, %s)', deviceUuid, serviceUuid, characteristicUuid);

	this._getCachedCharacteristicAsync(deviceUuid, serviceUuid, characteristicUuid).then(function (characteristic) {
		return rt.promisify(characteristic.readValueAsync, characteristic)().then(function (result) {
			checkCommunicationResult(deviceUuid, result);
			var data = rt.toBuffer(result.value);

			debug('  => [' + data.length + ']');
			_this6.emit('read', deviceUuid, serviceUuid, characteristicUuid, data, false);
		});
	}).catch(function (ex) {
		debug('failed to read characteristic for device %s: %s', deviceUuid, ex.stack);
		_this6.emit('read', deviceUuid, serviceUuid, characteristicUuid, ex, false);
	});
};

NobleBindings.prototype.write = function (deviceUuid, serviceUuid, characteristicUuid, data, withoutResponse) {
	var _this7 = this;

	debug('write(%s, %s, %s, (data), %s)', deviceUuid, serviceUuid, characteristicUuid, withoutResponse);

	this._getCachedCharacteristicAsync(deviceUuid, serviceUuid, characteristicUuid).then(function (characteristic) {
		var rtBuffer = rt.fromBuffer(data);
		return rt.promisify(characteristic.writeValueWithResultAsync, characteristic)(rtBuffer).then(function (result) {
			checkCommunicationResult(deviceUuid, result);
			_this7.emit('write', deviceUuid, serviceUuid, characteristicUuid);
		});
	}).catch(function (ex) {
		debug('failed to write characteristic for device %s: %s', deviceUuid, ex.stack);
		if (!withoutResponse) {
			_this7.emit('write', deviceUuid, serviceUuid, characteristicUuid, ex);
		}
	});
};

NobleBindings.prototype.broadcast = function (deviceUuid, serviceUuid, characteristicUuid, broadcast) {
	debug('broadcast(%s, %s, %s, %s)', deviceUuid, serviceUuid, +characteristicUuid, broadcast);

	this.emit('broadcast', deviceUuid, serviceUuid, characteristicUuid, new Error('Not implemented'));
};

NobleBindings.prototype.notify = function (deviceUuid, serviceUuid, characteristicUuid, notify) {
	var _this8 = this;

	debug('notify(%s, %s, %s, %s)', deviceUuid, serviceUuid, characteristicUuid, notify);

	this._getCachedCharacteristicAsync(deviceUuid, serviceUuid, characteristicUuid).then(function (characteristic) {
		var listenerKey = deviceUuid + '/' + serviceUuid + '/' + characteristicUuid;
		var listener = _this8._listenerMap[listenerKey];

		if (notify) {
			if (listener) {
				// Already listening.
				_this8.emit('notify', deviceUuid, serviceUuid, characteristicUuid, notify);
				return;
			}

			return rt.promisify(characteristic.writeClientCharacteristicConfigurationDescriptorWithResultAsync, characteristic)(GattClientCharacteristicConfigurationDescriptorValue.notify).then(function (result) {
				checkCommunicationResult(deviceUuid, result);

				listener = function (source, e) {
					debug('notification: %s %s %s', deviceUuid, serviceUuid, characteristicUuid);
					var data = rt.toBuffer(e.characteristicValue);
					_this8.emit('read', deviceUuid, serviceUuid, characteristicUuid, data, true);
				}.bind(_this8);

				characteristic.addListener('valueChanged', listener);
				_this8._listenerMap[listenerKey] = listener;
				rt.keepAlive(true);
				_this8.emit('notify', deviceUuid, serviceUuid, characteristicUuid, notify);
			});
		} else {
			if (!listener) {
				// Already not listening.
				_this8.emit('notify', deviceUuid, serviceUuid, characteristicUuid, notify);
				return;
			}

			rt.keepAlive(false);
			characteristic.removeListener('valueChanged', listener);
			delete _this8._listenerMap[listenerKey];

			return rt.promisify(characteristic.writeClientCharacteristicConfigurationDescriptorWithResultAsync, characteristic)(GattClientCharacteristicConfigurationDescriptorValue.none).then(function (result) {
				checkCommunicationResult(deviceUuid, result);

				_this8.emit('notify', deviceUuid, serviceUuid, characteristicUuid, notify);
			});
		}
	}).catch(function (ex) {
		debug('failed to enable characteristic notify for device %s: %s', deviceUuid, ex.stack);
		_this8.emit('notify', deviceUuid, serviceUuid, characteristicUuid, ex);
	});
};

NobleBindings.prototype.discoverDescriptors = function (deviceUuid, serviceUuid, characteristicUuid) {
	var _this9 = this;

	debug('discoverDescriptors(%s, %s, %s)', deviceUuid, serviceUuid, characteristicUuid);

	this._getCachedCharacteristicAsync(deviceUuid, serviceUuid, characteristicUuid).then(function (characteristic) {
		return rt.promisify(characteristic.getDescriptorsAsync, characteristic)(BluetoothCacheMode.uncached).then(function (result) {
			checkCommunicationResult(deviceUuid, result);

			var descriptors = rt.toArray(result.descriptors).map(function (d) {
				return d.uuid;
			});
			_this9.emit('descriptorsDiscover', deviceUuid, serviceUuid, characteristicUuid, descriptors);
		});
	}).catch(function (ex) {
		debug('failed to get GATT characteristic descriptors for device %s: %s', deviceUuid, ex.stack);
		_this9.emit('descriptorsDiscover', deviceUuid, serviceUuid, characteristicUuid, ex);
	});
};

NobleBindings.prototype.readValue = function (deviceUuid, serviceUuid, characteristicUuid, descriptorUuid) {
	var _this10 = this;

	debug('readValue(%s, %s, %s, %s)', deviceUuid, serviceUuid, characteristicUuid, descriptorUuid);

	return this._getCachedDescriptorAsync(deviceUuid, serviceUuid, characteristicUuid, descriptorUuid).then(function (descriptor) {
		return rt.promisify(descriptor.readValueAsync, descriptor)(BluetoothCacheMode.uncached).then(function (result) {
			checkCommunicationResult(deviceUuid, result);
			var data = rt.toBuffer(result.value);

			debug('  => [' + data.length + ']');
			_this10.emit('readValue', deviceUuid, serviceUuid, characteristicUuid, descriptorUuid, data);
		});
	}).catch(function (ex) {
		debug('failed to read GATT characteristic descriptor values for device %s: %s', deviceUuid, ex.stack);
		_this10.emit('readValue', deviceUuid, serviceUuid, characteristicUuid, descriptorUuid, ex);
	});
};

NobleBindings.prototype.writeValue = function (deviceUuid, serviceUuid, characteristicUuid, descriptorUuid, data) {
	var _this11 = this;

	debug('writeValue(%s, %s, %s, %s, (data))', deviceUuid, serviceUuid, characteristicUuid, descriptorUuid);

	this._getCachedDescriptorAsync(deviceUuid, serviceUuid, characteristicUuid, descriptorUuid).then(function (descriptor) {
		var rtBuffer = rt.fromBuffer(data);
		return rt.promisify(descriptor.writeValueWithResultAsync, descriptor)(rtBuffer).then(function (result) {
			checkCommunicationResult(deviceUuid, result);
			_this11.emit('writeValue', deviceUuid, serviceUuid, characteristicUuid, descriptorUuid);
		});
	}).catch(function (ex) {
		debug('failed to write characteristic descriptor for device %s: %s', deviceUuid, ex.stack);
		if (!withoutResponse) {
			_this11.emit('writeValue', deviceUuid, serviceUuid, characteristicUuid, descriptorUuid, ex);
		}
	});
};

NobleBindings.prototype.readHandle = function (deviceUuid, handle) {
	this.emit('readHandle', deviceUuid, handle, new Error('Not supported'));
};

NobleBindings.prototype.writeHandle = function (deviceUuid, handle, data, withoutResponse) {
	if (!withoutResponse) {
		this.emit('writeHandle', deviceUuid, handle, new Error('Not supported'));
	}
};

NobleBindings.prototype._updateRadioState = function () {
	var state = void 0;

	if (!this._radio) {
		state = 'unsupported';
	} else switch (this._radio.state) {
		case RadioState.on:
			debug('bluetooth radio is on');
			state = 'poweredOn';
			break;
		case RadioState.off:
			debug('bluetooth radio is off');
			state = 'poweredOff';
			break;
		case RadioState.disabled:
			debug('bluetooth radio is disabled');
			state = 'poweredOff';
			break;
		default:
			debug('bluetooth radio is in unknown state: ' + this._bluetoothRadio.state);
			state = 'unknown';
			break;
	}

	if (state != this._radioState) {
		this._radioState = state;
		this.emit('stateChange', state);
	}
};

NobleBindings.prototype._onAdvertisementWatcherReceived = function (sender, e) {
	var address = formatBluetoothAddress(e.bluetoothAddress);
	debug('watcher received: %s %s', address, e.advertisement.localName);

	// Random addresses have the two most-significant bits set of the 48-bit address.
	var addressType = e.bluetoothAddress >= 3 * Math.pow(2, 46) ? 'random' : 'public';
	debug('    address type: %s', addressType);

	var deviceUuid = address.replace(/:/g, '');
	var rssi = e.rawSignalStrengthInDBm;

	debug('    advertisement type: %s', getEnumName(BluetoothLEAdvertisementType, e.advertisementType));

	var connectable = void 0;
	switch (e.advertisementType) {
		case BluetoothLEAdvertisementType.connectableUndirected:
		case BluetoothLEAdvertisementType.connectableDirected:
			connectable = true;
			break;
		case BluetoothLEAdvertisementType.nonConnectableUndirected:
		case BluetoothLEAdvertisementType.scannableUndirected:
			connectable = false;
			break;
		default:
			connectable = undefined;
			break;
	}

	var dataSections = rt.toArray(e.advertisement.dataSections);
	dataSections.forEach(function (dataSection) {
		debug('    data section: %s', getEnumName(BluetoothLEAdvertisementDataTypes, dataSection.dataType) || dataSection.dataType);
	});

	debug('    flags: %s', e.advertisement.flags);

	var txPowerLevel = null;
	var txPowerDataSection = dataSections.find(function (ds) {
		return ds.dataType === BluetoothLEAdvertisementDataTypes.txPowerLevel;
	});
	if (txPowerDataSection) {
		var dataReader = DataReader.fromBuffer(txPowerDataSection.data);
		txPowerLevel = dataReader.readByte();
		if (txPowerLevel >= 128) txPowerLevel -= 256;
		dataReader.close();
	}

	var deviceRecord = this._deviceMap[deviceUuid];
	if (!deviceRecord) {
		deviceRecord = {
			name: null,
			address: e.bluetoothAddress,
			formattedAddress: address,
			addressType: addressType,
			connectable: connectable,
			serviceUuids: [],
			txPowerLevel: null,
			device: null,
			serviceMap: {},
			characteristicMap: {},
			descriptorMap: {}
		};
		this._deviceMap[deviceUuid] = deviceRecord;
	}

	if (e.advertisement.localName) {
		deviceRecord.name = e.advertisement.localName;
	}

	var manufacturerSections = e.advertisement.manufacturerData;
	if (manufacturerSections.size > 0) {
		var manufacturerData = manufacturerSections[0];
		deviceRecord.manufacturerData = rt.toBuffer(manufacturerData.data);
		var companyIdHex = manufacturerData.companyId.toString(16);
		var toAppend = new Buffer(2);
		toAppend.writeUInt16LE(manufacturerData.companyId);
		deviceRecord.manufacturerData = Buffer.concat([toAppend, deviceRecord.manufacturerData]);
		debug('    manufacturer data: %s', deviceRecord.manufacturerData.toString('hex'));
	}

	var serviceUuids = rt.toArray(e.advertisement.serviceUuids);
	serviceUuids.forEach(function (serviceUuid) {
		debug('    service UUID: %s', getEnumName(GattServiceUuids, serviceUuid) || serviceUuid);
		if (deviceRecord.serviceUuids.indexOf(serviceUuid) < 0) {
			deviceRecord.serviceUuids.push(serviceUuid);
		}
	});

	if (txPowerLevel) {
		deviceRecord.txPowerLevel = txPowerLevel;
	}

	// Wait until the response to the active query before emitting a 'discover' event.
	if (e.advertisementType == BluetoothLEAdvertisementType.scanResponse) {
		var advertisement = {
			localName: deviceRecord.name,
			txPowerLevel: deviceRecord.txPowerLevel,
			manufacturerData: deviceRecord.manufacturerData, // TODO: manufacturerData
			serviceUuids: deviceRecord.serviceUuids,
			serviceData: [] // TODO: serviceData
		};

		this.emit('discover', deviceUuid, address, deviceRecord.addressType, deviceRecord.connectable, advertisement, rssi);
	}
};

NobleBindings.prototype._onAdvertisementWatcherStopped = function (sender, e) {
	if (this._advertisementWatcher.status === BluetoothLEAdvertisementWatcherStatus.aborted) {
		debug('watcher aborted');
	} else if (this._advertisementWatcher.status === BluetoothLEAdvertisementWatcherStatus.stopped) {
		debug('watcher stopped');
	} else {
		debug('watcher stopped with unexpected status: %s', this._advertisementWatcher.status);
	}
};

NobleBindings.prototype._getCachedServiceAsync = function (deviceUuid, serviceUuid) {
	var deviceRecord = this._deviceMap[deviceUuid];
	if (!deviceRecord) {
		throw new Error('Invalid or unknown device UUID: ' + deviceUuid);
	}

	var service = deviceRecord.serviceMap[serviceUuid];
	if (service) {
		return Promise.resolve(service);
	}

	var device = deviceRecord.device;
	if (!device) {
		throw new Error('Device is not connected. UUID: ' + deviceUuid);
	}

	return rt.promisify(device.getGattServicesAsync, device)(BluetoothCacheMode.cached).then(function (result) {
		checkCommunicationResult(deviceUuid, result);
		service = rt.trackDisposables(deviceUuid, rt.toArray(result.services)).find(function (s) {
			return formatUuid(s.uuid) === serviceUuid;
		});
		if (!service) {
			throw new Error('Service ' + serviceUuid + ' not found for device ' + deviceUuid);
		}
		deviceRecord.serviceMap[serviceUuid] = service;
		return service;
	});
};

NobleBindings.prototype._getCachedCharacteristicAsync = function (deviceUuid, serviceUuid, characteristicUuid) {
	var deviceRecord = this._deviceMap[deviceUuid];
	if (!deviceRecord) {
		throw new Error('Invalid or unknown device UUID: ' + deviceUuid);
	}

	var characteristicKey = serviceUuid + '/' + characteristicUuid;
	var characteristic = deviceRecord.characteristicMap[characteristicKey];
	if (characteristic) {
		return Promise.resolve(characteristic);
	}

	return this._getCachedServiceAsync(deviceUuid, serviceUuid).then(function (service) {
		return rt.promisify(service.getCharacteristicsAsync, service)(BluetoothCacheMode.cached).then(function (result) {
			checkCommunicationResult(deviceUuid, result);
			characteristic = rt.toArray(result.characteristics).find(function (c) {
				return formatUuid(c.uuid) === characteristicUuid;
			});
			if (!characteristic) {
				throw new Error('Service ' + serviceUuid + ' characteristic ' + characteristicUuid + ' not found for device ' + deviceUuid);
			}
			deviceRecord.characteristicMap[characteristicKey] = characteristic;
			return characteristic;
		});
	});
};

NobleBindings.prototype._getCachedDescriptorAsync = function (deviceUuid, serviceUuid, characteristicUuid, descriptorUuid) {
	var deviceRecord = this._deviceMap[deviceUuid];
	if (!deviceRecord) {
		throw new Error('Invalid or unknown device UUID: ' + deviceUuid);
	}

	var descriptorKey = serviceUuid + '/' + characteristicUuid + '/' + descriptorUuid;
	var descriptor = deviceRecord.descriptorMap[descriptorKey];
	if (descriptor) {
		return Promise.resolve(descriptor);
	}

	return this._getCachedCharacteristicAsync(deviceUuid, serviceUuid, characteristicUuid).then(function (service) {
		return rt.promisify(characteristic.getDescriptorsAsync, characteristic)(BluetoothCacheMode.cached).then(function (result) {
			checkCommunicationResult(deviceUuid, result);
			descriptor = rt.toArray(result.descriptors).find(function (d) {
				return formatUuid(d.uuid) === descriptorUuid;
			});
			if (!descriptor) {
				throw new Error('Service ' + serviceUuid + ' characteristic ' + characteristicUuid + ' descriptor ' + descriptorUuid + ' not found for device ' + deviceUuid);
			}
			deviceRecord.descriptorMap[descriptorKey] = descriptor;
			return descriptor;
		});
	});
};

function formatBluetoothAddress(address) {
	if (!address) {
		return 'null';
	}

	var formattedAddress = address.toString(16);
	while (formattedAddress.length < 12) {
		formattedAddress = '0' + formattedAddress;
	}
	formattedAddress = formattedAddress.substr(0, 2) + ':' + formattedAddress.substr(2, 2) + ':' + formattedAddress.substr(4, 2) + ':' + formattedAddress.substr(6, 2) + ':' + formattedAddress.substr(8, 2) + ':' + formattedAddress.substr(10, 2);
	return formattedAddress;
}

function characteristicPropertiesToStrings(props) {
	var strings = [];

	if (props & GattCharacteristicProperties.broadcast) {
		strings.push('broadcast');
	}

	if (props & GattCharacteristicProperties.read) {
		strings.push('read');
	}

	if (props & GattCharacteristicProperties.writeWithoutResponse) {
		strings.push('writeWithoutResponse');
	}

	if (props & GattCharacteristicProperties.write) {
		strings.push('write');
	}

	if (props & GattCharacteristicProperties.notify) {
		strings.push('notify');
	}

	if (props & GattCharacteristicProperties.indicate) {
		strings.push('indicate');
	}

	if (props & GattCharacteristicProperties.broadcast) {
		strings.push('authenticatedSignedWrites');
	}

	if (props & GattCharacteristicProperties.extendedProperties) {
		strings.push('extendedProperties');
	}

	return strings;
}

function getEnumName(enumType, value) {
	return Object.keys(enumType).find(function (enumName) {
		return value === enumType[enumName];
	});
}

function formatUuid(uuid) {
	if (!uuid) {
		return uuid;
	} else if (/{0000[0-9A-F]{4}-0000-1000-8000-00805F9B34FB}/i.test(uuid)) {
		return uuid.substr(5, 4).toLowerCase();
	} else {
		return uuid.replace(/[-{}]/g, '').toLowerCase();
	}
}

function filterUuids(filter) {
	return function (uuid) {
		return !filter || filter.indexOf(uuid) != -1;
	};
}

function checkCommunicationResult(deviceUuid, result) {
	if (result.status === GattCommunicationStatus.unreachable) {
		throw new Error('Device unreachable: ' + deviceUuid);
	} else if (result.status === GattCommunicationStatus.protocolError) {
		throw new Error('Protocol error communicating with device: ' + deviceUuid);
	}
}

module.exports = new NobleBindings();