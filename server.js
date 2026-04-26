const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {WebSocketServer}=require('ws');
const DATA=path.join(__dirname,'data');
if(!fs.existsSync(DATA))fs.mkdirSync(DATA,{recursive:true});

const ACC_F=path.join(DATA,'accounts.json');
const WORLD_F=path.join(DATA,'world.json');
const SEED_F=path.join(DATA,'seed.json');

function loadJ(f,d){try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return d;}}
function saveJ(f,d){fs.writeFileSync(f,JSON.stringify(d),'utf8');}

let accounts=loadJ(ACC_F,{});
let worldEdits=loadJ(WORLD_F,{});
const SEED=loadJ(SEED_F,{v:Math.floor(Math.random()*99999)}).v;
saveJ(SEED_F,{v:SEED});

setInterval(()=>{saveJ(WORLD_F,worldEdits);saveJ(ACC_F,accounts);},15000);

function hashPw(pw,salt){return crypto.pbkdf2Sync(pw,salt,10000,64,'sha256').toString('hex');}
function mkSalt(){return crypto.randomBytes(16).toString('hex');}
function mkToken(){return crypto.randomBytes(24).toString('hex');}

const sessions={};
const players=new Map();
// shared mob state
let mobs=[]; // {id,type,x,y,hp,maxHp}
let mobId=0;

function initMobs(){
  for(let i=0;i<40;i++) spawnMob();
}
function spawnMob(){
  const types=['zombie','skeleton','slime','bat','spider','demon','goblin','vampire'];
  const t=types[Math.floor(Math.random()*types.length)];
  const hpMap={zombie:40,skeleton:30,slime:20,bat:15,spider:25,demon:120,goblin:35,vampire:80};
  const x=Math.floor(Math.random()*600)-300;
  mobs.push({id:mobId++,type:t,x,y:40,hp:hpMap[t]||30,maxHp:hpMap[t]||30,vx:0,vy:0});
}
initMobs();

// Mob AI tick (server-authoritative)
setInterval(()=>{
  const pl=[...players.values()];
  if(pl.length===0)return;
  mobs.forEach(mob=>{
    // find nearest player
    let nearest=null,nd=999999;
    pl.forEach(p=>{const d=Math.abs(p.x-mob.x)+Math.abs(p.y-mob.y);if(d<nd){nd=d;nearest=p;}});
    if(nearest&&nd<30){
      const dx=nearest.x-mob.x;
      mob.vx+=(dx>0?1:-1)*0.05;
    } else {
      mob.vx+=(Math.random()-.5)*0.08;
    }
    mob.vx*=0.8;mob.x+=mob.vx;
  });
  // Remove dead mobs, respawn
  mobs=mobs.filter(m=>m.hp>0);
  while(mobs.length<40)spawnMob();
  broadcast({type:'mob_update',mobs:mobs.map(m=>({id:m.id,type:m.type,x:m.x,y:m.y,hp:m.hp,maxHp:m.maxHp}))});
},200);

const httpServer=http.createServer((req,res)=>{
  const f=path.join(__dirname,'client.html');
  fs.readFile(f,(err,d)=>{
    if(err){res.writeHead(404);res.end('not found');return;}
    res.writeHead(200,{'Content-Type':'text/html'});res.end(d);
  });
});

const wss=new WebSocketServer({server:httpServer});
function broadcast(data,except=null){
  const m=JSON.stringify(data);
  for(const[ws]of players){if(ws!==except&&ws.readyState===1)ws.send(m);}
}
function send(ws,data){if(ws.readyState===1)ws.send(JSON.stringify(data));}

wss.on('connection',ws=>{
  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    switch(msg.type){
      case 'register':{
        const{username,password}=msg;
        if(!username||!password||username.length<2||password.length<4)
          return send(ws,{type:'auth_fail',reason:'Username ≥2, password ≥4 chars'});
        if(accounts[username.toLowerCase()])
          return send(ws,{type:'auth_fail',reason:'Username taken'});
        const salt=mkSalt(),hash=hashPw(password,salt);
        accounts[username.toLowerCase()]={username,salt,hash,createdAt:Date.now(),
          inventory:{},hotbar:[0,0,0,0,0,0,0,0,0],
          armor:{head:0,chest:0,legs:0,feet:0},
          character:{skin:'default',hair:'brown',shirt:'blue'},
          spawnX:0,spawnY:40};
        saveJ(ACC_F,accounts);
        const token=mkToken();sessions[token]=username.toLowerCase();
        send(ws,{type:'auth_ok',token,username,account:accounts[username.toLowerCase()]});
        break;
      }
      case 'login':{
        const{username,password}=msg;
        const acc=accounts[username?.toLowerCase()];
        if(!acc)return send(ws,{type:'auth_fail',reason:'Account not found'});
        if(hashPw(password,acc.salt)!==acc.hash)return send(ws,{type:'auth_fail',reason:'Wrong password'});
        const token=mkToken();sessions[token]=username.toLowerCase();
        send(ws,{type:'auth_ok',token,username:acc.username,account:acc});
        break;
      }
      case 'join':{
        const ukey=sessions[msg.token];
        if(!ukey)return send(ws,{type:'error',reason:'Bad session'});
        const acc=accounts[ukey];
        const player={username:acc.username,x:acc.spawnX||0,y:acc.spawnY||40,
          facing:1,anim:'idle',character:acc.character||{skin:'default',hair:'brown',shirt:'blue'}};
        players.set(ws,player);
        const others=[];
        for(const[ows,op]of players)if(ows!==ws)others.push({username:op.username,x:op.x,y:op.y,facing:op.facing,character:op.character});
        send(ws,{type:'joined',player,others,seed:SEED,worldEdits,mobs});
        broadcast({type:'player_join',username:acc.username,x:player.x,y:player.y,character:player.character},ws);
        break;
      }
      case 'move':{
        const p=players.get(ws);if(!p)return;
        p.x=msg.x;p.y=msg.y;p.facing=msg.facing||1;p.anim=msg.anim||'idle';
        broadcast({type:'player_move',username:p.username,x:p.x,y:p.y,facing:p.facing,anim:p.anim},ws);
        break;
      }
      case 'set_block':{
        const p=players.get(ws);if(!p)return;
        const{x,y,block}=msg;
        const key=`${x},${y}`;
        if(block===0)delete worldEdits[key]; else worldEdits[key]=block;
        broadcast({type:'set_block',x,y,block});
        break;
      }
      case 'mob_hit':{
        const mob=mobs.find(m=>m.id===msg.mobId);
        if(!mob)return;
        mob.hp-=msg.dmg;
        if(mob.hp<=0){mob.hp=0;}
        broadcast({type:'mob_hit',mobId:msg.mobId,hp:mob.hp,maxHp:mob.maxHp,attacker:players.get(ws)?.username});
        break;
      }
      case 'player_hit':{
        const p=players.get(ws);if(!p)return;
        broadcast({type:'player_hit',target:msg.target,dmg:msg.dmg,attacker:p.username,kb:msg.kb},ws);
        send(ws,{type:'player_hit',target:msg.target,dmg:msg.dmg,attacker:p.username,kb:msg.kb});
        break;
      }
      case 'player_died':{
        const p=players.get(ws);if(!p)return;
        broadcast({type:'player_died',username:p.username,killer:msg.killer});
        break;
      }
      case 'save_data':{
        const ukey=sessions[msg.token];if(!ukey)return;
        const acc=accounts[ukey];
        if(msg.inventory)acc.inventory=msg.inventory;
        if(msg.hotbar)acc.hotbar=msg.hotbar;
        if(msg.armor)acc.armor=msg.armor;
        if(msg.character)acc.character=msg.character;
        if(msg.spawnX!==undefined)acc.spawnX=msg.spawnX;
        if(msg.spawnY!==undefined)acc.spawnY=msg.spawnY;
        saveJ(ACC_F,accounts);
        break;
      }
      case 'chat':{
        const p=players.get(ws);if(!p)return;
        broadcast({type:'chat',username:p.username,text:String(msg.text).slice(0,120)});
        break;
      }
    }
  });
  ws.on('close',()=>{
    const p=players.get(ws);
    if(p){broadcast({type:'player_leave',username:p.username});players.delete(ws);}
  });
});

const PORT=process.env.PORT||3000;
httpServer.listen(PORT,()=>console.log(`TerraCraft running on port ${PORT}`));
