const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {WebSocketServer}=require('ws');
const DATA=path.join(__dirname,'data');
if(!fs.existsSync(DATA))fs.mkdirSync(DATA,{recursive:true});

function loadJ(f,d){try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return d;}}
function saveJ(f,d){try{fs.writeFileSync(f,JSON.stringify(d),'utf8');}catch(e){console.error('saveJ',e);}}

// ── ACCOUNTS ──────────────────────────────────────────────────────────────────
let accounts=loadJ(path.join(DATA,'accounts.json'),{});
function saveAccounts(){saveJ(path.join(DATA,'accounts.json'),accounts);}

function hashPw(pw,salt){return crypto.pbkdf2Sync(pw,salt,10000,64,'sha256').toString('hex');}
function mkSalt(){return crypto.randomBytes(16).toString('hex');}
function mkToken(){return crypto.randomBytes(24).toString('hex');}
const sessions={}; // token -> username key

// ── WORLDS ────────────────────────────────────────────────────────────────────
// worlds[id] = { id, name, owner, mode, seed, public, password, players:Map, edits:{}, mobs:[] }
const worlds=new Map();

// The permanent public world
const PUBLIC_WORLD_ID='public';
const publicSeed=loadJ(path.join(DATA,'public_seed.json'),{v:Math.floor(Math.random()*99999)}).v;
saveJ(path.join(DATA,'public_seed.json'),{v:publicSeed});
const publicEdits=loadJ(path.join(DATA,'public_edits.json'),{});

worlds.set(PUBLIC_WORLD_ID,{
  id:PUBLIC_WORLD_ID,
  name:'Public World',
  owner:'system',
  mode:'survival',
  seed:publicSeed,
  public:true,
  password:null,
  players:new Map(),
  edits:publicEdits,
  mobs:[],
  mobId:0,
});

// Save public world edits periodically
setInterval(()=>{
  const pw=worlds.get(PUBLIC_WORLD_ID);
  if(pw)saveJ(path.join(DATA,'public_edits.json'),pw.edits);
  saveAccounts();
},20000);

// Personal worlds stored per-account
function getPersonalWorldEdits(username){
  const f=path.join(DATA,`world_${username}.json`);
  return loadJ(f,{});
}
function savePersonalWorldEdits(username,edits){
  saveJ(path.join(DATA,`world_${username}.json`),edits);
}

// ── MOB SYSTEM ───────────────────────────────────────────────────────────────
const SEA=90,WH=180;
const MOB_SPEEDS={zombie:.006,skeleton:.007,slime:.004,bat:.009,spider:.008,demon:.005,goblin:.009,vampire:.007};
const MOB_FLY=new Set(['bat']);
const MOB_HP={zombie:40,skeleton:30,slime:20,bat:15,spider:25,demon:120,goblin:35,vampire:80};
const MOB_TYPES=Object.keys(MOB_HP);

function sn(x,s){return Math.sin(x*.05+s)*Math.sin(x*.02+s*1.7)*.5+.5;}
function sn2(x,s){return Math.sin(x*.12+s)*.5+.5;}
function groundY(x,seed){
  let h=SEA-Math.floor(sn(x,seed)*16+sn2(x,seed*3)*8+Math.sin(x*.008+seed)*10);
  return Math.max(15,Math.min(WH-15,h));
}

function spawnMob(world){
  const type=MOB_TYPES[Math.floor(Math.random()*MOB_TYPES.length)];
  const x=Math.floor(Math.random()*400)-200;
  const y=groundY(x,world.seed)-1;
  const id=world.mobId++;
  const hp=MOB_HP[type]||30;
  world.mobs.push({id,type,x,y,hp,maxHp:hp,vx:0,vy:0,dmgCooldown:0});
  return id;
}

function initWorldMobs(world){
  world.mobs=[];world.mobId=0;
  const count=world.mode==='creative'?0:25;
  for(let i=0;i<count;i++)spawnMob(world);
}

// Tick all worlds with players
setInterval(()=>{
  for(const[wid,world] of worlds){
    if(world.players.size===0)continue;
    if(world.mode==='creative')continue;
    const pl=[...world.players.values()];
    world.mobs.forEach(mob=>{
      let nearest=null,nd=99999;
      pl.forEach(p=>{const d=Math.abs(p.x-mob.x)+Math.abs(p.y-mob.y);if(d<nd){nd=d;nearest=p;}});
      const spd=MOB_SPEEDS[mob.type]||.006;
      if(nearest&&nd<25){mob.vx+=(nearest.x-mob.x>0?1:-1)*spd;}
      else if(Math.random()<.015){mob.vx=(Math.random()-.5)*spd*2;}
      mob.vx=Math.max(-spd*1.5,Math.min(spd*1.5,mob.vx));
      mob.vx*=0.85;
      mob.x+=mob.vx;
      if(!MOB_FLY.has(mob.type)){
        mob.vy=(mob.vy||0)+0.35;mob.vy=Math.min(mob.vy,10);
        mob.y+=mob.vy/18;
        const gy=groundY(Math.floor(mob.x),world.seed)-1;
        if(mob.y>=gy){mob.y=gy;mob.vy=0;}
        mob.y=Math.max(0,Math.min(WH-3,mob.y));
      } else {
        if(nearest)mob.y+=(nearest.y-3-mob.y)*0.04;
      }
      if(mob.x<1)mob.x=1;
    });
    world.mobs=world.mobs.filter(m=>m.hp>0);
    while(world.mobs.length<25)spawnMob(world);
    broadcastWorld(world,{type:'mob_update',mobs:world.mobs.map(m=>({id:m.id,type:m.type,x:Math.round(m.x*10)/10,y:Math.round(m.y*10)/10,hp:m.hp,maxHp:m.maxHp}))});
  }
},300);

// ── HELPERS ──────────────────────────────────────────────────────────────────
const playerWorldMap=new Map(); // ws -> worldId
const wsPlayerMap=new Map();    // ws -> playerData

function broadcastWorld(world,data,exceptWs=null){
  const msg=JSON.stringify(data);
  for(const[ws] of world.players){
    if(ws!==exceptWs&&ws.readyState===1)ws.send(msg);
  }
}
function send(ws,data){if(ws.readyState===1)ws.send(JSON.stringify(data));}

function getWorldList(){
  const list=[];
  for(const[id,w] of worlds){
    if(w.public||w.players.size>0){
      list.push({id,name:w.name,owner:w.owner,mode:w.mode,players:w.players.size,hasPassword:!!w.password});
    }
  }
  return list;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const httpServer=http.createServer((req,res)=>{
  if(req.url==='/'||req.url==='/index.html'){
    fs.readFile(path.join(__dirname,'client.html'),(err,d)=>{
      if(err){res.writeHead(404);res.end('Not found');return;}
      res.writeHead(200,{'Content-Type':'text/html'});res.end(d);
    });
  } else { res.writeHead(404);res.end(); }
});

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
const wss=new WebSocketServer({server:httpServer});

wss.on('connection',ws=>{
  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    const ukey=msg.token?sessions[msg.token]:null;
    const acc=ukey?accounts[ukey]:null;

    switch(msg.type){

      // ── AUTH ──────────────────────────────────────────────────────────────
      case 'register':{
        const{username,password}=msg;
        if(!username||!password||username.length<2||password.length<4)
          return send(ws,{type:'auth_fail',reason:'Username ≥2, password ≥4'});
        if(accounts[username.toLowerCase()])
          return send(ws,{type:'auth_fail',reason:'Username taken'});
        const salt=mkSalt(),hash=hashPw(password,salt);
        accounts[username.toLowerCase()]={
          username,salt,hash,createdAt:Date.now(),
          inventory:{},hotbar:[0,0,0,0,0,0,0,0,0],
          armor:{head:0,chest:0,legs:0,feet:0},
          character:{skin:'#ffcc88',hair:'#3a2200',shirt:'#2244cc',pants:'#222244'},
          spawnX:10,spawnY:40,
          myWorlds:[], // list of world IDs this player owns
        };
        saveAccounts();
        const token=mkToken();sessions[token]=username.toLowerCase();
        send(ws,{type:'auth_ok',token,username,account:accounts[username.toLowerCase()]});
        break;
      }
      case 'login':{
        const{username,password}=msg;
        const a=accounts[username?.toLowerCase()];
        if(!a)return send(ws,{type:'auth_fail',reason:'Account not found'});
        if(hashPw(password,a.salt)!==a.hash)return send(ws,{type:'auth_fail',reason:'Wrong password'});
        const token=mkToken();sessions[token]=username.toLowerCase();
        send(ws,{type:'auth_ok',token,username:a.username,account:a});
        break;
      }

      // ── WORLD BROWSER ────────────────────────────────────────────────────
      case 'get_worlds':{
        send(ws,{type:'world_list',worlds:getWorldList()});
        break;
      }

      // ── CREATE WORLD ─────────────────────────────────────────────────────
      case 'create_world':{
        if(!acc)return send(ws,{type:'error',reason:'Not logged in'});
        const wid='w_'+mkToken().slice(0,12);
        const seed=Math.floor(Math.random()*99999);
        const mode=msg.mode==='creative'?'creative':'survival';
        const isPublic=!!msg.public;
        const pw=msg.password||null;
        const newWorld={
          id:wid,name:msg.name||acc.username+"'s World",
          owner:acc.username,mode,seed,
          public:isPublic,password:pw,
          players:new Map(),edits:{},mobs:[],mobId:0,
        };
        initWorldMobs(newWorld);
        worlds.set(wid,newWorld);
        // Save to account
        if(!acc.myWorlds)acc.myWorlds=[];
        acc.myWorlds.push({id:wid,name:newWorld.name,mode,seed});
        saveAccounts();
        send(ws,{type:'world_created',worldId:wid,world:{id:wid,name:newWorld.name,mode,seed,public:isPublic}});
        break;
      }

      // ── JOIN WORLD ───────────────────────────────────────────────────────
      case 'join':{
        if(!acc)return send(ws,{type:'error',reason:'Not logged in'});
        const wid=msg.worldId||PUBLIC_WORLD_ID;
        const world=worlds.get(wid);
        if(!world)return send(ws,{type:'error',reason:'World not found'});
        // Password check
        if(world.password&&msg.worldPassword!==world.password&&world.owner!==acc.username)
          return send(ws,{type:'error',reason:'Wrong world password'});
        // Leave current world if in one
        leaveWorld(ws);
        const player={
          username:acc.username,
          x:acc.spawnX||10,y:acc.spawnY||40,
          facing:1,anim:'idle',
          character:acc.character||{skin:'#ffcc88',hair:'#3a2200',shirt:'#2244cc',pants:'#222244'},
          worldId:wid,mode:world.mode,
        };
        world.players.set(ws,player);
        playerWorldMap.set(ws,wid);
        wsPlayerMap.set(ws,player);
        // Init mobs if first player
        if(world.players.size===1&&world.mode!=='creative'&&world.mobs.length===0)initWorldMobs(world);
        const others=[];
        for(const[ows,op] of world.players)if(ows!==ws)others.push({username:op.username,x:op.x,y:op.y,facing:op.facing,character:op.character});
        send(ws,{type:'joined',player,others,seed:world.seed,worldEdits:world.edits,mobs:world.mobs,mode:world.mode,worldId:wid,worldName:world.name});
        broadcastWorld(world,{type:'player_join',username:acc.username,x:player.x,y:player.y,character:player.character},ws);
        break;
      }

      // ── PLAYER MOVEMENT ──────────────────────────────────────────────────
      case 'move':{
        const world=getPlayerWorld(ws);if(!world)return;
        const p=world.players.get(ws);if(!p)return;
        p.x=msg.x;p.y=msg.y;p.facing=msg.facing||1;p.anim=msg.anim||'idle';
        broadcastWorld(world,{type:'player_move',username:p.username,x:p.x,y:p.y,facing:p.facing,anim:p.anim},ws);
        break;
      }

      // ── BLOCK EDIT ───────────────────────────────────────────────────────
      case 'set_block':{
        const world=getPlayerWorld(ws);if(!world)return;
        const{x,y,block}=msg;
        const key=`${x},${y}`;
        if(block===0)delete world.edits[key];else world.edits[key]=block;
        broadcastWorld(world,{type:'set_block',x,y,block});
        break;
      }

      // ── MOB HIT ──────────────────────────────────────────────────────────
      case 'mob_hit':{
        const world=getPlayerWorld(ws);if(!world)return;
        const mob=world.mobs.find(m=>m.id===msg.mobId);if(!mob)return;
        mob.hp-=msg.dmg;
        const p=world.players.get(ws);
        broadcastWorld(world,{type:'mob_hit',mobId:msg.mobId,hp:mob.hp,maxHp:mob.maxHp,attacker:p?.username||'?'});
        break;
      }

      // ── PLAYER HIT (PvP) ─────────────────────────────────────────────────
      case 'player_hit':{
        const world=getPlayerWorld(ws);if(!world)return;
        const p=world.players.get(ws);if(!p)return;
        // Find target ws
        for(const[tws,tp] of world.players){
          if(tp.username===msg.target){
            send(tws,{type:'player_hit',target:msg.target,dmg:msg.dmg,attacker:p.username,kb:msg.kb});
            break;
          }
        }
        break;
      }

      // ── PLAYER DIED ──────────────────────────────────────────────────────
      case 'player_died':{
        const world=getPlayerWorld(ws);if(!world)return;
        const p=world.players.get(ws);if(!p)return;
        broadcastWorld(world,{type:'player_died',username:p.username,killer:msg.killer});
        break;
      }

      // ── SAVE DATA ────────────────────────────────────────────────────────
      case 'save_data':{
        if(!acc)return;
        if(msg.inventory!==undefined)acc.inventory=msg.inventory;
        if(msg.hotbar)acc.hotbar=msg.hotbar;
        if(msg.armor)acc.armor=msg.armor;
        if(msg.character)acc.character=msg.character;
        if(msg.spawnX!==undefined)acc.spawnX=msg.spawnX;
        if(msg.spawnY!==undefined)acc.spawnY=msg.spawnY;
        saveAccounts();
        break;
      }

      // ── VOICE SIGNAL (WebRTC signaling for voice chat) ───────────────────
      case 'voice_offer':
      case 'voice_answer':
      case 'voice_ice':{
        const world=getPlayerWorld(ws);if(!world)return;
        const p=world.players.get(ws);if(!p)return;
        // Forward to target peer
        for(const[tws,tp] of world.players){
          if(tp.username===msg.target){
            send(tws,{...msg,from:p.username});break;
          }
        }
        break;
      }
      case 'voice_join':{
        // Tell all players in world this person has voice enabled
        const world=getPlayerWorld(ws);if(!world)return;
        const p=world.players.get(ws);if(!p)return;
        broadcastWorld(world,{type:'voice_joined',username:p.username},ws);
        // Tell new joiner about existing voice users
        for(const[tws,tp] of world.players){
          if(tws!==ws)send(ws,{type:'voice_joined',username:tp.username});
        }
        break;
      }
      case 'voice_leave':{
        const world=getPlayerWorld(ws);if(!world)return;
        const p=world.players.get(ws);if(!p)return;
        broadcastWorld(world,{type:'voice_left',username:p.username});
        break;
      }

      // ── CHAT ─────────────────────────────────────────────────────────────
      case 'chat':{
        const world=getPlayerWorld(ws);if(!world)return;
        const p=world.players.get(ws);if(!p)return;
        broadcastWorld(world,{type:'chat',username:p.username,text:String(msg.text).slice(0,120)});
        break;
      }
    }
  });

  ws.on('close',()=>{leaveWorld(ws);});
});

function getPlayerWorld(ws){
  const wid=playerWorldMap.get(ws);
  return wid?worlds.get(wid):null;
}

function leaveWorld(ws){
  const wid=playerWorldMap.get(ws);
  if(!wid)return;
  const world=worlds.get(wid);
  if(world){
    const p=world.players.get(ws);
    if(p){
      broadcastWorld(world,{type:'player_leave',username:p.username});
      broadcastWorld(world,{type:'voice_left',username:p.username});
      world.players.delete(ws);
      // If personal world has no players, save edits
      if(world.owner!=='system'&&world.players.size===0){
        savePersonalWorldEdits(world.owner,world.edits);
      }
    }
  }
  playerWorldMap.delete(ws);
  wsPlayerMap.delete(ws);
}

const PORT=process.env.PORT||3000;
httpServer.listen(PORT,()=>console.log(`TerraCraft running on :${PORT}`));
