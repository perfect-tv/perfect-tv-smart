'use strict';
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var zlib = require('zlib');
var root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-epg-node-'));
process.env.PERFECTTV_DATA_DIR = root;
// Exercise the TextDecoder shim used by Node 0.12 on older webOS.
global.TextDecoder = undefined;
var epg = require('../service/epgservice');
var sqlite = require('../service/filekv');
var day = new Date();
function xmlTime(delta) {
  var d = new Date(Date.now() + delta * 1000);
  function d2(n) { return n < 10 ? '0' + n : '' + n; }
  return d.getUTCFullYear() + d2(d.getUTCMonth()+1) + d2(d.getUTCDate()) + d2(d.getUTCHours()) + d2(d.getUTCMinutes()) + d2(d.getUTCSeconds()) + ' +0000';
}
var blocks = [];
for (var i = 0; i < 60; i++) {
  var delta = (i-25)*3600;
  blocks.push('<programme start="'+xmlTime(delta)+'" stop="'+xmlTime(delta+3600)+'" channel="tv1"><title lang="en">English '+i+'</title><title lang="ru">Test '+i+' &amp; more</title><desc lang="ru">Description '+i+'</desc></programme>');
}
for (var j=0; j<50; j++) blocks.push('<programme start="'+xmlTime(j*3600)+'" stop="'+xmlTime(j*3600+3600)+'" channel="unwanted"><title>No</title></programme>');
var text = '<?xml version="1.0" encoding="UTF-8"?><tv><channel id="tv1"><display-name>TV One</display-name><icon src="http://example.com/tv1.png"/></channel><channel id="unwanted"><display-name>TV Two</display-name></channel>'+blocks.join('')+'</tv>';
var zipped = zlib.gzipSync(new Buffer(text,'utf8'));
var zipPayload = zlib.deflateRawSync(new Buffer(text, 'utf8'));
var zipName = new Buffer('guide.xml');
var zipHeader = new Buffer(30); zipHeader.fill(0);
zipHeader.writeUInt32LE(0x04034b50, 0);
zipHeader.writeUInt16LE(20, 4);
zipHeader.writeUInt16LE(8, 8);
zipHeader.writeUInt32LE(zipPayload.length, 18);
zipHeader.writeUInt32LE(Buffer.byteLength(text, 'utf8'), 22);
zipHeader.writeUInt16LE(zipName.length, 26);
var zipFile = Buffer.concat([zipHeader, zipName, zipPayload, new Buffer('PK\x01\x02', 'binary')]);
var storedHeader = new Buffer(zipHeader); storedHeader.writeUInt16LE(0, 8);
storedHeader.writeUInt32LE(Buffer.byteLength(text, 'utf8'), 18);
var storedZip = Buffer.concat([storedHeader, zipName, new Buffer(text, 'utf8'), new Buffer('PK\x01\x02','binary')]);
var calls=0;
var server = http.createServer(function(req,res){
  calls++;
  if(req.url.indexOf('/empty') >= 0) {res.statusCode=200;return res.end();}
  if(req.url.indexOf('.zip') >= 0) {
    var archive = req.url.indexOf('stored') >= 0 ? storedZip : zipFile;
    res.writeHead(200, {'Content-Type':'application/zip'});
    for(var z=0;z<archive.length;z+=7) res.write(archive.slice(z,z+7));
    return res.end();
  }
  if(req.headers['if-none-match']==='"epgv1"') {res.statusCode=304;return res.end();}
  res.writeHead(200,{'Content-Type':'application/xml','Content-Length':zipped.length,'ETag':'"epgv1"'});
  // Test that streaming parser handles arbitrarily split gzip input.
  for(var p=0;p<zipped.length;p+=13)res.write(zipped.slice(p,p+13));
  res.end();
});
function call(op,q){return new Promise(function(resolve,reject){sqlite.dispatch(op,q,function(e,r){if(e)reject(e);else resolve(r);});});}
function svc(op,q){return new Promise(function(resolve,reject){epg.dispatch(op,q,function(e,r){if(e)reject(e);else resolve(r);});});}
function wait(id){return new Promise(function(resolve,reject){var polls=0;function step(){svc('epgStatus',{jobId:id}).then(function(s){if(s.done)resolve(s);else if(++polls>200)reject(new Error('timeout'));else setTimeout(step,50);},reject);}step();});}
var wanted=[{pid:1,channels:[{key:'channel_one',tvgId:'tv1',tvgName:'',name:'TV One'}]}];
server.listen(0,'127.0.0.1',async function(){
  try {
    var url='http://127.0.0.1:'+server.address().port+'/guide.xml.gz';
    var initial=await svc('epgStart',{url:url,wanted:wanted,maxArchiveDays:7,langs:['ru','en'],force:true});
    var status=await wait(initial.jobId);
    assert.strictEqual(status.meta.status,2,JSON.stringify(status));
    assert.strictEqual(status.meta.count,60);
    assert(status.revision>0);
    var maps=await call('get',{store:'map',key:[1,url]});
    assert.strictEqual(maps.record.value.m.channel_one[0],'tv1');
    var channels=await call('list',{store:'epgch',range:{lower:[url],upper:[url,[]]}});
    assert.strictEqual(channels.records.length,2);
    var packs=await call('list',{store:'prog',range:{lower:[url],upper:[url,[]]}});
    assert.strictEqual(packs.records.length,1);
    var pack=packs.records[0].value;
    // после загрузки канал собран в .json.gz: пачка — с готовым массивом p
    var unpacked=pack.p || JSON.parse(zlib.gunzipSync(new Buffer(pack.data,'base64')).toString('utf8'));
    assert.strictEqual(unpacked.length,60);
    assert.strictEqual(unpacked[0][2], 'Test 0 & more');
    assert.strictEqual(unpacked[0][3],'');
    assert.strictEqual(unpacked[0][4],'Description 0');
    var etag=await svc('epgStart',{url:url,wanted:[{pid:2,channels:wanted[0].channels}],maxArchiveDays:7,langs:['ru'],force:false});
    var status2=await wait(etag.jobId);
    assert.strictEqual(status2.meta.status,2,JSON.stringify(status2));
    assert.strictEqual(status2.meta.loadId,status.meta.loadId,'304 must not delete EPG');
    var newMap=await call('get',{store:'map',key:[2,url]});
    assert(newMap.record);
    await svc('epgRematch',{url:url,wanted:[{pid:3,channels:wanted[0].channels}]});
    var rematch=await call('get',{store:'map',key:[3,url]});
    assert(rematch.record);
    var zipUrl='http://127.0.0.1:'+server.address().port+'/guide.xml.zip';
    var zippedJob=await svc('epgStart',{url:zipUrl,wanted:wanted,maxArchiveDays:7,langs:['ru'],force:true});
    var zipState=await wait(zippedJob.jobId);
    assert.strictEqual(zipState.meta.status,2,'zip fallback: '+JSON.stringify(zipState));
    assert.strictEqual(zipState.meta.count,60);
    var storedUrl='http://127.0.0.1:'+server.address().port+'/stored.zip';
    var storedJob=await svc('epgStart',{url:storedUrl,wanted:wanted,maxArchiveDays:7,langs:['ru'],force:true});
    var storedState=await wait(storedJob.jobId);
    assert.strictEqual(storedState.meta.status,2,'stored ZIP: '+JSON.stringify(storedState));
    assert.strictEqual(storedState.meta.count,60);
    var emptyUrl='http://127.0.0.1:'+server.address().port+'/empty.xml';
    var emptyJob=await svc('epgStart',{url:emptyUrl,wanted:wanted,maxArchiveDays:7,langs:['ru'],force:true});
    var emptyState=await wait(emptyJob.jobId);
    assert.strictEqual(emptyState.meta.status,3,'empty response must fail without hanging');
    // The fallback TextDecoder in old Node decodes cp1251 titles.
    var XmltvParser = require('../service/epg-parser').XmltvParser;
    var decoded=[];
    var p1251 = new XmltvParser(['ru'],function(){},function(){},function(){return true;},function(p){decoded.push(p);});
    var cp1251 = Buffer.concat([new Buffer('<?xml version="1.0" encoding="windows-1251"?><tv><programme start="'+xmlTime(0)+'" stop="'+xmlTime(3600)+'" channel="cp"><title lang="ru">','ascii'), new Buffer([0xD2,0xC2]),new Buffer('</title></programme></tv>','ascii')]);
    p1251.push(cp1251);p1251.end();
    assert.strictEqual(decoded[0].title,'\u0422\u0412');
    // Exercise the real WebSocket protocol used by the TV application.
    var proxy = require('../service/proxy');
    await new Promise(function(resolve,reject){proxy.start(47380,function(err){err?reject(err):resolve();});});
    await new Promise(function(resolve,reject){
      var ws=new WebSocket('ws://127.0.0.1:47380/db');
      ws.onopen=function(){ws.send(JSON.stringify({id:9,op:'epgRematch',url:url,wanted:[{pid:9,channels:wanted[0].channels}]}));};
      ws.onmessage=function(event){
        try {var r=JSON.parse(event.data);assert.strictEqual(r.id,9);assert.strictEqual(r.ok,true);
          ws.close();resolve();}catch(e){ws.close();reject(e);}
      };
      ws.onerror=reject;
    });
    var wsMap=await call('get',{store:'map',key:[9,url]});
    assert(wsMap.record);
    console.log('PASS EPG Node service: gzip+deflate/stored zip, empty, cp1251, matching, 60 events, files, ETag 304, rematch+WebSocket', calls, 'requests');
    server.close();
    process.exit(0);
  } catch(e) { console.error('FAIL EPG service',e.stack||e);server.close();process.exit(1); }
});
