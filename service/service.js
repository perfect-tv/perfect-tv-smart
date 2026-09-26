/*
 * JS-сервис webOS: поднимает локальный прокси (proxy.js) и держится, пока приложение
 * подписано на метод start (подписка не даёт системе выгрузить сервис).
 */
'use strict';
var Service = require('webos-service');
var proxy = require('./proxy.js');
var service = new Service('top.rootu.perfecttv.service');
var subs = {};

service.register('start', function (message) {
  proxy.start(proxy.PORT, function (err) {
    message.respond({ returnValue: !err, port: proxy.PORT, error: err ? String(err.message || err) : undefined });
  });
  if (message.isSubscription) {
    subs[message.uniqueToken] = message;
  }
}, function (message) {
  delete subs[message.uniqueToken];
});

service.register('ping', function (message) {
  message.respond({ returnValue: true, port: proxy.PORT });
});
