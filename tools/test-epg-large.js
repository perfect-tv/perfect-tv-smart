'use strict';
var fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),zlib=require('zlib');
process.env.PERFECTTV_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'pt-epg-large-'));
var epg=require('../service/epgservice');
var wanted=[],channels=[];
for(var i=0;i<800;i++)channels.push({key:'c'+i,tvgId:'c'+i,name:'Channel '+i,tvgName:''});
wanted.push({pid:1,channels:channels});
function xmltime(h){var d=new Date(Date.now()+h*3600000);function t(n){return (n<10?'0':'')+n;};return d.getUTCFullYear()+t(d.getUTCMonth()+1)+t(d.getUTCDate())+t(d.getUTCHours())+t(d.getUTCMinutes())+t(d.getUTCSeconds())+' +0000';}
var times=[];for(var j=0;j<120;j++)times.push([xmltime(j-80),xmltime(j-79)]);
var rows=['<?xml version="1.0"?><tv>'];
channels.forEach(function(c){rows.push('<channel id="'+c.tvgId+'"><display-name>'+c.name+'</display-name></channel>');});
channels.forEach(function(c){for(var j=0;j<120;j++)rows.push('<programme channel="'+c.tvgId+'" start="'+times[j][0]+'" stop="'+times[j][1]+'"><title lang="ru">Programme '+j+'</title><desc>Test text</desc></programme>');});
rows.push('</tv>');
var body=zlib.gzipSync(new Buffer(rows.join(''),'utf8'));
var server=http.createServer(function(req,res){res.setHeader('Content-Length',body.length);res.setHeader('Content-Type','application/x-gzip');res.end(body);});
server.listen(0,'127.0.0.1',function(){
  var url='http://127.0.0.1:'+server.address().port+'/epg.xml.gz';var begin=Date.now();
  epg.dispatch('epgStart',{url:url,wanted:wanted,maxArchiveDays:7,langs:['ru'],force:true},function(err,st){
    if(err)throw err;
    function poll(){epg.dispatch('epgStatus',{jobId:st.jobId},function(err,state){
      if(err)throw err;
      if(state.done){
        console.log('LARGE EPG',JSON.stringify({count:state.meta&&state.meta.count,status:state.meta&&state.meta.status,revision:state.revision,ms:Date.now()-begin,dbBytes:fs.statSync(path.join(process.env.PERFECTTV_DATA_DIR,'perfecttv.sqlite3')).size,path:process.env.PERFECTTV_DATA_DIR}));
        server.close();process.exit(state.meta.status===2&&state.meta.count===96000?0:1);
      }else setTimeout(poll,100);
    });}poll();
  });
});
