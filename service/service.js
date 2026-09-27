/*
 * JS-сервис webOS: поднимает локальный прокси (proxy.js). Система выгружает JS-сервис через
 * несколько секунд без запросов, поэтому, пока приложение подписано на start, сервис держит
 * активность keepAlive (activityManager, как в примерах LG); последняя подписка снята —
 * активность завершается, и сервис может выгрузиться.
 * Код — ES5 (на webOS 3 в сервисе Node 0.12).
 */
'use strict';
var Service = require('webos-service');
var proxy = require('./proxy.js');
var service = new Service('top.rootu.perfecttv.service');
var subs = {};
var subCount = 0;
var keepAlive = null;

function hold() {
  if (keepAlive) return;
  try {
    service.activityManager.create('keepAlive', function (activity) { keepAlive = activity; });
  } catch (e) {
    console.error('keepAlive', e);
  }
}

function release() {
  if (!keepAlive) return;
  try { service.activityManager.complete(keepAlive, function () { /* */ }); } catch (e) { /* */ }
  keepAlive = null;
}

service.register('start', function (message) {
  hold();
  proxy.start(proxy.PORT, function (err) {
    message.respond({
      returnValue: !err,
      subscribed: !!message.isSubscription,
      port: proxy.PORT,
      error: err ? String(err.message || err) : undefined
    });
  });
  if (message.isSubscription) {
    subs[message.uniqueToken] = message;
    subCount++;
  }
}, function (message) {
  if (subs[message.uniqueToken]) {
    delete subs[message.uniqueToken];
    subCount--;
  }
  if (subCount <= 0) release();
});

service.register('ping', function (message) {
  message.respond({ returnValue: true, port: proxy.PORT });
});
