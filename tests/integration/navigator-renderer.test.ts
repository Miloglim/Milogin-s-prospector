import { expect,it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
it.skipIf(!process.env.NAVIGATOR_RENDERER_SMOKE)('built Electron renderer: explicit login/query, no anonymous query, identity switch clears rows',()=>{
 const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'prospector-navigator-ui-'));
 try{
  const env={...process.env,SMOKE_SANDBOX:sandbox,SMOKE_RENDERER:path.resolve('dist/renderer/index.html')};
  delete env.ELECTRON_RUN_AS_NODE;
  const output=execFileSync(require('electron'),[path.resolve('tests/fixtures/navigator-renderer-smoke.cjs')],{env,windowsHide:true,encoding:'utf8',timeout:20000});
  expect(output).toContain('NAVIGATOR_RENDERER_SMOKE_OK');
 }finally{
  if(path.dirname(path.resolve(sandbox))!==path.resolve(os.tmpdir()) || !path.basename(sandbox).startsWith('prospector-navigator-ui-'))throw Error('Unsafe fixture cleanup');
  fs.rmSync(sandbox,{recursive:true,force:true});
 }
},25000);
