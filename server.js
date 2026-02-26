// ═══════════════════════════════════════════════════════
//  TOWER WARS — Serveur multijoueur
// ═══════════════════════════════════════════════════════
'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// Servir les fichiers statiques du dossier public/
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════
//  CONSTANTES
// ═══════════════════════════════════════════════════════
const SUITS = ['hearts', 'diamonds', 'spades', 'clubs'];
const VALS  = [2,3,4,5,6,7,8,9,10,11,12,13,14];

// ═══════════════════════════════════════════════════════
//  SALLES
// ═══════════════════════════════════════════════════════
const rooms = new Map(); // code -> room

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function makeRoom(hostId, hostName) {
  let code;
  do { code = generateCode(); } while (rooms.has(code));
  const room = {
    code,
    host: hostId,
    players: [{ id: hostId, name: hostName.trim(), index: 0 }],
    options: { pactEnabled: false, pactBreach: 'block' },
    state: null,
    started: false
  };
  rooms.set(code, room);
  return room;
}

function getRoomInfo(room) {
  return {
    code:    room.code,
    host:    room.host,
    players: room.players.map(p => ({ id: p.id, name: p.name, index: p.index })),
    options: room.options
  };
}

// ═══════════════════════════════════════════════════════
//  LOGIQUE DE JEU (côté serveur)
// ═══════════════════════════════════════════════════════

function createDeck() {
  const d = [];
  for (const s of SUITS) for (const v of VALS) d.push({ suit: s, val: v });
  return d;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function drawCard(st) {
  if (st.deck.length === 0) {
    if (st.discard.length === 0) return null;
    st.deck   = shuffle([...st.discard]);
    st.discard = [];
  }
  return st.deck.pop();
}

function findCardByValue(st, val) {
  for (let v = val; v >= 1; v--) {
    let idx = st.deck.findIndex(c => c.val === v);
    if (idx >= 0) return st.deck.splice(idx, 1)[0];
    idx = st.discard.findIndex(c => c.val === v);
    if (idx >= 0) return st.discard.splice(idx, 1)[0];
  }
  return null;
}

function addLog(st, msg, type) {
  st.log.push({ msg, type, ts: Date.now() });
  if (st.log.length > 120) st.log = st.log.slice(-120);
}

function canProposePact(st, p) {
  if (!st.pactEnabled)       return false;
  if (p.towers.length !== 1) return false;
  if (p.pact)                return false;
  return true;
}

function isPactProtected(st, attacker, target) {
  if (!st.pactEnabled) return false;
  if (target.pact   && target.pact.withId   === attacker.id) return true;
  if (attacker.pact && attacker.pact.withId === target.id)   return true;
  return false;
}

function autoDistribute(st, target, dmg) {
  let rem = dmg;
  const sorted = [...target.towers].sort((a, b) => b.val - a.val);
  for (const card of sorted) {
    if (rem <= 0) break;
    const idx = target.towers.indexOf(card);
    if (idx < 0) continue;
    const d  = Math.min(rem, card.val);
    st.discard.push(card);
    const nv = card.val - d;
    if (nv > 0) {
      const r = findCardByValue(st, nv);
      target.towers[idx] = r || { suit: 'spades', val: nv, virtual: true };
    } else {
      target.towers.splice(idx, 1);
    }
    rem -= d;
  }
}

function checkElimination(st) {
  for (const p of st.players) {
    if (!p.eliminated && p.towers.length === 0) {
      p.eliminated = true;
      if (p.defense) { st.discard.push(p.defense); p.defense = null; }
      if (p.charged) { st.discard.push(p.charged); p.charged = null; }
      addLog(st, `💀 <strong>${p.name}</strong> est éliminé(e) !`, 'eli');
    }
  }
}

function advanceTurn(st) {
  // Décrémenter les pactes
  if (st.pactEnabled) {
    for (const p of st.players) {
      if (p.pact) {
        p.pact.turnsLeft--;
        if (p.pact.turnsLeft <= 0) {
          const ally = st.players.find(q => q.id === p.pact.withId);
          addLog(st, `🤝 Pacte entre <strong>${p.name}</strong> et <strong>${ally ? ally.name : '?'}</strong> expiré.`, '');
          if (ally && ally.pact && ally.pact.withId === p.id) ally.pact = null;
          p.pact = null;
        }
      }
    }
  }

  const n = st.players.length;
  st.turn = (st.turn + 1) % n;
  let tries = 0;
  while (st.players[st.turn].eliminated && tries < n) {
    st.turn = (st.turn + 1) % n;
    tries++;
  }
  st.turnNumber++;

  const alive = st.players.filter(p => !p.eliminated);
  if (alive.length <= 1) {
    st.phase  = 'ended';
    st.winner = alive[0] || null;
    st.drawnCard = null;
    addLog(st, `🏆 <strong>${st.winner ? st.winner.name : '???'}</strong> remporte la partie !`, 'eli');
    return;
  }

  // Piocher automatiquement pour le joueur suivant
  const cur = st.players[st.turn];
  st.drawnCard = drawCard(st);
  addLog(st, `<span style="font-size:10px;color:#2a2a3a">T${st.turnNumber}</span> — <strong>${cur.name}</strong> pioche`, '');
}

function initGameState(room) {
  const deck = shuffle(createDeck());

  const players = room.players.map((p, i) => {
    const pool = [];
    for (let j = 0; j < 4; j++) { const c = deck.pop(); if (c) pool.push(c); }
    pool.sort((a, b) => b.val - a.val);
    const towers  = pool.slice(0, 2);
    const discard = pool.slice(2);
    const defense = deck.pop();
    return {
      id:           p.id,
      name:         p.name,
      index:        i,
      towers,
      defense,
      charged:      null,
      eliminated:   false,
      disconnected: false,
      pact:         null
    };
  });

  // Défausser les cartes excédentaires de la mise en place
  const setupDiscard = players.flatMap((p, i) => {
    const pool = [];
    for (let j = 0; j < 4; j++) {
      // Already dealt above — this is just for the discard pile logic
    }
    return [];
  });

  // Joueur de départ : tours les plus faibles
  let minHP = Infinity, firstTurn = 0;
  players.forEach((p, i) => {
    const hp = p.towers.reduce((s, t) => s + t.val, 0);
    if (hp < minHP) { minHP = hp; firstTurn = i; }
  });

  const st = {
    deck,
    discard: [],
    players,
    turn:       firstTurn,
    turnNumber: 1,
    phase:      'action', // 'action' | 'ended'
    drawnCard:  null,
    pactEnabled: room.options.pactEnabled,
    pactBreach:  room.options.pactBreach,
    log:    [],
    winner: null
  };

  addLog(st, `🎲 <strong>${players[firstTurn].name}</strong> commence (tours les plus faibles : ${minHP} PV)`, 'eli');

  // Piocher la première carte
  st.drawnCard = drawCard(st);
  addLog(st, `<span style="font-size:10px;color:#2a2a3a">T1</span> — <strong>${players[firstTurn].name}</strong> pioche`, '');

  return st;
}

// ─── Traiter une action joueur ───────────────────────────────────────────────
function processAction(st, playerId, action) {
  if (st.phase === 'ended') return { error: 'La partie est terminée' };

  const curPlayer = st.players[st.turn];
  if (curPlayer.id !== playerId) return { error: "Ce n'est pas votre tour" };
  if (!st.drawnCard) return { error: 'Aucune carte piochée' };

  const p = curPlayer;
  const { type, targetId } = action;

  // ── Rompre un pacte (hors tour normal) ──────────────────────────────────
  if (type === 'break_pact') {
    if (!p.pact) return { error: "Vous n'êtes pas sous pacte" };
    const other = st.players.find(q => q.id === p.pact.withId);
    addLog(st, `🤝 <strong>${p.name}</strong> met fin au pacte avec <strong>${other ? other.name : '?'}</strong>.`, '');
    if (other && other.pact && other.pact.withId === p.id) other.pact = null;
    p.pact = null;
    return { ok: true, stateOnly: true }; // no turn advance
  }

  // ── Attaquer ─────────────────────────────────────────────────────────────
  if (type === 'attack') {
    const target = st.players.find(t => t.id === targetId);
    if (!target || target.eliminated) return { error: 'Cible invalide' };
    if (target.id === playerId) return { error: 'Impossible de vous attaquer vous-même' };

    // Rupture de pacte ?
    if (isPactProtected(st, p, target)) {
      if (st.pactBreach === 'block') {
        return { error: "Rupture de pacte bloquée — vous ne pouvez pas attaquer cet allié" };
      } else {
        // penalty : attaquant perd sa défense
        if (p.defense) { st.discard.push(p.defense); p.defense = null; }
        if (target.pact  && target.pact.withId  === p.id) target.pact = null;
        if (p.pact       && p.pact.withId       === target.id) p.pact = null;
        addLog(st, `💔 <strong>${p.name}</strong> brise le pacte avec <strong>${target.name}</strong> — perd sa défense !`, 'chg');
      }
    }

    const totalAtk = st.drawnCard.val + (p.charged ? p.charged.val : 0);
    const defVal   = target.defense ? target.defense.val : 0;
    const banner   = { type: 'attack', attacker: p.name, target: target.name, totalAtk, defVal };

    if (totalAtk <= defVal) {
      addLog(st, `<strong>${p.name}</strong> attaque <strong>${target.name}</strong> avec <strong>${totalAtk}</strong> — 🛡 Bloqué (défense ${defVal})`, 'atk');
      st.discard.push(st.drawnCard); st.drawnCard = null;
      if (p.charged) { st.discard.push(p.charged); p.charged = null; }
      advanceTurn(st);
      return { ok: true, banner: { ...banner, result: 'blocked' } };
    }

    const dmg = totalAtk - defVal;
    if (target.defense) { st.discard.push(target.defense); target.defense = null; }
    if (target.charged) {
      st.discard.push(target.charged); target.charged = null;
      addLog(st, `<strong>${target.name}</strong> perd sa carte chargée !`, 'chg');
    }
    addLog(st, `<strong>${p.name}</strong> attaque <strong>${target.name}</strong> avec <strong>${totalAtk}</strong> — 💥 <strong>${dmg}</strong> dégât${dmg > 1 ? 's' : ''}! (défense ${defVal} détruite)`, 'atk');
    st.discard.push(st.drawnCard); st.drawnCard = null;
    if (p.charged) { st.discard.push(p.charged); p.charged = null; }

    autoDistribute(st, target, dmg);
    checkElimination(st);

    const alive = st.players.filter(q => !q.eliminated);
    if (alive.length > 1) {
      advanceTurn(st);
    } else {
      st.phase  = 'ended';
      st.winner = alive[0] || null;
      st.drawnCard = null;
      addLog(st, `🏆 <strong>${st.winner ? st.winner.name : '???'}</strong> remporte la partie !`, 'eli');
    }
    return { ok: true, banner: { ...banner, result: 'hit', dmg } };
  }

  // ── Défendre ──────────────────────────────────────────────────────────────
  if (type === 'defend') {
    const oldDef = p.defense ? p.defense.val : 0;
    if (p.defense) st.discard.push(p.defense);
    p.defense   = st.drawnCard; st.drawnCard = null;
    if (p.charged) { st.discard.push(p.charged); p.charged = null; }
    addLog(st, `<strong>${p.name}</strong> défend : ${oldDef} → <strong>${p.defense.val}</strong>`, 'def');
    advanceTurn(st);
    return { ok: true, banner: { type: 'defend', player: p.name, from: oldDef, to: p.defense.val } };
  }

  // ── Charger ───────────────────────────────────────────────────────────────
  if (type === 'charge') {
    if (p.charged) st.discard.push(p.charged);
    p.charged    = st.drawnCard; st.drawnCard = null;
    addLog(st, `<strong>${p.name}</strong> charge <strong>${p.charged.val}</strong> pour sa prochaine attaque`, 'chg');
    advanceTurn(st);
    return { ok: true, banner: { type: 'charge', player: p.name, val: p.charged.val } };
  }

  // ── Défausser ─────────────────────────────────────────────────────────────
  if (type === 'discard') {
    st.discard.push(st.drawnCard); st.drawnCard = null;
    addLog(st, `<strong>${p.name}</strong> défausse`, '');
    advanceTurn(st);
    return { ok: true, banner: { type: 'discard', player: p.name } };
  }

  // ── Pacte ─────────────────────────────────────────────────────────────────
  if (type === 'pact') {
    if (!canProposePact(st, p)) return { error: 'Pacte impossible dans cette situation' };
    const target = st.players.find(t => t.id === targetId);
    if (!target || target.eliminated) return { error: 'Cible invalide pour le pacte' };
    if (target.id === playerId) return { error: 'Impossible de se faire un pacte avec soi-même' };
    if (target.pact) return { error: 'Cette cible est déjà sous pacte' };

    p.pact      = { withId: target.id, turnsLeft: 2, role: 'proposer' };
    target.pact = { withId: p.id,      turnsLeft: 2, role: 'protected' };
    addLog(st, `🤝 <strong>${p.name}</strong> propose un pacte à <strong>${target.name}</strong> — 2 tours de trêve !`, '');
    if (st.drawnCard) { st.discard.push(st.drawnCard); st.drawnCard = null; }
    advanceTurn(st);
    return { ok: true, banner: { type: 'pact', from: p.name, to: target.name } };
  }

  return { error: 'Action inconnue' };
}

// ═══════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════
io.on('connection', socket => {
  console.log('+ connecté :', socket.id);

  // ── Créer une salle ──────────────────────────────────────────────────────
  socket.on('create_room', ({ name, options }) => {
    if (!name || !name.trim()) {
      return socket.emit('error', { message: 'Veuillez entrer un nom.' });
    }
    const room = makeRoom(socket.id, name);
    if (options) {
      room.options.pactEnabled = !!options.pactEnabled;
      room.options.pactBreach  = options.pactBreach || 'block';
    }
    socket.join(room.code);
    socket.data.roomCode    = room.code;
    socket.data.playerIndex = 0;
    socket.emit('room_created', { code: room.code, playerIndex: 0 });
    io.to(room.code).emit('room_update', getRoomInfo(room));
  });

  // ── Rejoindre une salle ──────────────────────────────────────────────────
  socket.on('join_room', ({ code, name }) => {
    if (!name || !name.trim()) {
      return socket.emit('error', { message: 'Veuillez entrer un nom.' });
    }
    const room = rooms.get((code || '').toUpperCase().trim());
    if (!room)              return socket.emit('error', { message: 'Salle introuvable. Vérifiez le code.' });
    if (room.started)       return socket.emit('error', { message: 'La partie a déjà commencé.' });
    if (room.players.length >= 4) return socket.emit('error', { message: 'La salle est pleine (4 joueurs max).' });

    const idx = room.players.length;
    room.players.push({ id: socket.id, name: name.trim(), index: idx });
    socket.join(room.code);
    socket.data.roomCode    = room.code;
    socket.data.playerIndex = idx;
    socket.emit('room_joined', { code: room.code, playerIndex: idx });
    io.to(room.code).emit('room_update', getRoomInfo(room));
  });

  // ── Mettre à jour les options (hôte seulement) ───────────────────────────
  socket.on('update_options', (options) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.host !== socket.id) return;
    if (room.started) return;
    room.options.pactEnabled = !!options.pactEnabled;
    room.options.pactBreach  = options.pactBreach || 'block';
    io.to(room.code).emit('room_update', getRoomInfo(room));
  });

  // ── Démarrer la partie (hôte seulement) ─────────────────────────────────
  socket.on('start_game', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.host !== socket.id) return socket.emit('error', { message: "Seul l'hôte peut démarrer la partie." });
    if (room.players.length < 2)  return socket.emit('error', { message: 'Il faut au moins 2 joueurs pour commencer.' });
    if (room.started) return;

    room.started = true;
    room.state   = initGameState(room);
    io.to(room.code).emit('game_start', { state: safeState(room.state) });
  });

  // ── Action de jeu ────────────────────────────────────────────────────────
  socket.on('game_action', action => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.state) return;

    const result = processAction(room.state, socket.id, action);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }
    io.to(room.code).emit('game_state', {
      state:  safeState(room.state),
      banner: result.banner || null
    });
  });

  // ── Déconnexion ──────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('- déconnecté :', socket.id);
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    if (room.started && room.state) {
      const p = room.state.players.find(pl => pl.id === socket.id);
      if (p && !p.eliminated) {
        p.disconnected = true;
        addLog(room.state, `⚠️ <strong>${p.name}</strong> s'est déconnecté(e).`, '');

        // Si c'était son tour, forcer la défausse et passer au suivant
        if (room.state.players[room.state.turn].id === socket.id && room.state.phase === 'action') {
          if (room.state.drawnCard) {
            room.state.discard.push(room.state.drawnCard);
            room.state.drawnCard = null;
          }
          advanceTurn(room.state);
        }
        io.to(code).emit('game_state', { state: safeState(room.state), banner: null });
      }
    } else {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) { rooms.delete(code); return; }
      if (room.host === socket.id)    room.host = room.players[0].id;
      io.to(code).emit('room_update', getRoomInfo(room));
    }
  });
});

// Sérialiser l'état de façon sûre
function safeState(st) {
  return JSON.parse(JSON.stringify(st));
}

server.listen(PORT, () => {
  console.log(`⚔  Tower Wars — serveur sur http://localhost:${PORT}`);
});
