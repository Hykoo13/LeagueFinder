const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require('uuid');

const store = require("./store");

const app = express();
app.use(cors());
app.use(express.json());

// Expose the word dictionary to the frontend
app.get("/dictionary", (req, res) => {
  res.json(store.dictionary);
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // allow frontend
    methods: ["GET", "POST"]
  }
});

// Avoid polluting the serialized `room` object with circular Node Timeouts
const roomTimers = new Map();

io.on("connection", (socket) => {
  console.log(`Socket Connected: ${socket.id}`);

  // === USER & AUTHENTICATION ===
  socket.on("register_user", ({ userId, username }, callback) => {
    let currentUser;
    if (userId && store.users.has(userId)) {
      // Reconnect existing user
      currentUser = store.users.get(userId);
      currentUser.socketId = socket.id;
      if (username && currentUser.username !== username) {
        currentUser.username = username; // Update username if it changed
      }
    } else {
      // New user
      const newUserId = userId || uuidv4();
      currentUser = {
        userId: newUserId,
        username: username || `Guest_${newUserId.substring(0, 4)}`,
        socketId: socket.id,
        friends: new Set(),
        pendingInvites: []
      };
      store.users.set(newUserId, currentUser);
    }

    // Map socket to user for quick lookup on disconnect
    store.socketUserMap.set(socket.id, currentUser.userId);

    console.log(`User Registered/Reconnected: ${currentUser.username} (${currentUser.userId})`);

    // Notify friends this user is online
    currentUser.friends.forEach(friendId => {
      const friend = store.users.get(friendId);
      if (friend && friend.socketId) {
        io.to(friend.socketId).emit("friend_online", { userId: currentUser.userId });
      }
    });

    // Send back the user's data (without Set objects which don't serialize well)
    callback({
      status: "success",
      user: {
        userId: currentUser.userId,
        username: currentUser.username,
        friends: Array.from(currentUser.friends).map(fId => {
          const f = store.users.get(fId);
          return { userId: fId, username: f?.username, online: !!f?.socketId };
        }),
        pendingInvites: currentUser.pendingInvites
      }
    });

    // We can also send them their friend's statuses here later
  });

  socket.on("update_username", ({ username }, callback) => {
    const userId = store.socketUserMap.get(socket.id);
    if (!userId) return callback({ status: "error", message: "Not registered" });

    if (!username || username.trim() === "") {
      return callback({ status: "error", message: "Invalid username" });
    }

    const user = store.users.get(userId);
    user.username = username.trim();

    // Broadcast update to the user themselves to update their UI
    socket.emit("user_updated", { username: user.username });

    // Broadcast to room if they are in one
    for (const room of store.rooms.values()) {
      const player = room.players.find(p => p.id === userId);
      if (player) {
        player.name = user.username;
        io.to(room.roomId).emit("room_update", room);
        // No need to keep looping, a user is only in one active room
        break;
      }
    }

    callback({ status: "success", username: user.username });
  });

  // === FRIENDS SYSTEM ===
  socket.on("add_friend", ({ friendId }, callback) => {
    const userId = store.socketUserMap.get(socket.id);
    if (!userId) return callback({ status: "error", message: "Not registered" });

    const friend = store.users.get(friendId);
    if (!friend) return callback({ status: "error", message: "User not found" });

    const user = store.users.get(userId);
    user.friends.add(friendId);
    friend.friends.add(userId); // Mutual for simplicity

    if (friend.socketId) {
      io.to(friend.socketId).emit("friend_added", { userId: user.userId, username: user.username });
    }
    callback({ status: "success", friend: { userId: friendId, username: friend.username, online: !!friend.socketId } });
  });

  socket.on("invite_friend", ({ friendId, roomId }, callback) => {
    const userId = store.socketUserMap.get(socket.id);
    if (!userId) return;

    const user = store.users.get(userId);
    const friend = store.users.get(friendId);

    if (friend) {
      const invite = { fromUserId: userId, fromUsername: user.username, roomId };
      friend.pendingInvites.push(invite);
      if (friend.socketId) {
        io.to(friend.socketId).emit("game_invite", invite);
      }
      if (callback) callback({ status: "success" });
    }
  });

  // === ROOMS & LOBBY ===
  socket.on("create_room", (callback) => {
    const userId = store.socketUserMap.get(socket.id);
    if (!userId) return callback({ status: "error", message: "Not registered" });

    const user = store.users.get(userId);
    const roomId = store.generateRoomCode();

    const newRoom = {
      roomId,
      hostId: userId,
      players: [],
      state: "LOBBY",
      settings: {
        activeCategories: Object.keys(store.dictionary), // all active by default
        turnDuration: 30
      },
      gameState: null
    };

    store.rooms.set(roomId, newRoom);
    callback({ status: "success", roomId });
  });

  socket.on("join_room", ({ roomId }, callback) => {
    const userId = store.socketUserMap.get(socket.id);
    if (!userId) return callback({ status: "error", message: "Not registered" });

    const room = store.rooms.get(roomId);
    if (!room) return callback({ status: "error", message: "Room not found" });

    const user = store.users.get(userId);

    // Check if already in room
    if (!room.players.find(p => p.id === userId)) {
      room.players.push({
        id: userId,
        name: user.username,
        score: 0 // Individual score per player
      });
    }

    socket.join(roomId);

    // Broadcast to others in the room
    io.to(roomId).emit("room_update", room);

    // Remove any pending invites for this room
    user.pendingInvites = user.pendingInvites.filter(i => i.roomId !== roomId);

    callback({ status: "success", room });
  });

  // Team switching removed.

  socket.on("toggle_category", ({ roomId, category }) => {
    const userId = store.socketUserMap.get(socket.id);
    const room = store.rooms.get(roomId);

    // Only host can toggle
    if (room && room.hostId === userId) {
      const cats = room.settings.activeCategories;
      if (cats.includes(category)) {
        room.settings.activeCategories = cats.filter(c => c !== category);
      } else {
        room.settings.activeCategories.push(category);
      }
      io.to(roomId).emit("room_update", room);
    }
  });

  // === GAME LOOP ===

  // Helper to pick a random word
  const getRandomWord = (room) => {
    const cats = room.settings.activeCategories;
    if (cats.length === 0) return "Sélectionnez une catégorie!";
    const randomCat = cats[Math.floor(Math.random() * cats.length)];
    const words = store.dictionary[randomCat];
    return words[Math.floor(Math.random() * words.length)];
  };

  const startNextTurn = (roomId) => {
    const room = store.rooms.get(roomId);
    if (!room) return;

    if (room.players.length === 0) {
      room.state = "LOBBY";
      io.to(roomId).emit("room_update", room);
      return;
    }

    // Simple rotation: Find index of current speaker, get next.
    let nextSpeaker = room.players[0];
    if (room.gameState.currentSpeakerId) {
      const lastSpeakerIndex = room.players.findIndex(p => p.id === room.gameState.currentSpeakerId);
      if (lastSpeakerIndex !== -1 && lastSpeakerIndex + 1 < room.players.length) {
        nextSpeaker = room.players[lastSpeakerIndex + 1];
      } else {
        nextSpeaker = room.players[0]; // Wrap around
      }
    }

    room.gameState.currentSpeakerId = nextSpeaker.id;
    room.gameState.currentWord = getRandomWord(room);
    room.gameState.timeRemaining = room.settings.turnDuration;
    room.gameState.turnActive = true;
    room.gameState.subTurn = "CLUE"; // "CLUE" or "GUESS"
    room.gameState.guesses = []; // Reset guesses
    room.gameState.clues = [];   // Reset clues

    io.to(roomId).emit("room_update", room);

    // Start Server-Side Timer
    if (roomTimers.has(roomId)) clearInterval(roomTimers.get(roomId));

    const newTimer = setInterval(() => {
      room.gameState.timeRemaining--;
      io.to(roomId).emit("timer_tick", { timeRemaining: room.gameState.timeRemaining });

      if (room.gameState.timeRemaining <= 0) {
        clearInterval(roomTimers.get(roomId));
        roomTimers.delete(roomId);
        room.gameState.turnActive = false;
        io.to(roomId).emit("turn_ended", room);
      }
    }, 1000);
    roomTimers.set(roomId, newTimer);
  };

  socket.on("start_game", ({ roomId }) => {
    const userId = store.socketUserMap.get(socket.id);
    const room = store.rooms.get(roomId);

    if (room && room.hostId === userId && room.state === "LOBBY") {
      room.state = "PLAYING";
      room.gameState = {
        currentSpeakerId: null,
        wordsPlayed: [],
        wordStats: [], // [{ word, attempts }] for the recap screen
        currentWord: null,
        clues: [],
        guesses: [],
        timeRemaining: room.settings.turnDuration,
        turnActive: false,
        subTurn: "CLUE"
      };
      startNextTurn(roomId);
    }
  });

  socket.on("send_clue", ({ roomId, clueText }, callback) => {
    const userId = store.socketUserMap.get(socket.id);
    const room = store.rooms.get(roomId);

    if (!room || room.state !== "PLAYING" || !room.gameState.turnActive) {
      return callback && callback({ status: "error", message: "Game not active" });
    }

    if (room.gameState.currentSpeakerId !== userId) {
      return callback && callback({ status: "error", message: "Only the speaker can send clues" });
    }

    if (room.gameState.subTurn !== "CLUE") {
      return callback && callback({ status: "error", message: "Not the time for a clue" });
    }

    if (!clueText || clueText.trim().length === 0) {
      return callback && callback({ status: "error", message: "Clue cannot be empty" });
    }

    const trimmedClue = clueText.trim();
    if (trimmedClue.length > 12) {
      return callback && callback({ status: "error", message: "Clue is limited to 12 characters max" });
    }

    // Similarity Check
    const stringSimilarity = require("string-similarity");
    const targetWord = room.gameState.currentWord.toLowerCase();
    const guessWord = trimmedClue.toLowerCase();

    const aliases = [targetWord];
    if (targetWord.includes('(')) {
      const mainWord = targetWord.replace(/\s*\(.*\)/, '').trim();
      const match = targetWord.match(/\(([^)]+)\)/);
      if (match) {
        const insideParen = match[1].trim();
        aliases.push(mainWord, insideParen);
      }
    }

    for (const alias of aliases) {
      if (alias.includes(guessWord) || guessWord.includes(alias)) {
        return callback && callback({ status: "error", message: "Indice trop similaire au mot caché !" });
      }
      const similarity = stringSimilarity.compareTwoStrings(alias, guessWord);
      // If it's more than 30% similar to the target word alias, reject it
      if (similarity > 0.3) {
        return callback && callback({ status: "error", message: "Indice trop similaire au mot caché !" });
      }
    }

    // Add clue
    room.gameState.clues.push(trimmedClue);
    room.gameState.subTurn = "GUESS"; // Switch turn to guessers

    io.to(roomId).emit("game_state_update", room.gameState);
    if (callback) callback({ status: "success" });
  });

  socket.on("word_guessed", ({ roomId, typedWord }) => {
    const userId = store.socketUserMap.get(socket.id);
    const room = store.rooms.get(roomId);

    if (room && room.state === "PLAYING" && room.gameState.turnActive) {

      // Anyone but the speaker can guess
      const player = room.players.find(p => p.id === userId);
      if (!player || room.gameState.currentSpeakerId === userId) {
        return; // Invalid guesser (is the speaker, or not in room)
      }

      // Check typed word against current word using fuzzy matching
      const stringSimilarity = require("string-similarity");
      const targetWord = room.gameState.currentWord.toLowerCase();
      const guess = typedWord.toLowerCase();

      // Handle parenthesis variants and compound word parts
      const aliases = [targetWord];
      if (targetWord.includes('(')) {
        const mainWord = targetWord.replace(/\s*\(.*\)/, '').trim();
        const match = targetWord.match(/\(([^)]+)\)/);
        if (match) {
          aliases.push(mainWord, match[1].trim());
        }
      } else if (targetWord.includes(' ')) {
        // If it's a compound word like "Miss Fortune" or "Xin Zhao", add the parts
        const parts = targetWord.split(' ').filter(p => p.length > 2);
        aliases.push(...parts);
      }

      let bestSimilarity = 0;
      for (const alias of aliases) {
        const sim = stringSimilarity.compareTwoStrings(alias, guess);
        if (sim > bestSimilarity) bestSimilarity = sim;
      }

      // Threshold for typo tolerance: e.g. 0.8 means 80% similar
      if (bestSimilarity >= 0.8) {
        // Valid Guess! Increment score for the guesser and the speaker
        player.score++;

        const speaker = room.players.find(p => p.id === room.gameState.currentSpeakerId);
        if (speaker) {
          speaker.score++;
        }

        room.gameState.wordsPlayed.push(room.gameState.currentWord);
        room.gameState.wordStats.push({
          word: room.gameState.currentWord,
          attempts: room.gameState.guesses.length + 1
        });

        io.to(roomId).emit("correct_guess", { by: player.name, word: guess });

        if (room.gameState.wordStats.length >= 10) {
          // Game Over Condition
          room.state = "END";
          if (roomTimers.has(roomId)) {
            clearInterval(roomTimers.get(roomId));
            roomTimers.delete(roomId);
          }
          io.to(roomId).emit("room_update", room);
        } else {
          // Pick next word AND pass the turn to the next speaker immediately
          startNextTurn(roomId);
        }
      } else {
        // Incorrect guess: switch back to speaker
        room.gameState.guesses.push(guess);
        room.gameState.subTurn = "CLUE";
        io.to(roomId).emit("game_state_update", room.gameState);
        socket.emit("wrong_guess");
      }
    }
  });

  // Handled when speaker decides to skip the current word
  socket.on("speaker_skip", ({ roomId }) => {
    const userId = store.socketUserMap.get(socket.id);
    const room = store.rooms.get(roomId);
    if (room && room.state === "PLAYING" && room.gameState.currentSpeakerId === userId && room.gameState.turnActive) {

      room.gameState.wordsPlayed.push(room.gameState.currentWord);
      room.gameState.wordStats.push({
        word: room.gameState.currentWord,
        attempts: "Passé"
      });

      if (room.gameState.wordStats.length >= 10) {
        // Game Over Condition
        room.state = "END";
        if (roomTimers.has(roomId)) {
          clearInterval(roomTimers.get(roomId));
          roomTimers.delete(roomId);
        }
        io.to(roomId).emit("room_update", room);
      } else {
        // Stop the running timer
        if (roomTimers.has(roomId)) {
          clearInterval(roomTimers.get(roomId));
          roomTimers.delete(roomId);
        }
        // Rotate to the next speaker
        let nextSpeaker = room.players[0];
        const lastSpeakerIndex = room.players.findIndex(p => p.id === room.gameState.currentSpeakerId);
        if (lastSpeakerIndex !== -1 && lastSpeakerIndex + 1 < room.players.length) {
          nextSpeaker = room.players[lastSpeakerIndex + 1];
        }
        room.gameState.currentSpeakerId = nextSpeaker.id;
        room.gameState.turnActive = false;
        room.gameState.clues = [];
        room.gameState.guesses = [];
        room.gameState.subTurn = "CLUE";
        io.to(roomId).emit("turn_ended", room);
      }
    }
  });

  // End turn early button
  socket.on("end_turn", ({ roomId }) => {
    const userId = store.socketUserMap.get(socket.id);
    const room = store.rooms.get(roomId);
    if (room && room.state === "PLAYING" && room.gameState.currentSpeakerId === userId && room.gameState.turnActive) {
      if (roomTimers.has(roomId)) {
        clearInterval(roomTimers.get(roomId));
        roomTimers.delete(roomId);
      }
      room.gameState.timeRemaining = 0;
      room.gameState.turnActive = false;
      io.to(roomId).emit("turn_ended", room);
    }
  });

  socket.on("next_turn", ({ roomId }) => {
    const userId = store.socketUserMap.get(socket.id);
    const room = store.rooms.get(roomId);
    if (room && room.state === "PLAYING" && room.hostId === userId && !room.gameState.turnActive) {
      startNextTurn(roomId);
    }
  });

  socket.on("return_lobby", ({ roomId }) => {
    const userId = store.socketUserMap.get(socket.id);
    const room = store.rooms.get(roomId);
    if (room && room.state === "END" && room.hostId === userId) {
      room.state = "LOBBY";
      room.gameState = null;
      room.players.forEach(p => p.score = 0); // optional: reset scores
      io.to(roomId).emit("room_update", room);
    }
  });


  const cleanupRoomInvites = (roomId) => {
    for (const user of store.users.values()) {
      const idx = user.pendingInvites.findIndex(i => i.roomId === roomId);
      if (idx !== -1) {
        user.pendingInvites.splice(idx, 1);
        if (user.socketId) {
          io.to(user.socketId).emit("user_updated", { pendingInvites: user.pendingInvites });
        }
      }
    }
  };

  socket.on("decline_invite", ({ roomId }) => {
    const userId = store.socketUserMap.get(socket.id);
    if (!userId) return;
    const user = store.users.get(userId);
    user.pendingInvites = user.pendingInvites.filter(i => i.roomId !== roomId);
    socket.emit("user_updated", { pendingInvites: user.pendingInvites });
  });

  socket.on("leave_room", (callback) => {
    const userId = store.socketUserMap.get(socket.id);
    if (!userId) {
      if (callback) callback({ status: "error", message: "Not registered" });
      return;
    }

    // Find and remove user from any room they are in
    for (const [roomId, room] of store.rooms.entries()) {
      if (room.players.find(p => p.id === userId)) {
        room.players = room.players.filter(p => p.id !== userId);
        socket.leave(roomId);

        if (room.players.length === 0) {
          if (roomTimers.has(roomId)) {
            clearInterval(roomTimers.get(roomId));
            roomTimers.delete(roomId);
          }
          store.rooms.delete(roomId);
          cleanupRoomInvites(roomId);
        } else {
          if (room.hostId === userId) {
            room.hostId = room.players[0].id;
          }
          // If speaker leaves, we could reset turn, but let's keep it simple
          io.to(roomId).emit("room_update", room);
        }
      }
    }
    if (callback) callback({ status: "success" });
  });

  socket.on("disconnect", () => {
    console.log(`Socket Disconnected: ${socket.id}`);
    const userId = store.socketUserMap.get(socket.id);
    if (userId) {
      const user = store.users.get(userId);
      user.socketId = null; // Mark offline
      store.socketUserMap.delete(socket.id);

      // Clean up room if they disconnect while in one
      for (const [roomId, room] of store.rooms.entries()) {
        if (room.players.find(p => p.id === userId)) {
          room.players = room.players.filter(p => p.id !== userId);
          if (room.players.length === 0) {
            if (roomTimers.has(roomId)) {
              clearInterval(roomTimers.get(roomId));
              roomTimers.delete(roomId);
            }
            store.rooms.delete(roomId);
            cleanupRoomInvites(roomId);
          } else {
            if (room.hostId === userId) {
              room.hostId = room.players[0].id;
            }
            io.to(roomId).emit("room_update", room);
          }
        }
      }

      // Notify friends
      user.friends.forEach(friendId => {
        const friend = store.users.get(friendId);
        if (friend && friend.socketId) {
          io.to(friend.socketId).emit("friend_offline", { userId });
        }
      });
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
