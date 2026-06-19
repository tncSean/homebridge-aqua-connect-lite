#!/usr/bin/env node
// Passive listener: connect, decode frames, print DISPLAY + LEDS for N seconds.
// node passive-listen.mjs [host] [seconds]
import net from 'node:net';
const HOST = process.argv[2] || '192.168.1.73', PORT = 8899;
const SECS = parseInt(process.argv[3] || '12', 10);
const DLE = 0x10, STX = 0x02, ETX = 0x03;
function unstuff(buf){const o=[];for(let i=0;i<buf.length;i++){o.push(buf[i]);if(buf[i]===DLE&&buf[i+1]===0x00)i++;}return Buffer.from(o);}
function csum(p){let s=DLE+STX;for(const b of p)s+=b;return s&0xffff;}
function decode(w){if(w.length<6||w[0]!==DLE||w[1]!==STX)return null;if(w[w.length-2]!==DLE||w[w.length-1]!==ETX)return null;const inner=unstuff(w.subarray(2,w.length-2));if(inner.length<2)return null;const p=inner.subarray(0,inner.length-2);const c=(inner[inner.length-2]<<8)|inner[inner.length-1];return c===csum(p)?p:null;}
let buf=Buffer.alloc(0);
function extract(chunk){buf=buf.length?Buffer.concat([buf,chunk]):chunk;const fr=[];while(true){let s=-1;for(let i=0;i<buf.length-1;i++){if(buf[i]===DLE&&buf[i+1]===STX){s=i;break;}}if(s<0){buf=Buffer.alloc(0);break;}if(s>0)buf=buf.subarray(s);let e=-1,i=2;while(i<buf.length-1){if(buf[i]===DLE){if(buf[i+1]===0x00){i+=2;continue;}if(buf[i+1]===ETX){e=i;break;}i+=1;}else i+=1;}if(e<0)break;fr.push(buf.subarray(0,e+2));buf=buf.subarray(e+2);}return fr;}
const sock=net.createConnection({host:HOST,port:PORT});
sock.setNoDelay(true);
const t0=Date.now();const ts=()=>`+${((Date.now()-t0)/1000).toFixed(1)}s`;
let ka=0,disp=0;
sock.on('connect',()=>console.log(`[${ts()}] connected ${HOST}:${PORT}`));
sock.on('data',chunk=>{for(const f of extract(chunk)){const p=decode(f);if(!p||p.length<2)continue;const t=(p[0]<<8)|p[1];const body=p.subarray(2);if(t===0x0101)ka++;if(t===0x0103||t===0x040a){disp++;const tx=[];for(const b of body)tx.push((b>=0x20&&b<=0x7e)?String.fromCharCode(b):(b===0xdf?'°':'.'));const clean=tx.join('').replace(/\.+/g,' ').trim();if(clean.length>2)console.log(`[${ts()}] DISPLAY "${clean}"`);}}});
sock.on('error',e=>console.log(`[${ts()}] ERR ${e.message}`));
setTimeout(()=>{console.log(`[${ts()}] done — ${ka} KEEP_ALIVE, ${disp} DISPLAY frames`);sock.destroy();process.exit(0);},SECS*1000);
