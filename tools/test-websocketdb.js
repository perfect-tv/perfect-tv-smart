'use strict';
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ws-sqlite-'));
process.env.PERFECTTV_DATA_DIR=dir;
var proxy = require('../service/proxy');
proxy.start(47380, function(err){
  if(err) throw err;
  var ws = new WebSocket('ws://127.0.0.1:47380/db');
  var seq=0, pending={};
  function rpc(op,data){return new Promise(function(resolve,reject){
    var id=++seq;pending[id]={resolve:resolve,reject:reject};ws.send(JSON.stringify(Object.assign({id:id,op:op},data||{})));
  });}
  ws.onmessage=function(ev){var m=JSON.parse(ev.data), p=pending[m.id];if(!p)throw new Error('unmatched');delete pending[m.id];if(m.ok)p.resolve(m.result);else p.reject(new Error(m.error));};
  ws.onopen=async function(){try {
    console.log('status',await rpc('status'));
    await rpc('put',{store:'channels',items:[{key:1,value:{list:['Первый','Второй']}}]});
    await rpc('put',{store:'settings',items:[{key:'prefs',value:'{"fav":42}'}]});
    console.log('get',await rpc('get',{store:'channels',key:1}));
    assert.deepStrictEqual((await rpc('get',{store:'channels',key:1})).record.value.list,['Первый','Второй']);
    assert.strictEqual((await rpc('list',{store:'settings'})).records[0].value,'{"fav":42}');
    console.log('OK WS SQLite',fs.statSync(path.join(dir,'perfecttv.sqlite3')).size);
    ws.close();process.exit(0);
  }catch(e){console.error(e.stack);process.exit(1);}};
  ws.onerror=function(e){console.error(e);process.exit(1);};
});
