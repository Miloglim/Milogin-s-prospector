import { readFile,realpath,stat } from 'node:fs/promises';
import { resolve,relative,isAbsolute,extname } from 'node:path';
import type { BrowserHandler } from '../transport/http';
import { send } from '../transport/http';
import { failure } from '../core/crm';
const TYPES:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.woff':'font/woff'};
function inside(root:string,path:string) {const part=relative(root,path);return part!==''&&!part.startsWith('..')&&!isAbsolute(part);}
export function createAdminStatic(root=resolve(__dirname,'../../dist-admin')):BrowserHandler {
 return async(request,response)=>{
  try {
   const pathname=new URL(request.url??'/',`http://${request.headers.host}`).pathname;
   const asset=pathname==='/'?'index.html':decodeURIComponent(pathname.slice(1));
   if(asset!=='index.html'&&!/^assets\/[A-Za-z0-9_.-]+$/.test(asset)){send(response,failure('NOT_FOUND','页面不存在'));return;}
   const base=await realpath(root),file=await realpath(resolve(base,asset));
   const contentType=TYPES[extname(file)];
   if(!inside(base,file)||!contentType||!(await stat(file)).isFile()){send(response,failure('NOT_FOUND','页面不存在'));return;}
   const content=await readFile(file);
   response.writeHead(200,{'Content-Type':contentType,'Content-Length':content.length,'X-Content-Type-Options':'nosniff','Cache-Control':asset==='index.html'?'no-store':'public, max-age=31536000, immutable'});
   response.end(request.method==='HEAD'?undefined:content);
  } catch {send(response,failure('NOT_FOUND','管理页面尚未构建或资源不存在'));} // Do not expose paths or OS errors.
 };
}
