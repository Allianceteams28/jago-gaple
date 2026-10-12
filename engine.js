'use strict';
/* Logika murni Jago Gaple: dipakai bareng oleh klien (browser) dan server (Node).
   JANGAN diedit di sini. Sumbernya <script id="engine"> di public/index.html, lalu jalankan: node build.js */
const TEAMS=['Tim A','Tim B'];
const SEATS=['Kamu','Bot Kanan','Partner','Bot Kiri'];   // urutan giliran: muter ke kanan
const teamOf=s=>s&1;                                       // kursi 0,2 = Tim A; 1,3 = Tim B
const nextSeat=s=>(s+1)&3;
const tsum=t=>t[0]+t[1];
const same=(a,b)=>a[0]===b[0]&&a[1]===b[1];
const handSum=h=>h.reduce((n,t)=>n+tsum(t),0);
const LOSS_LIMIT=101;
const LOSS_FREE=10;      // sisa batu lawan (gabungan) <= 10 nggak dihitung jadi mata kalah

function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function fullDeck(){const d=[];for(let i=0;i<=6;i++)for(let j=i;j<=6;j++)d.push([i,j]);return d;}

function newMatch(target){
  return {target,score:[0,0],loss:[0,0],round:1,game:0,next:{mode:'point',starter:null}};
}

// mode 'point'  : pembuka = pemegang batu sesuai poin permainan (awal ronde / habis draw)
// mode 'winner' : pembuka = pemain yang bikin timnya menang, wajib balak
function newHand(M,mode,starter){
  const d=shuffle(fullDeck());
  const hands=[0,1,2,3].map(i=>d.slice(i*7,i*7+7).sort((x,y)=>x[0]-y[0]||x[1]-y[1]));
  const H={hands,center:null,armL:[],armR:[],mode,starter,pointTile:null,turn:starter,
           openKnocks:0,earlyKnocks:0,lacks:[new Set(),new Set(),new Set(),new Set()],lastKey:null};
  if(mode==='point'){
    const a=M.score[0],b=M.score[1];
    H.pointTile=[Math.min(a,b),Math.max(a,b)];
    H.turn=hands.findIndex(h=>h.some(t=>same(t,H.pointTile)));
  }
  return H;
}

function endsOf(H){
  if(!H.center)return null;
  const L=H.armL.length?H.armL[H.armL.length-1].outer:H.center.l;
  const R=H.armR.length?H.armR[H.armR.length-1].outer:H.center.r;
  return [L,R];
}
const chainLen=H=>H.center?1+H.armL.length+H.armR.length:0;

function legalMoves(H,seat){
  const hand=H.hands[seat],mv=[];
  if(!H.center){
    if(H.mode==='point')hand.forEach(t=>{if(same(t,H.pointTile))mv.push({tile:t,side:'C'});});
    else hand.forEach(t=>{if(t[0]===t[1])mv.push({tile:t,side:'C'});});
    return mv;
  }
  const e=endsOf(H);
  hand.forEach(t=>{
    if(t[0]===e[0]||t[1]===e[0])mv.push({tile:t,side:'L'});
    if(t[0]===e[1]||t[1]===e[1])mv.push({tile:t,side:'R'});
  });
  return mv;
}

function doPlay(H,seat,mv){
  const h=H.hands[seat];h.splice(h.findIndex(t=>same(t,mv.tile)),1);
  const t=mv.tile;
  H.earlyKnocks=0;
  if(mv.side==='C'){
    H.center={l:t[0],r:t[1],double:t[0]===t[1]};
    H.lastKey='c';
  }else{
    const e=endsOf(H)[mv.side==='L'?0:1];
    const arm=mv.side==='L'?H.armL:H.armR;
    arm.push({inner:e,outer:t[0]===e?t[1]:t[0],double:t[0]===t[1]});
    H.lastKey=mv.side+(arm.length-1);
  }
}
function doKnock(H,seat){
  const e=endsOf(H);
  if(e){H.lacks[seat].add(e[0]);H.lacks[seat].add(e[1]);}
}
// hasil: 'next' | 'out' | 'lock' | 'reshuffle'
function afterPlay(H,seat){
  if(H.hands[seat].length===0)return 'out';
  if(H.hands.every((_,s)=>legalMoves(H,s).length===0))return 'lock';
  H.turn=nextSeat(seat);return 'next';
}
function afterKnock(H,seat){
  if(!H.center){                       // pembuka nggak punya balak
    H.openKnocks++;
    if(H.openKnocks>=2)return 'reshuffle';
  }else if(chainLen(H)===1){           // dua pemain setelah pembuka sama-sama ketuk
    H.earlyKnocks++;
    if(H.earlyKnocks>=2)return 'reshuffle';
  }
  H.turn=nextSeat(seat);return 'next';
}

function settleHand(M,H,kind,seat){
  const totals=H.hands.map(handSum);
  const res={kind,totals,hands:H.hands.map(h=>h.map(t=>t.slice())),draw:false};
  let winnerSeat;
  if(kind==='out')winnerSeat=seat;
  else{
    const min=Math.min(...totals);
    const mins=[0,1,2,3].filter(s=>totals[s]===min);
    if(new Set(mins.map(teamOf)).size>1){res.draw=true;M.next={mode:'point',starter:null};return res;}
    winnerSeat=mins[0];
  }
  const wt=teamOf(winnerSeat),lt=1-wt;
  const pts=[0,1,2,3].filter(s=>teamOf(s)===lt).reduce((n,s)=>n+totals[s],0);
  const counted=pts>LOSS_FREE?pts:0;
  M.loss[lt]+=counted;
  Object.assign(res,{winnerSeat,winnerTeam:wt,loserTeam:lt,pts,counted,lossAfter:M.loss.slice()});
  if(M.loss[lt]>=LOSS_LIMIT){
    const clean=M.loss[wt]===0,gain=clean?2:1;
    M.score[wt]+=gain;
    res.ronde={loserTeam:lt,winnerTeam:wt,gain,clean};
    res.scoreAfter=M.score.slice();
    if(M.score[wt]>=M.target)res.matchOver=wt;
    M.loss=[0,0];M.round++;
    M.next={mode:'point',starter:null};
  }else M.next={mode:'winner',starter:winnerSeat};
  return res;
}

function botChoose(H,seat,moves){
  const partner=(seat+2)&3,opps=[(seat+1)&3,(seat+3)&3];
  const armLen=s=>s==='L'?H.armL.length:s==='R'?H.armR.length:0;
  let best=null,bestS=-Infinity;
  for(const m of moves){
    const t=m.tile;let ne;
    if(m.side==='C')ne=[t[0],t[1]];
    else{
      const e=endsOf(H),i=m.side==='L'?0:1,outer=t[0]===e[i]?t[1]:t[0];
      ne=i===0?[outer,e[1]]:[e[0],outer];
    }
    const rest=H.hands[seat].filter(x=>!same(x,t));
    let s=tsum(t)*0.9+(t[0]===t[1]?2.5:0);
    if(rest.length===0)s+=1000;
    s+=rest.filter(x=>ne.some(v=>x[0]===v||x[1]===v)).length*1.6;
    for(const v of ne){
      s+=rest.filter(x=>x[0]===v||x[1]===v).length*0.6;
      for(const o of opps)if(H.lacks[o].has(v))s+=3.2;
      if(H.lacks[partner].has(v))s-=3;
    }
    if(m.side!=='C'&&armLen(m.side)<armLen(m.side==='L'?'R':'L'))s+=0.3;
    s+=Math.random()*1.2;
    if(s>bestS){bestS=s;best=m;}
  }
  return best;
}

// ---- tata letak rantai: dua lengan keluar dari tengah; kalau mentok tepi papan, batu diputar tegak jadi "batu sudut" ----
const LS=22,LL=44,LG=1,RG=3,CW=330,MG=4;   // LG = celah antar batu, RG = celah antar baris
function layoutChain(H,ghosts,W=CW){
  const items=[],gh=[];
  if(!H.center)return {items,gh,height:LL};
  const c=H.center,cw=c.double?LS:LL,ch=c.double?LL:LS,cx=(W-cw)/2;
  items.push({x:cx,row:0,w:cw,h:ch,first:c.l,second:c.r,vertical:c.double,key:'c',corner:false});
  const walk=(arm,dir,rowSign,cursor,tag)=>{
    let row=0;
    // tempat untuk batu selebar w. Kalau setelah dipasang sisa tempat < lebar batu sudut, batu ini yang jadi sudut.
    const place=w=>{
      const room=dir===1?W-MG-cursor:cursor-MG;
      if(room-w-LG>=LS)return {x:dir===1?cursor:cursor-w,row,dir,w,corner:false};
      return {x:dir===1?cursor:cursor-LS,row,dir,w:LS,corner:true,toRow:row+rowSign};
    };
    arm.forEach((e,i)=>{
      const p=place(e.double?LS:LL);
      let first,second;
      if(p.corner){            // tegak: bagian "inner" menghadap baris lama, "outer" menghadap baris baru
        first=e.double?e.inner:(rowSign===1?e.inner:e.outer);
        second=e.double?e.inner:(rowSign===1?e.outer:e.inner);
      }else{
        first=e.double?e.inner:(p.dir===1?e.inner:e.outer);
        second=e.double?e.inner:(p.dir===1?e.outer:e.inner);
      }
      const tall=p.corner||e.double;
      items.push({x:p.x,row:p.row,w:p.w,h:tall?LL:LS,first,second,vertical:tall,key:tag+i,corner:p.corner,toRow:p.toRow});
      if(p.corner){row=p.toRow;dir=-p.dir;cursor=dir===1?p.x+LS+LG:p.x-LG;}
      else cursor=p.dir===1?p.x+p.w+LG:p.x-LG;
    });
    if(ghosts){const p=place(LL);gh.push({x:p.x,row:p.row,w:p.corner?LS:LL,h:p.corner?LL:LS,corner:p.corner,toRow:p.toRow,side:tag});}
  };
  walk(H.armL,-1,-1,cx-LG,'L');
  walk(H.armR,1,1,cx+cw+LG,'R');
  // posisi vertikal: jarak antar baris cuma dilebarkan kalau ada balak yang betul-betul bersinggungan dengan batu baris sebelah
  const all=[...items,...gh];
  const rows=all.flatMap(i=>i.corner?[i.row,i.toRow]:[i.row]);
  const rmin=Math.min(...rows),rmax=Math.max(...rows);
  const ov=(a,b)=>a.x<b.x+b.w&&b.x<a.x+a.w;
  const E=LL/2-(LS+RG)/2;   // seberapa jauh batu sudut menjorok melewati garis tengah baris (kasus terburuk)
  const gap=r=>{
    let g=LS+RG;
    for(const a of all){
      if(a.corner||a.row!==r)continue;
      for(const b of all)if(!b.corner&&b.row===r+1&&ov(a,b))g=Math.max(g,(a.h+b.h)/2+RG);
    }
    for(const k of all){                       // batu sudut juga makan tempat di baris atas/bawahnya
      if(!k.corner)continue;
      const lo=Math.min(k.row,k.toRow),hi=Math.max(k.row,k.toRow);
      for(const a of all){
        if(a.corner||!ov(a,k))continue;
        if(a.row===r&&r+1===lo)g=Math.max(g,a.h/2+E+RG);
        if(a.row===r+1&&r===hi)g=Math.max(g,E+a.h/2+RG);
      }
    }
    return g;
  };
  const cy={0:0};
  for(let r=0;r<rmax;r++)cy[r+1]=cy[r]+gap(r);
  for(let r=0;r>rmin;r--)cy[r-1]=cy[r]-gap(r-1);
  const top=i=>i.corner?(cy[i.row]+cy[i.toRow])/2-LL/2:cy[i.row]-i.h/2;
  let half=LS/2;
  all.forEach(i=>{half=Math.max(half,-top(i),top(i)+i.h);});
  const fy=i=>half+top(i);
  return {items:items.map(i=>({...i,y:fy(i)})),gh:gh.map(g=>({...g,y:fy(g)})),height:2*half};
}

// dipakai juga oleh server (Node). Di browser baris ini dilewati.
if(typeof module!=='undefined'&&module.exports)module.exports={TEAMS,SEATS,teamOf,nextSeat,tsum,same,handSum,LOSS_LIMIT,LOSS_FREE,newMatch,newHand,endsOf,chainLen,legalMoves,doPlay,doKnock,afterPlay,afterKnock,settleHand,botChoose,layoutChain,CW};
