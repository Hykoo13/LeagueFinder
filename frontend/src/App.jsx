import { useState, useEffect, useRef, useMemo } from 'react';
import io from 'socket.io-client';
import { useGameSocket } from './useGameSocket';
import './App.css';

// Randomly placed poros in the background
// Randomly placed poros with minimum spacing
function generatePoros(count, minDist = 18) {
  const placed = [];
  let attempts = 0;
  while (placed.length < count && attempts < count * 50) {
    attempts++;
    const topN = Math.random() * 88;
    const leftN = Math.random() * 90;
    const tooClose = placed.some(p =>
      Math.hypot(p.topN - topN, p.leftN - leftN) < minDist
    );
    if (!tooClose) {
      placed.push({
        id: placed.length,
        topN, leftN,
        top: `${topN.toFixed(1)}%`,
        left: `${leftN.toFixed(1)}%`,
        rotate: Math.floor(Math.random() * 360),
        size: 55 + Math.floor(Math.random() * 50),
        opacity: 0.06 + Math.random() * 0.08,
      });
    }
  }
  return placed;
}
const POROS = generatePoros(20);

function PoroBg() {
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
      {POROS.map(p => (
        <img
          key={p.id}
          src="/poro.png"
          alt=""
          style={{
            position: 'absolute',
            top: p.top,
            left: p.left,
            width: p.size,
            opacity: p.opacity,
            transform: `rotate(${p.rotate}deg)`,
            userSelect: 'none',
          }}
        />
      ))}
    </div>
  );
}

// We initialize socket outside component to prevent multiple connections on re-render.
// In a real app we might put this in a Context.
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
const socket = io(BACKEND_URL);

function App() {
  const [gameState, setGameState] = useState({
    isConnected: false,
    user: null, // { userId, username, friends, pendingInvites }
    currentRoom: null // Room object
  });

  const [notifications, setNotifications] = useState([]);

  useEffect(() => {
    const handleNotify = (e) => {
      const msg = e.detail;
      const id = Date.now() + Math.random(); // Ensure unique ID even if fired simultaneously
      setNotifications(prev => [...prev, { id, msg }]);
      setTimeout(() => {
        setNotifications(prev => prev.filter(n => n.id !== id));
      }, 5000);
    };

    window.addEventListener('notify_user', handleNotify);
    return () => window.removeEventListener('notify_user', handleNotify);
  }, []);

  useGameSocket(socket, setGameState);

  const goHome = () => {
    if (gameState.currentRoom) {
      socket.emit("leave_room", () => {
        setGameState(prev => ({ ...prev, currentRoom: null }));
      });
    }
  };

  // Temporary simple router based on state
  const renderView = () => {
    if (!gameState.isConnected || !gameState.user) {
      return <div>Connecting to server...</div>;
    }

    if (!gameState.currentRoom) {
      return <HomeView socket={socket} user={gameState.user} />;
    }

    if (gameState.currentRoom.state === "LOBBY") {
      return <LobbyView socket={socket} room={gameState.currentRoom} user={gameState.user} />;
    }

    if (gameState.currentRoom.state === "PLAYING") {
      return <GameView socket={socket} room={gameState.currentRoom} user={gameState.user} />;
    }

    if (gameState.currentRoom.state === "END") {
      return <EndView socket={socket} room={gameState.currentRoom} user={gameState.user} />;
    }
  };

  return (
    <div className="App">
      <PoroBg />
      <div className="toast-container">
        {notifications.map(n => (
          <div key={n.id} className="toast">
            {n.msg}
          </div>
        ))}
      </div>
      <header>
        <h2 onClick={goHome} style={{ cursor: 'pointer', display: 'inline-block' }}>LeagueFinder</h2>
        {gameState.user && <div className="user-info">Connecté en tant que : {gameState.user.username}</div>}
      </header>
      <main>
        {renderView()}
      </main>
    </div>
  )
}

// ==== PLACEHOLDER VIEWS (To be moved to separate files later) ====

function HomeView({ socket, user }) {
  const [roomCode, setRoomCode] = useState("");
  const [friendInvite, setFriendInvite] = useState("");
  const [newUsername, setNewUsername] = useState(user.username);
  const [isEditingName, setIsEditingName] = useState(false);

  const [isAddingFriend, setIsAddingFriend] = useState(false);

  // ... (existing saveUsername, createRoom, joinRoom, addFriend)

  const saveUsername = () => {
    if (!newUsername.trim()) return;
    socket.emit("update_username", { username: newUsername }, (res) => {
      if (res.status === "success") {
        localStorage.setItem("username", res.username);
        setIsEditingName(false);
      } else {
        alert(res.message);
      }
    });
  };

  const createRoom = () => {
    socket.emit("create_room", (res) => {
      if (res.status === "error") {
        alert(res.message);
      } else if (res.status === "success" && res.roomId) {
        joinRoom(res.roomId);
      }
    });
  };

  const joinRoom = (code) => {
    if (!code) return;
    socket.emit("join_room", { roomId: code.toUpperCase() }, (res) => {
      if (res.status === "error") alert(res.message);
    });
  };

  const addFriend = () => {
    if (!friendInvite.trim()) return;
    socket.emit("add_friend", { friendId: friendInvite.trim() }, (res) => {
      if (res.status === "success") {
        window.dispatchEvent(new CustomEvent('notify_user', { detail: `Demande d'ami envoyée à ${res.friend.username} !` }));
        window.dispatchEvent(new CustomEvent('add_friend_local', { detail: res.friend }));
        setFriendInvite("");
      } else {
        window.dispatchEvent(new CustomEvent('notify_user', { detail: `Erreur: ${res.message}` }));
      }
    });
  };

  return (
    <div className="view home-view home-layout">

      {/* MAIN CONTENT (PLAY) */}
      <div className="home-main">
        <div className="card play-card">
          <h2 style={{ fontSize: "2rem", marginBottom: "20px" }}>Jouer</h2>
          <button className="btn-primary btn-large" onClick={createRoom}>Créer un Salon</button>

          <div className="divider">ou</div>

          <div className="input-group" style={{ justifyContent: "center" }}>
            <input
              value={roomCode}
              onChange={e => setRoomCode(e.target.value)}
              placeholder="Code du Salon (ABCD)"
              maxLength={4}
              style={{ textAlign: "center", fontSize: "1.2rem", maxWidth: "250px" }}
            />
            <button className="btn-primary" onClick={() => joinRoom(roomCode)}>Rejoindre</button>
          </div>
        </div>
      </div>

      {/* SIDEBAR (PROFILE & FRIENDS) */}
      <div className="home-sidebar">

        {/* Profile Section */}
        <div className="card" style={{ marginBottom: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <h3 style={{ margin: 0 }}>Votre Profil</h3>
            {!isEditingName && <button className="btn-primary" onClick={() => setIsEditingName(true)} style={{ padding: "6px 14px", fontSize: "0.85rem" }}>Modifier</button>}
          </div>

          {isEditingName ? (
            <div className="input-group">
              <input value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder="Pseudo" maxLength={15} />
              <button className="btn-primary" onClick={saveUsername}>Sauvegarder</button>
            </div>
          ) : (
            <div>
              <p style={{ margin: 0, fontSize: "1.3rem", fontWeight: "600" }}>{user.username}</p>
              <p className="text-muted" style={{ margin: "5px 0 0 0", fontSize: "0.85rem" }}>ID: {user.userId}</p>
            </div>
          )}
        </div>

        {/* Friends Section */}
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "15px" }}>
            <h3 style={{ margin: 0 }}>Amis & Invs</h3>
            <button className="btn-primary" onClick={() => setIsAddingFriend(!isAddingFriend)} style={{ padding: "4px 12px", borderRadius: "8px", fontSize: "1.2rem" }}>+</button>
          </div>

          {isAddingFriend && (
            <div className="input-group" style={{ marginBottom: "15px", animation: "slideIn 0.2s ease-out" }}>
              <input value={friendInvite} onChange={e => setFriendInvite(e.target.value)} placeholder="ID de l'ami" />
              <button className="btn-primary" onClick={() => { addFriend(); setIsAddingFriend(false); }}>Ajouter</button>
            </div>
          )}

          {user.pendingInvites && user.pendingInvites.length > 0 && (
            <div className="invites-list" style={{ marginBottom: "20px" }}>
              <h4 style={{ color: "var(--primary)" }}>Invitations en attente</h4>
              {user.pendingInvites.map((inv, idx) => (
                <div key={idx} className="invite-item" style={{ flexDirection: "column", alignItems: "flex-start", gap: "8px" }}>
                  <span><strong>{inv.fromUsername}</strong> vous a invité</span>
                  <div style={{ display: "flex", gap: "8px", width: "100%" }}>
                    <button className="btn-primary" onClick={() => joinRoom(inv.roomId)} style={{ padding: "6px 12px", flex: 1 }}>Rejoindre</button>
                    <button className="btn-danger" onClick={() => socket.emit("decline_invite", { roomId: inv.roomId })} style={{ padding: "6px 12px", flex: 1 }}>Refuser</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="friends-list">
            <h4>Vos Amis</h4>
            {user.friends && user.friends.length > 0 ? (
              user.friends.map(f => (
                <div key={f.userId} className={`friend-item ${f.online ? "online" : "offline"}`}>
                  <span style={{ fontWeight: "500" }}>{f.username}</span>
                  <span>{f.online ? "🟢" : "🔴"}</span>
                </div>
              ))
            ) : (
              <p className="text-muted" style={{ fontStyle: "italic" }}>Pas encore d'amis. Cliquez sur le bouton + pour en ajouter !</p>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

function LobbyView({ socket, room, user }) {
  const isHost = room.hostId === user.userId;
  const categories = ["champions", "items", "lol", "esport", "streamers"];

  const [dictionary, setDictionary] = useState(null);

  useEffect(() => {
    fetch(`${BACKEND_URL}/dictionary`)
      .then(r => r.json())
      .then(setDictionary)
      .catch(() => { }); // fail silently
  }, []);

  const toggleCategory = (cat) => {
    if (!isHost) return;
    socket.emit("toggle_category", { roomId: room.roomId, category: cat });
  };

  const startGame = () => {
    socket.emit("start_game", { roomId: room.roomId });
  };

  const inviteFriend = (friendId) => {
    socket.emit("invite_friend", { friendId, roomId: room.roomId }, (res) => {
      if (res && res.status === "success") {
        window.dispatchEvent(new CustomEvent('notify_user', { detail: "Invitation envoyée !" }));
      }
    });
  };

  return (
    <div className="view lobby-view home-layout">
      {/* MAIN CONTENT (PLAYERS & CATEGORIES & START) */}
      <div className="home-main">
        <div style={{ width: "100%", maxWidth: "500px" }}>
          <div className="room-header" style={{ textAlign: "center", marginBottom: "20px" }}>
            <h2>Salon : <span className="highlight">{room.roomId}</span></h2>
            <p className="text-muted">En attente de joueurs...</p>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Joueurs</h3>
            <ul style={{ listStyleType: "none", padding: 0, margin: 0 }}>
              {room.players.map(p => (
                <li key={p.id} style={{ padding: "8px 12px", background: "rgba(0,0,0,0.2)", borderRadius: "8px", marginBottom: "8px", display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 500 }}>{p.name}</span>
                  <span>{p.id === room.hostId && "👑 Host"}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="settings-card card">
            <h3 style={{ marginTop: 0 }}>Catégories</h3>
            <div className="categories-list">
              {categories.map(cat => (
                <div key={cat} className="category-wrapper">
                  <label className={`category-toggle ${room.settings.activeCategories.includes(cat) ? "active" : ""}`}>
                    <input
                      type="checkbox"
                      checked={room.settings.activeCategories.includes(cat)}
                      onChange={() => toggleCategory(cat)}
                      disabled={!isHost}
                    />
                    {cat.replace(/_/g, " ")}
                  </label>
                  {dictionary && dictionary[cat] && (
                    <div className="cat-tooltip">
                      <p style={{ margin: "0 0 8px 0", fontWeight: 700, color: "var(--primary)", fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "1px" }}>
                        {cat} ({dictionary[cat].length} mots)
                      </p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                        {dictionary[cat].map((word, i) => (
                          <span key={i} style={{ fontSize: "0.78rem", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "6px", padding: "2px 7px", color: "#e2e8f0" }}>
                            {word}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {isHost && (
            <div className="host-actions" style={{ marginBottom: "20px", textAlign: "center" }}>
              <button className="btn-primary" onClick={startGame} style={{ padding: "12px 30px", fontSize: "1.1rem" }}>
                Lancer la partie
              </button>
            </div>
          )}
        </div>
      </div>

      {/* SIDEBAR (FRIENDS TO INVITE) */}
      <div className="home-sidebar">
        <div className="invite-friends card">
          <h3 style={{ marginTop: 0, marginBottom: "15px" }}>Amis & Invitations</h3>
          <div className="friends-list">
            {(() => {
              const invitableFriends = user.friends ? user.friends.filter(f => !room.players.some(p => p.id === f.userId)) : [];
              return invitableFriends.length > 0 ? (
                invitableFriends.map(f => (
                  <div key={f.userId} className={`friend-item ${f.online ? "online" : "offline"}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ fontWeight: "500" }}>{f.username}</span>
                      <span style={{ marginLeft: "8px", fontSize: "0.8rem" }}>{f.online ? "🟢" : "🔴"}</span>
                    </div>
                    <button
                      className="btn-primary"
                      onClick={() => inviteFriend(f.userId)}
                      disabled={!f.online}
                      style={{ padding: "4px 10px", fontSize: "0.85rem" }}
                    >
                      Inviter
                    </button>
                  </div>
                ))
              ) : (
                <p className="text-muted" style={{ fontStyle: "italic" }}>Aucun ami disponible à inviter.</p>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}

function GameView({ socket, room, user }) {
  const gs = room.gameState;
  const isSpeaker = gs.currentSpeakerId === user.userId;
  const speakerName = room.players.find(p => p.id === gs.currentSpeakerId)?.name;

  // Local state for the typed guess and clue
  const [guessInput, setGuessInput] = useState("");
  const [clueInput, setClueInput] = useState("");

  const guessInputRef = useRef(null);
  const clueInputRef = useRef(null);

  // Auto-focus inputs when it becomes your turn
  useEffect(() => {
    if (gs.turnActive) {
      if (isSpeaker && gs.subTurn === "CLUE" && clueInputRef.current) {
        clueInputRef.current.focus();
      } else if (!isSpeaker && gs.subTurn === "GUESS" && guessInputRef.current) {
        guessInputRef.current.focus();
      }
    }
  }, [gs.turnActive, gs.subTurn, isSpeaker]);

  const submitGuess = (e) => {
    e.preventDefault();
    if (!guessInput.trim()) return;
    socket.emit("word_guessed", { roomId: room.roomId, typedWord: guessInput });
    setGuessInput("");
  };

  const submitClue = (e) => {
    e.preventDefault();
    if (!clueInput.trim()) return;
    socket.emit("send_clue", { roomId: room.roomId, clueText: clueInput }, (res) => {
      if (res.status === "error") {
        window.dispatchEvent(new CustomEvent('notify_user', { detail: res.message }));
      }
      setClueInput("");
    });
  };

  // Keep manual skip for speaker
  const speakerSkip = () => {
    socket.emit("speaker_skip", { roomId: room.roomId });
  };

  const nextTurn = () => {
    socket.emit("next_turn", { roomId: room.roomId });
  };

  return (
    <div className="view game-view">
      <div className="score-board" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative" }}>
        <div className="players-scores" style={{ display: "flex", gap: "15px" }}>
          {room.players.map(p => (
            <div key={p.id} className="player-score">
              {p.name}: {p.score || 0}
            </div>
          ))}
        </div>

        <div className="word-progress highlight" style={{ fontSize: "1.5rem", position: "absolute", left: "50%", transform: "translateX(-50%)" }}>
          {gs.wordStats ? gs.wordStats.length + 1 : 1}/10
        </div>

        <div className="timer-display highlight">{gs.timeRemaining}s</div>
      </div>

      <div className="game-area card">
        {!gs.turnActive ? (
          <div className="turn-prep">
            <h3>Tour Terminé</h3>
            <p>Préparez-vous ! Au tour de : <strong>{speakerName}</strong></p>
            {room.hostId === user.userId && (
              <button className="btn-primary" onClick={nextTurn}>Lancer le chrono</button>
            )}
          </div>
        ) : (
          <div className="turn-active">
            {isSpeaker ? (
              <div className="speaker-view" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "24px", maxWidth: "560px", margin: "0 auto" }}>
                <div style={{ textAlign: "center" }}>
                  <p className="instruction" style={{ marginBottom: "10px" }}>Faites deviner ce mot :</p>
                  <h1 className="word-to-guess">{gs.currentWord}</h1>
                </div>

                <form onSubmit={submitClue} className="guess-form" style={{ width: "100%" }}>
                  <div className="input-group">
                    <input
                      ref={clueInputRef}
                      value={clueInput}
                      onChange={e => setClueInput(e.target.value)}
                      placeholder={gs.subTurn === "CLUE" ? "Donnez un indice (12 car. max)..." : "L'équipe réfléchit..."}
                      maxLength={12}
                      disabled={gs.subTurn !== "CLUE"}
                    />
                    <button type="submit" className="btn-primary" disabled={gs.subTurn !== "CLUE"}>
                      Envoyer Indice
                    </button>
                  </div>
                  {gs.subTurn === "CLUE" ? (
                    <p className="text-muted" style={{ fontSize: "0.8rem", marginTop: "6px", textAlign: "center" }}>Ne doit pas trop ressembler au mot.</p>
                  ) : (
                    <p style={{ color: "var(--warning)", fontSize: "0.9rem", fontWeight: "bold", marginTop: "6px", textAlign: "center" }}>Attendez qu'ils devinent !</p>
                  )}
                </form>

                {gs.clues && gs.clues.length > 0 && (
                  <div className="history-list card" style={{ width: "100%", padding: "16px 20px", background: "rgba(0,0,0,0.2)" }}>
                    <h4 style={{ margin: "0 0 12px 0", textAlign: "center" }}>Historique du tour :</h4>
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      {gs.clues.map((clue, idx) => (
                        <div key={idx} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "15px" }}>
                          <span className="clue-badge" style={{ minWidth: "120px", textAlign: "center" }}>{clue}</span>
                          <span style={{ color: "var(--primary)", fontWeight: "bold" }}>➔</span>
                          {gs.guesses && gs.guesses[idx] ? (
                            <span className="guess-badge" style={{ minWidth: "120px", textAlign: "center", textDecoration: "line-through", opacity: 0.7 }}>{gs.guesses[idx]}</span>
                          ) : (
                            <span className="text-muted" style={{ minWidth: "120px", textAlign: "center", fontStyle: "italic", fontSize: "0.9rem" }}>En attente...</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <button className="btn-primary" onClick={speakerSkip}>Passer le mot</button>
              </div>
            ) : (
              <div className="guesser-view">
                <p className="instruction">Tapez vos réponses ici !</p>
                <h2>Écoutez {speakerName}</h2>

                {gs.clues && gs.clues.length > 0 && (
                  <div className="history-list card" style={{ margin: "20px auto", maxWidth: "500px", padding: "15px", background: "rgba(0,0,0,0.2)" }}>
                    <h4 style={{ marginBottom: "15px", textAlign: "center" }}>Historique du tour :</h4>
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      {gs.clues.map((clue, idx) => (
                        <div key={idx} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "15px" }}>
                          <span className="clue-badge" style={{ minWidth: "120px", textAlign: "center" }}>{clue}</span>
                          <span style={{ color: "var(--primary)", fontWeight: "bold" }}>➔</span>
                          {gs.guesses && gs.guesses[idx] ? (
                            <span className="guess-badge" style={{ minWidth: "120px", textAlign: "center", textDecoration: "line-through", opacity: 0.7 }}>{gs.guesses[idx]}</span>
                          ) : (
                            <span className="text-muted" style={{ minWidth: "120px", textAlign: "center", fontStyle: "italic", fontSize: "0.9rem" }}>En attente...</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <form onSubmit={submitGuess} className="guess-form">
                  <div className="input-group">
                    <input
                      ref={guessInputRef}
                      autoFocus
                      value={guessInput}
                      onChange={e => setGuessInput(e.target.value)}
                      placeholder={gs.subTurn === "GUESS" ? "Tapez un mot..." : "En attente d'un indice..."}
                      disabled={gs.subTurn !== "GUESS"}
                      style={{ opacity: gs.subTurn !== "GUESS" ? 0.6 : 1 }}
                    />
                    <button type="submit" className="btn-primary" disabled={gs.subTurn !== "GUESS"}>Valider</button>
                  </div>
                  {gs.subTurn === "CLUE" && (
                    <p style={{ color: "var(--primary)", fontSize: "0.9rem", fontWeight: "bold", marginTop: "10px" }}>
                      L'orateur tape un indice...
                    </p>
                  )}
                </form>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EndView({ socket, room, user }) {
  const gs = room.gameState;
  const isHost = room.hostId === user.userId;

  const returnToLobby = () => {
    // We could emit a new 'return_lobby' event, but a simple way is recreating the room structure 
    // or just firing a custom event we need to build in backend.
    // Let's assume we can reuse createRoom logic or send a return event.
    socket.emit("return_lobby", { roomId: room.roomId });
  };

  return (
    <div className="view end-view home-layout">
      <div className="home-main" style={{ width: "100%", maxWidth: "600px", margin: "0 auto" }}>
        <div className="card" style={{ textAlign: "center" }}>
          <h2 style={{ fontSize: "2.5rem", marginBottom: "10px", color: "var(--primary)" }}>Partie Terminée !</h2>
          <p className="text-muted" style={{ marginBottom: "30px", fontSize: "1.1rem" }}>
            10 mots devinés avec succès !
          </p>

          <div className="recap-list" style={{ textAlign: "left", marginBottom: "30px" }}>
            <h3 style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", paddingBottom: "10px", marginBottom: "15px" }}>Récapitulatif des mots</h3>
            <ul style={{ listStyle: "none", padding: 0 }}>
              {gs.wordStats && gs.wordStats.map((stat, idx) => (
                <li key={idx} style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "10px 15px",
                  background: idx % 2 === 0 ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.1)",
                  borderRadius: "8px",
                  marginBottom: "5px"
                }}>
                  <span style={{ fontWeight: 600, fontSize: "1.1rem" }}>{stat.word}</span>
                  <span style={{ color: stat.attempts === 1 ? "var(--success)" : "var(--text-light)" }}>
                    {stat.attempts} {stat.attempts > 1 ? "tentatives" : "tentative"}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {isHost ? (
            <button className="btn-primary" onClick={returnToLobby} style={{ padding: "12px 30px", fontSize: "1.1rem" }}>
              Retourner au Salon
            </button>
          ) : (
            <p className="text-muted" style={{ fontStyle: "italic" }}>En attente de l'hôte...</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
