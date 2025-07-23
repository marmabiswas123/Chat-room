const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const multer = require('multer');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 8080;

// Directories
const BASE_DIR = path.resolve(__dirname);
const MSG_DIR = path.join(BASE_DIR, 'messages');
const UPLOAD_DIR = path.join(BASE_DIR, 'static', 'uploads');

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB limit
});

//Debugging

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Ensure required folders/files exist
// if (!fs.existsSync(NICK_FILE)) fs.writeFileSync(NICK_FILE, '');
if (!fs.existsSync(MSG_DIR)) fs.mkdirSync(MSG_DIR);
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Chat colors
const COLORS = [
  'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'cyan', 'magenta', 'lime',
  'teal', 'navy', 'maroon', 'olive', 'silver', 'gray', 'black', 'white', 'brown', 'coral'
];

// // Utility: load and store nicknames
// function loadNicknames() {
//   return new Set(fs.readFileSync(NICK_FILE, 'utf8').split(/\r?\n/).filter(Boolean));
// }
// function addNickname(nick) {
//   fs.appendFileSync(NICK_FILE, nick + '\n');
// }

// Utility: store message
function storeMessage(nick, type, content, filename = '', fileData = '') {
  const files = fs.readdirSync(MSG_DIR);
  
  // Rotate messages when reaching 100
  if (files.length >= 100) {
    const oldestFile = files.sort()[0];
    fs.unlinkSync(path.join(MSG_DIR, oldestFile));
  }
  const h = crypto.createHash('sha1').update(nick).digest('hex');
  const ts = Date.now();
  const fn = `${ts}_${h}.msg`;
  const full = path.join(MSG_DIR, fn);
  const entry = { nick, type, content, filename, fileData, ts };
  fs.writeFileSync(full, JSON.stringify(entry) + '\n');
  return entry;
}

// Express config
app.use('/static', express.static(path.join(BASE_DIR, 'static')));
app.set('views', path.join(BASE_DIR, 'views'));
app.set('view engine', 'ejs');

// Routes
app.get('/', (req, res) => {
  res.render('index', { colors: COLORS, error: null });
});

app.get('/join', (req, res) => {
  const nick = (req.query.nickname || '').trim();
  const color = (req.query.color || '').trim();

  // Validate inputs
  if (!nick) {
    return res.status(400).json({ error: 'Nickname is required' });
  }
  if (!COLORS.includes(color)) {
    return res.status(400).json({ error: 'Invalid color selection' });
  }
  if (nick.length > 20) {
    return res.status(400).json({ error: 'Nickname too long (max 20 chars)' });
  }

  // If all valid, redirect to chat
  res.redirect(`/chat-room?nickname=${encodeURIComponent(nick)}&color=${encodeURIComponent(color)}`);
});

//   addNickname(nick);
//   res.redirect(`/chat-room?nickname=${encodeURIComponent(nick)}&color=${encodeURIComponent(color)}`);
// });

app.get('/chat-room', (req, res) => {
  res.render('chat-room', {
    nickname: req.query.nickname,
    color: req.query.color
  });
});

// In-memory active users
const activeUsers = new Set();

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded');
  
  if (req.file.size > 20 * 1024 * 1024) {
    fs.unlinkSync(req.file.path);
    return res.status(400).send('File too large');
  }
  
  res.json({ 
    url: `/static/uploads/${req.file.filename}`,
    originalName: req.file.originalname
  });
});

// Socket.IO logic
io.on('connection', socket => {
  // Load old messages (filenames)
  const files = fs.readdirSync(MSG_DIR).sort();
  socket.emit('load_history', files);

  // Join event
   socket.on('join', data => {
    if (activeUsers.has(data.nickname)) {
      socket.emit('nickname_error', 'Nickname already in use');
      socket.disconnect();
      return;
    }

    socket.nickname = data.nickname;
    activeUsers.add(data.nickname);
    
    io.emit('user_joined', {
      nickname: data.nickname,
      color: data.color,
      activeUsers: [...activeUsers]
    });
  });

  // Leave/disconnect
socket.on('disconnect', () => {
  if (socket.nickname) {
    if (activeUsers.has(socket.nickname)) {
      activeUsers.delete(socket.nickname);
      io.emit('user_left', {
        nickname: socket.nickname,
        activeUsers: [...activeUsers]
      });
    }
  }
});
  // Text message
  socket.on('message', data => {
    const entry = storeMessage(data.nickname, 'text', data.text);
    io.emit('new_message', { ...data, timestamp: entry.ts });
  });

  // Emoji
  socket.on('emoji', data => {
    const entry = storeMessage(data.nickname, 'emoji', data.emoji);
    io.emit('new_emoji', { ...data, timestamp: entry.ts });
  });

  // Attachment

socket.on('attachment', data => {
  // store content blank, put actual URL in fileData
  const entry = storeMessage(
    data.nickname,
    'attachment',
    '',
    data.filename,
    data.fileUrl
  );
  io.emit('new_attachment', {
    nickname: data.nickname,
    color:     data.color,
    filename:  data.filename,
    fileUrl:   data.fileUrl,
    timestamp: entry.ts
  });
});

  // Voice
socket.on('voice', data => {
  const entry = storeMessage(data.nickname, 'voice', data.fileUrl, data.filename);
  io.emit('new_voice', {
    nickname: data.nickname,
    color: data.color,
    filename: data.filename,
    fileUrl: data.fileUrl,
    timestamp: entry.ts
  });
});

  // [Optional] Handle request for history file content (used if load_history actually matters)
  socket.on('request_message', (filename) => {
    const filepath = path.join(MSG_DIR, filename);
    if (fs.existsSync(filepath)) {
      const raw = fs.readFileSync(filepath, 'utf8');
      const entry = JSON.parse(raw);
      const { nick, type, content, filename, fileData, ts } = entry;

      const payload = {
        nickname: nick,
        mtype: type,
        text: content,
        filename,
        fileData,
        timestamp: ts
      };

      const eventMap = {
        text: 'new_message',
        emoji: 'new_emoji',
        attachment: 'new_attachment',
        voice: 'new_voice'
      };

      const evt = eventMap[type] || 'new_message';
      socket.emit(evt, payload);
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
// Add at the bottom of the file:
function runCleanup() {
  const now = Date.now();
  try {
    // Clean up old messages
    const msgFiles = fs.readdirSync(MSG_DIR);
    if (msgFiles.length > 100) {
      const filesToDelete = msgFiles
        .sort()
        .slice(0, msgFiles.length - 100);
      
      filesToDelete.forEach(file => {
        fs.unlinkSync(path.join(MSG_DIR, file));
      });
    }

    // Clean up old uploads (older than 7 days)
    const uploadFiles = fs.readdirSync(UPLOAD_DIR);
    uploadFiles.forEach(file => {
      const filePath = path.join(UPLOAD_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

// Run immediately and then every hour
runCleanup();
setInterval(runCleanup, 60 * 60 * 1000);
