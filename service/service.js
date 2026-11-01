/*
 * JS-сервис webOS. Локальный прокси слушает 127.0.0.1:47380 и работает, пока живо
 * подписанное приложение. Телефонный веб-сервер :47381 открывается лишь на время QR-ввода.
 * ES5 для Node.js старых webOS.
 */
'use strict';
var Service = require('webos-service');
var proxy = require('./proxy.js');
var stream = require('./luna-stream.js');
var service = new Service('top.rootu.perfecttv.service');
var subs = {};
var subCount = 0;
var keepAlive = null;
var activityPending = false;
var proxyReady = false;
var proxyError = '';

function releaseActivity(activity) {
  if (!activity) return;
  try { service.activityManager.complete(activity, function () { /* */ }); }
  catch (e) { console.error('complete activity', e); }
}

function hold() {
  if (keepAlive || activityPending || subCount === 0) return;
  activityPending = true;
  try {
    service.activityManager.create('keepAlive', function (activity) {
      activityPending = false;
      if (subCount > 0) keepAlive = activity;
      else releaseActivity(activity); // подписка могла завершиться, пока создавали Activity
    });
  } catch (e) {
    activityPending = false;
    console.error('create keepAlive', e);
  }
}

function release() {
  if (keepAlive) { releaseActivity(keepAlive); keepAlive = null; }
}

service.register('start', function (message) {
  console.log('Perfect TV proxy: start request');
  // UA браузера ТВ — для запросов, которые сервис делает сам (тот же, что у прямых запросов)
  if (message.payload && message.payload.ua) proxy.setUserAgent(message.payload.ua);
  // Важно: веб-приложение подписано на Luna, даже если Node на телевизоре не
  // имеет права слушать TCP-порт. Сервис обязан остаться живым для /stream*.
  if (message.isSubscription && !subs[message.uniqueToken]) {
    subs[message.uniqueToken] = message;
    subCount++;
    hold();
  }
  proxy.start(proxy.PORT, function (err) {
    proxyReady = !err;
    proxyError = err ? String(err.message || err) : '';
    message.respond({
      returnValue: true,
      subscribed: !!message.isSubscription,
      proxyReady: proxyReady,
      port: proxy.PORT,
      proxyError: proxyError,
      node: process.versions && process.versions.node
    });
  });
}, function (message) {
  if (subs[message.uniqueToken]) { delete subs[message.uniqueToken]; subCount--; }
  if (subCount === 0) release();
});

service.register('ping', function (message) {
  message.respond({ returnValue: true, port: proxy.PORT, proxyReady: proxyReady,
    proxyError: proxyError, node: process.versions && process.versions.node, dataDir: require('./datadir.js') });
});

// Прямой транспорт данных через системную шину. Не требует HTTP-сервера на ТВ;
// в отличие от 127.0.0.1 работает и при запрете TCP bind().
service.register('streamOpen', function (message) {
  stream.open(message.payload || {}, function (result) { message.respond(result); });
});
service.register('streamRead', function (message) {
  stream.read(message.payload || {}, function (result) { message.respond(result); });
});
service.register('streamClose', function (message) {
  if (message.payload && message.payload.id) stream.close(message.payload.id);
  message.respond({ returnValue: true });
});
