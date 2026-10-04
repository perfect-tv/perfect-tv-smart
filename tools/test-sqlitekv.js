'use strict';
var assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
var temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sqlite-'));
process.env.PERFECTTV_DATA_DIR = temp;
var sql = require('../service/sqlitekv');
function run(op, q) { return new Promise(function(resolve, reject) { sql.dispatch(op, q || {}, function (e, v) { if(e) reject(e); else resolve(v); }); }); }
(async function () {
 var rows=[];
 for(var i=0;i<4000;i++) rows.push({key:['source'+Math.floor(i/200),'channel'+i,1,0],value:{s:'source',x:'channel'+i,l:1,n:0,codec:'gzip-json-1',data:Array(150).join(String(i%10))}});
 rows.push({key:['source0','large',1,0],value:{body:Array(27000).join('X')}});
 rows.push({key:['source0','huge',1,0],value:{body:Array(100000).join('Y')}});
 for(var j=0;j<rows.length;j+=100) await run('put',{store:'prog',items:rows.slice(j,j+100)});
 await run('put',{store:'playlists',items:[{key:1,value:{name:'Тест 🇷🇺'}},{key:2,value:{name:'Второй'}}]});
 assert.strictEqual((await run('get',{store:'playlists',key:1})).record.value.name,'Тест 🇷🇺');
 assert.strictEqual((await run('get',{store:'prog',key:['source0','large',1,0]})).record.value.body.length,26999);
 var listed=[],off=0,next;
 do { var r=await run('list',{store:'prog',offset:off,limit:100,range:{lower:['source0'],upper:['source0',[]]}});listed=listed.concat(r.records);next=r.next;off=next; }while(next!==null);
 assert.strictEqual(listed.length,202);
 await run('deleteRange',{store:'prog',range:{lower:['source19'],upper:['source19',[]]}});
 assert.strictEqual((await run('get',{store:'prog',key:['source19','channel3999',1,0]})).record,null);
 var b=fs.readFileSync(sql.path);var restored=sql.parseSqlite(b);
 console.log('sqlite file',b.length,'records',restored.length,'persisted',sql.path);
 assert.strictEqual(restored.length,3804);
 var p=cp.spawnSync('python3',['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('PRAGMA integrity_check').fetchone());print(c.execute('select count(*) from kv').fetchone()); print(c.execute(\"select v from kv where s='playlists' limit 1\").fetchone()[0][:100])",sql.path],{encoding:'utf8'});
 console.log(p.stdout,p.stderr);
 assert.strictEqual(p.status,0);assert(p.stdout.indexOf("('ok',)")>=0);
 console.log('OK sqlite tests');
})().catch(function(e){console.error(e.stack);process.exitCode=1;});
