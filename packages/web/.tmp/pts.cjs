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
const {w,h,out}=load('public/art/sprites/fountain.png')
const px=(x,y)=>{const i=(y*w+x)*3;return[out[i],out[i+1],out[i+2]]}
console.log('size',w,h)
for(const[x,y]of[[460,380],[500,420],[470,560],[700,560],[600,590],[440,500],[740,450],[640,380],[300,400],[150,700]])console.log(x,y,px(x,y))
