const fs=require('fs'),zlib=require('zlib')
function load(file){const b=fs.readFileSync(file);let off=8,idat=[],w=0,h=0,ct=0
while(off<b.length){const len=b.readUInt32BE(off);const type=b.toString('ascii',off+4,off+8);const data=b.subarray(off+8,off+8+len)
if(type==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);ct=data[9]}
if(type==='IDAT')idat.push(data);off+=12+len}
const raw=zlib.inflateSync(Buffer.concat(idat));const bpp=ct===6?4:3;const stride=w*bpp;const out=Buffer.alloc(w*h*bpp)
const paeth=(a,b2,c)=>{const p=a+b2-c,pa=Math.abs(p-a),pb=Math.abs(p-b2),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b2:c}
let pos=0;const line=Buffer.alloc(stride),prev=Buffer.alloc(stride)
for(let y=0;y<h;y++){const f=raw[pos++];const row=y*stride
for(let x=0;x<stride;x++){const cur=raw[pos+x];const a=x>=bpp?line[x-bpp]:0;const up=y>0?prev[x]:0;const ul=x>=bpp&&y>0?prev[x-bpp]:0;let v
if(f===0)v=cur;else if(f===1)v=cur+a;else if(f===2)v=cur+up;else if(f===3)v=cur+((a+up)>>1);else v=cur+paeth(a,up,ul);out[row+x]=v&255}
line.set(out.subarray(row,row+stride));pos+=stride}
return{w,h,bpp,out}}
const CRC_TABLE=(()=>{const t=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c}return t})()
const crc32=b=>{let c=-1;for(let i=0;i<b.length;i++)c=CRC_TABLE[(c^b[i])&0xff]^(c>>>8);return (c^-1)>>>0}
const chunk=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const body=Buffer.concat([Buffer.from(t),d]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([l,body,crc])}
function save(p,w,h,rgba){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6
const stride=w*4;const raw=Buffer.alloc((stride+1)*h);for(let y=0;y<h;y++){raw[y*(stride+1)]=0;rgba.copy(raw,y*(stride+1)+1,y*stride,(y+1)*stride)}
fs.writeFileSync(p,Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]))}
const [file,out,tw]=process.argv.slice(2)
const {w,h,bpp,out:px}=load(file)
const TW=Number(tw)||300, TH=Math.round(h*TW/w)
const dst=Buffer.alloc(TW*TH*4)
for(let y=0;y<TH;y++)for(let x=0;x<TW;x++){const sx=Math.floor(x*w/TW),sy=Math.floor(y*h/TH),s=(sy*w+sx)*bpp,d=(y*TW+x)*4
dst[d]=px[s];dst[d+1]=px[s+1];dst[d+2]=px[s+2];dst[d+3]=255}
save(out,TW,TH,dst)
console.log(out,TW,TH)
