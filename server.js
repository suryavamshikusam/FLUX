const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Optimize Socket.io for low latency and reliability
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000, // Wait 60s for a pong before considering the client dead
  pingInterval: 25000, // Send a ping every 25s to keep connection alive
  maxHttpBufferSize: 1e4, // 10KB max message size (prevents payload attacks)
});

// In-memory state: Map<roomId, Map<socketId, peerData>>
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // 1. User joins a room (e.g., local network)
  socket.on('join-room', (roomId, peerData) => {
    // Safely parse peerData to prevent crashes
    let data;
    try {
      data = typeof peerData === 'string' ? JSON.parse(peerData) : peerData;
    } catch (e) {
      console.error(`[-] Invalid JSON from ${socket.id}`);
      return;
    }

    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }
    
    // Store peer data (e.g., "Crimson Panther", OS, Browser)
    rooms.get(roomId).set(socket.id, data);

    // Broadcast to everyone ELSE in the room that a new peer arrived
    socket.to(roomId).emit('peer-joined', {
      socketId: socket.id,
      peerData: data
    });

    // Send the new user a list of existing peers in the room
    const existingPeers = Array.from(rooms.get(roomId).entries())
      .filter(([id]) => id !== socket.id)
      .map(([id, data]) => ({ socketId: id, peerData: data }));
    
    socket.emit('room-peers', existingPeers);
  });

  // 2. Relay WebRTC Signaling (Offer, Answer, ICE Candidate)
  socket.on('signal', (data) => {
    // data should contain: { targetId, payload }
    io.to(data.targetId).emit('signal', {
      senderId: socket.id,
      payload: data.payload
    });
  });

  // 3. Reliable Cleanup on Disconnect
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    
    rooms.forEach((peers, roomId) => {
      if (peers.has(socket.id)) {
        peers.delete(socket.id);
        // Notify others in the room
        io.to(roomId).emit('peer-left', socket.id);
        
        // Clean up empty rooms to prevent memory leaks
        if (peers.size === 0) {
          rooms.delete(roomId);
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
});
