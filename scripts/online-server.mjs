import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn,execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
process.chdir(ROOT);
const require=createRequire(import.meta.url);
const { ONLINE_DEFAULTS,API_ROUTES }=require("../dist-server/core/auth.js");
const { readOnlineConfig }=require("../dist-server/adapters/online-config.js");
const RUNTIME=path.join(ROOT,".work/pg-crm");
const CONFIG=path.join(RUNTIME,"online.json"), PROCESS=path.join(RUNTIME,"online-process.json"), LOCK=path.join(RUNTIME,"online.lock");
const MARKER="prospector-online-instance-v1";
const PRIVATE_FILE_MODE=0o600, JSON_INDENT=2, INSTANCE_BYTES=32;
const START_TIMEOUT_MS=20000, STOP_TIMEOUT_MS=10000, POLL_INTERVAL_MS=100, FETCH_TIMEOUT_MS=1000;
const TEST_TIMEOUT_MS=360000, EXIT_FAILED=1;
const command=process.argv[2];
function log(level,message) { process.stdout.write(`[${new Date().toISOString()}] [${level}] [identity.lifecycle] ${message}\n`); }
function readProcess() {
  if(!fs.existsSync(PROCESS)) return null;
  const state=JSON.parse(fs.readFileSync(PROCESS,"utf8"));
  if(state.marker!==MARKER || !Number.isSafeInteger(state.pid) || state.pid<1 || !/^[a-f0-9]{64}$/.test(state.instanceId)) throw new Error("进程记录无效，拒绝操作");
  return state;
}
async function health(config,route=API_ROUTES.live) {
  try {
    const response=await fetch(`http://${config.host}:${config.port}${route}`,{signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
    if(!response.ok) return null;
    return await response.json();
  } catch { return null; } // unavailable service is a state probe, never logs credentials
}
async function owns(config,state) {
  const live=await health(config);
  return live?.ok===true && live.data?.instanceId===state.instanceId && live.data?.pid===state.pid;
}
function alive(pid) {
  try { process.kill(pid,0); return true; }
  catch(error) { if(error.code==="ESRCH") return false; throw error; }
}
async function unusedPort(config) {
  await new Promise((resolve,reject)=> {
    const socket=net.createServer(); socket.once("error",reject);
    socket.listen(config.port,config.host,()=>socket.close(error=>error?reject(error):resolve()));
  });
}
const delay=()=>new Promise(resolve=>setTimeout(resolve,POLL_INTERVAL_MS));
let locked=false;
try {
    if(process.env.PROSPECTOR_CENTER_MODE && process.env.PROSPECTOR_CENTER_MODE!=='test') {
      throw new Error("测试启动器拒绝正式中心运行模式");
    }
    if(command==="test") {
    execFileSync(process.execPath,[path.join(ROOT,"scripts/center-tests.mjs")],{cwd:ROOT,windowsHide:true,stdio:"inherit",timeout:TEST_TIMEOUT_MS});
  } else {
    // PG start verifies exact cluster/data directory; status/stop must not initialize anything.
    if(command==="start") {
      if(!process.argv.includes("--test")) throw new Error("启动必须显式指定 --test，本节点尚未开放生产模式");
      execFileSync(process.execPath,[path.join(ROOT,"scripts/crm-postgres.mjs"),"start"],{cwd:ROOT,stdio:"inherit",windowsHide:true,timeout:START_TIMEOUT_MS});
      if(!fs.existsSync(CONFIG)) fs.writeFileSync(CONFIG,JSON.stringify({...ONLINE_DEFAULTS,test_mode:true},null,JSON_INDENT),{mode:PRIVATE_FILE_MODE,flag:"wx"});
    }
    const config=readOnlineConfig();
    if(!["start","stop","status"].includes(command)) throw new Error("用法：online-server.mjs start --test|status|stop|test");
    if(command!=="status") {
      if(fs.existsSync(LOCK)) {
        const lock=JSON.parse(fs.readFileSync(LOCK,"utf8"));
        if(lock.marker!==MARKER || !Number.isSafeInteger(lock.pid) || lock.pid<1 || alive(lock.pid)) throw new Error("中心生命周期操作已被占用，保留锁记录");
        fs.unlinkSync(LOCK); // exact stale lock belonging to this runtime only
      }
      fs.writeFileSync(LOCK,JSON.stringify({marker:MARKER,pid:process.pid}),{mode:PRIVATE_FILE_MODE,flag:"wx"}); locked=true;
    }
    const state=readProcess();
    if(command==="status") {
      if(!state || !await owns(config,state)) throw new Error("中心未运行或进程标识不匹配");
      if((await health(config,API_ROUTES.ready))?.ok!==true) throw new Error("中心进程存在，但数据库尚未就绪");
      log("INFO",`中心服务健康 ${config.host}:${config.port}；测试账户凭据仅在本机受控文件`);
    } else if(command==="stop") {
      if(state && alive(state.pid)) {
        if(!await owns(config,state)) throw new Error("无法核实服务身份，拒绝终止其他进程");
        process.kill(state.pid,"SIGTERM");
        const deadline=Date.now()+STOP_TIMEOUT_MS;
        while(alive(state.pid) && Date.now()<deadline) await delay();
        if(alive(state.pid)) throw new Error("服务未完成退出，保留进程记录");
      }
      if(state) fs.unlinkSync(PROCESS);
      log("INFO","中心测试服务已停止；PG与测试身份数据保留");
    } else {
      if(state && alive(state.pid)) {
        if(!await owns(config,state)) throw new Error("记录的进程身份不匹配，拒绝重新启动或覆盖");
        if((await health(config,API_ROUTES.ready))?.ok!==true) throw new Error("中心已启动但数据库不可用，不重复启动");
      } else {
        await unusedPort(config);
        const instanceId=randomBytes(INSTANCE_BYTES).toString("hex");
        const output=fs.openSync(path.join(RUNTIME,"online.log"),"a",PRIVATE_FILE_MODE);
        let child;
        try {
          child=spawn(process.execPath,[path.join(ROOT,"dist-server/online.js")],{cwd:ROOT,detached:true,windowsHide:true,
            env:{...process.env,PROSPECTOR_ONLINE_INSTANCE:instanceId},stdio:["ignore",output,output]});
        } finally { fs.closeSync(output); }
        if(!child.pid) throw new Error("中心进程未启动");
        child.on("error",()=>log("ERROR","中心子进程启动错误")); child.unref();
        const next={marker:MARKER,pid:child.pid,instanceId};
        fs.writeFileSync(PROCESS,JSON.stringify(next),{mode:PRIVATE_FILE_MODE});
        const deadline=Date.now()+START_TIMEOUT_MS;
        while(Date.now()<deadline) {
          if(await owns(config,next) && (await health(config,API_ROUTES.ready))?.ok===true) break;
          if(!alive(next.pid)) throw new Error("中心进程启动后退出；检查受控日志");
          await delay();
        }
        if(!await owns(config,next) || (await health(config,API_ROUTES.ready))?.ok!==true) throw new Error("启动未就绪，保留进程记录供核对");
      }
      log("INFO",`中心测试服务就绪 ${config.host}:${config.port}；无桌面库切换`);
    }
  }
} catch {
  log("ERROR","中心操作失败；检查本机受控配置、端口、进程记录与日志，不要粘贴凭据");
  process.exitCode=EXIT_FAILED;
} finally { if(locked) fs.unlinkSync(LOCK); }

