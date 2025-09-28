#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(ROOT, 'lib');
const DST = path.join(LIB_DIR, 'whisper.cpp');
const REPO = 'https://github.com/ggml-org/whisper.cpp';
const TAG = 'v1.7.6';
const MODEL_SCRIPTS = [
  'download-ggml-model.cmd',
  'download-ggml-model.sh',
];

function log(msg){ console.log(`[whisper-node prepack] ${msg}`); }
function ensureDir(d){ try{ fs.mkdirSync(d,{recursive:true}); }catch{} }
function exists(p){ try{ fs.accessSync(p); return true; }catch{ return false; } }
function isWin(){ return process.platform === 'win32'; }

const WINDOWS_ARTIFACTS = [
  { url: `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-bin-Win32.zip`,              targetDir: 'Win32' },
  { url: `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-bin-x64.zip`,                targetDir: 'Win64' },
  { url: `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-blas-bin-Win32.zip`,         targetDir: 'BlasWin32' },
  { url: `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-blas-bin-x64.zip`,           targetDir: 'BlasWin64' },
  // { url: `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-cublas-11.8.0-bin-x64.zip`,  targetDir: 'CublasWin64-11.8' },
  // { url: `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-cublas-12.4.0-bin-x64.zip`,  targetDir: 'CublasWin64-12.4' },
];

if (exists(DST)) {
  fs.rmSync(DST, { recursive: true, force: true });
}

function download(url, out){
  return new Promise((res, rej) => {
    const file = fs.createWriteStream(out);
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return download(r.headers.location, out).then(res).catch(rej);
      }
      if (r.statusCode !== 200) return rej(`HTTP ${r.statusCode} for ${url}`);
      r.pipe(file);
      file.on('finish', () => file.close(res));
    }).on('error', rej);
  });
}

function unzip(zipPath, destDir){
  // Prefer 'tar -xf' when available; fallback to PowerShell Expand-Archive
  let ok = spawnSync('tar', ['-xf', zipPath, '-C', destDir], {stdio:'ignore'}).status === 0;
  if (!ok) {
    const ps = process.env.ComSpec?.toLowerCase().includes('powershell') ? process.env.ComSpec : 'powershell';
    const cmd = `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`;
    ok = spawnSync(ps, ['-NoProfile','-NonInteractive','-Command', cmd], {stdio:'ignore'}).status === 0;
  }
  return ok;
}

function findReleaseRoot(extractDir){
  // Common layouts:
  //  - <extractDir>/Release/*
  //  - <extractDir>/<someFolder>/Release/*
  const direct = path.join(extractDir, 'Release');
  if (exists(direct)) return direct;
  try {
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        const p = path.join(extractDir, e.name, 'Release');
        if (exists(p)) return p;
      }
    }
  } catch {}
  // Fallback to the extraction root
  return extractDir;
}

function copyDirContents(srcDir, destDir){
  ensureDir(destDir);
  const items = fs.readdirSync(srcDir);
  for (const name of items) {
    const src = path.join(srcDir, name);
    const dst = path.join(destDir, name);
    fs.cpSync(src, dst, { recursive: true, force: true });
  }
}


function hasExe(dir){
  return exists(path.join(dir,'whisper-cli.exe')) || exists(path.join(dir,'main.exe'));
}

function cloneRepo(){
  log(`Cloning ${REPO} (${TAG}) into ${path.relative(ROOT, DST)} ...`);
  const args = ['clone','--branch',TAG,'--depth','1',REPO,DST];
  const r = spawnSync('git', args, {stdio:'inherit'});
  if (r.status !== 0) log('Warning: clone failed. Runtime will attempt setup again.');
}

async function setupWin(){
  ensureDir(DST);
  for (const art of WINDOWS_ARTIFACTS) {
    try {
      const tmpZip = path.join(ROOT, `.whisper-${Date.now()}-${path.basename(art.url)}`);
      const extractDir = path.join(ROOT, `.whisper-extract-${Date.now()}`);
      log(`Downloading ${path.basename(art.url)} ...`);
      await download(art.url, tmpZip);
      ensureDir(extractDir);
      const ok = unzip(tmpZip, extractDir);
      if (!ok) { log(`Warning: unzip failed for ${art.url}`); }

      const releaseRoot = findReleaseRoot(extractDir);
      const target = path.join(DST, art.targetDir);
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
      ensureDir(target);
      copyDirContents(releaseRoot, target);

      try { fs.rmSync(tmpZip, { force: true }); } catch {}
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
    } catch (e) {
      log(`Warning: failed to fetch ${art.url}: ${e?.message || e}`);
    }
  }

  // Fetch model download scripts into scripts dir for CLI use
  try {
    const scriptsDir = path.join(DST, 'scripts');
    ensureDir(scriptsDir);
    for (const script of MODEL_SCRIPTS) {
      const url = `${REPO}/raw/${TAG}/models/${script}`;
      const out = path.join(scriptsDir, script);
      try {
        log(`Fetching ${script} ...`);
        await download(url, out);
      } catch (e) {
        log(`Warning: could not fetch ${script}: ${e?.message || e}`);
      }
    }
  } catch (e) {
    log(`Warning: failed to place model scripts: ${e?.message || e}`);
  }

  // Ensure models directory exists for model downloads
  try {
    const modelsDir = path.join(DST, 'models');
    ensureDir(modelsDir);
    log(`Created models directory: ${path.relative(ROOT, modelsDir)}`);
  } catch (e) {
    log(`Warning: failed to create models directory: ${e?.message || e}`);
  }
}

(async function main(){
  try{
    ensureDir(LIB_DIR);
    if (isWin()) {
      await setupWin();
    } else {
      // Non-Windows: bundle source for local builds
      if (!exists(DST)) ensureDir(DST);
      cloneRepo();
    }
  }catch(e){
    log(`Warning: prepack error: ${e?.message || e}`);
  }
})();


