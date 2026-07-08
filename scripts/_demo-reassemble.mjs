// Re-assemble docs/phase1-demo.mp4 from the already-recorded scene clips +
// freshly-rendered title cards (arrow glyph fixed). No re-recording.
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
const ROOT='/Users/sujaygp/Desktop/poc';const WORK=path.join(ROOT,'docs/_demo-frames');const OUT=path.join(ROOT,'docs/phase1-demo.mp4');const FFMPEG='/opt/homebrew/bin/ffmpeg';const FPS=3;
function esc(s){return s.replace(/→/g,'->').replace(/\\/g,'\\\\').replace(/:/g,'\\:').replace(/'/g,'’').replace(/,/g,'\\,');}
function titleCard(lines,clipName,{seconds=2.2,size=46}={}){const clip=path.join(WORK,`${clipName}.mp4`);const draws=lines.map((ln,i)=>{const y=`(h/2)-(${(lines.length-1)*(size+18)} /2)+${i*(size+18)}`;const f=i===0?size:Math.round(size*0.6);const col=i===0?'white':'0xC4B5FD';return `drawtext=text='${esc(ln)}':fontcolor=${col}:fontsize=${f}:x=(w-text_w)/2:y=${y}`;}).join(',');execFileSync(FFMPEG,['-y','-f','lavfi','-i',`color=c=0x0f172a:s=1280x800:d=${seconds}:r=${FPS}`,'-vf',`${draws},format=yuv420p`,'-c:v','libx264','-preset','medium','-crf','20','-r',String(FPS),clip],{stdio:'pipe'});return clip;}
// Rebuild the title cards.
titleCard(['Command Center — Phase 1','Daily Agency Intake · both edge cases, end to end'],'card-00-open',{seconds:2.6});
titleCard(['Scene 1 — The Workflow','Daily 12:00 CST · for each agency · uploaded?'],'card-01');
titleCard(['Scene 2 — Agency has NOT uploaded','The daily run blocks on TASK · Contact Agency'],'card-02');
titleCard(['Scene 3 — Agency uploads mid-run','Same live run updates: contact task resolves, new item flows'],'card-03');
titleCard(['Recap','Daily 12:00 CST · for each agency','Not uploaded → TASK · Contact Agency (call / sms / email)','Uploaded → TASK · Update Object Module → patient / admission / episode / order + review','Mid-run upload updates the SAME live run'],'card-04-recap',{seconds:6.5,size:40});
// Concat order.
const order=['card-00-open','card-01','scene-01','card-02','scene-02a','scene-02b','scene-02c','scene-02d','card-03','scene-03a','scene-03b','scene-03c','scene-03d','scene-03e','scene-03f','card-04-recap'];
const clips=order.map(n=>path.join(WORK,`${n}.mp4`)).filter(f=>fs.existsSync(f));
const missing=order.filter(n=>!fs.existsSync(path.join(WORK,`${n}.mp4`)));
if(missing.length)console.log('WARNING missing clips:',missing.join(', '));
const listFile=path.join(WORK,'concat.txt');
fs.writeFileSync(listFile,clips.map(c=>`file '${c}'`).join('\n'));
execFileSync(FFMPEG,['-y','-f','concat','-safe','0','-i',listFile,'-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','-r',String(FPS),'-movflags','+faststart',OUT],{stdio:'pipe'});
const r=spawnSync('/opt/homebrew/bin/ffprobe',['-v','error','-show_entries','format=duration:stream=codec_name,pix_fmt,width,height','-of','default=noprint_wrappers=1',OUT],{encoding:'utf8'});
console.log('clips used:',clips.length);
console.log('FFPROBE:\n'+(r.stdout||r.stderr));
process.exit(0);
