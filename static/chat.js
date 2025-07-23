const socket = io();
const urlParams = new URLSearchParams(window.location.search);
const nickname = urlParams.get('nickname');
const color = urlParams.get('color');

// Elements
const chatPanel = document.getElementById('chatPanel');
const usersList = document.getElementById('usersList');
const logsList = document.getElementById('logsList');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const voiceBtn = document.getElementById('voiceBtn');
const emojiBtn = document.getElementById('emojiBtn');
const pickerContainer = document.getElementById('emojiPickerContainer');

// Handle nickname errors
socket.on('nickname_error', (message) => {
  alert(message);
  window.location.href = '/';
});


// On connect
socket.on('connect', () => {
  socket.emit('join', { nickname, color });
});

// Load chat history (placeholder, not used unless backend supports `request_message`)
socket.on('load_history', files => {
  files.sort().forEach(file => {
    // Optional: request full message by filename
    socket.emit('request_message', file);
  });
});

socket.on('historical_message', data => {
  handleIncomingMessage(data);
});

// User events
socket.on('user_joined', data => {
  addLog(`${data.nickname} joined the chat.`);
  updateActive(data.activeUsers || []);
});

socket.on('user_left', data => {
  addLog(`${data.nickname} left the chat.`);
  updateActive(data.activeUsers || []);
});

// Incoming message events
socket.on('new_message', data => {
  handleIncomingMessage({ ...data, mtype: 'text' });
});

socket.on('new_emoji', data => {
  handleIncomingMessage({ ...data, mtype: 'emoji' });
});

socket.on('new_voice', data => {
  handleIncomingMessage({ ...data, mtype: 'voice' });
});

socket.on('new_attachment', data => {
  handleIncomingMessage({ ...data, mtype: 'file' });
});

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();     // stop any default newline
    sendBtn.click();        // reuse your click‐handler
  }
});

// Text message
sendBtn.addEventListener('click', () => {
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit('message', { nickname, color, text });
  messageInput.value = '';
});

// Emoji button
// Initialize emoji picker
document.addEventListener('DOMContentLoaded', () => {
  pickerContainer.innerHTML = '<emoji-picker></emoji-picker>';
  const picker = pickerContainer.querySelector('emoji-picker');
  picker.style.position = 'absolute';
  picker.style.bottom = '30px';  // adjust as needed
  picker.style.left = '0';
  picker.style.display = 'none';

  // wrap selection
  picker.addEventListener('emoji-click', (ev) => {
    messageInput.value += ev.detail.unicode;
    picker.style.display = 'none';
  });

  // toggle on button click
  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    picker.style.display = picker.style.display === 'block' ? 'none' : 'block';
  });

  // click outside to close
  document.addEventListener('click', (e) => {
    if (!emojiBtn.contains(e.target) && !picker.contains(e.target)) {
      picker.style.display = 'none';
    }
  });
});
// Attachment
attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;

  // Check file size
  if (file.size > 20 * 1024 * 1024) {
    showToast("File too large! Please use external sharing");
    shareLargeFile();
    return;
  }

  try {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch('/upload', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error);
    }

    const result = await response.json();
    
    // Send message with file URL
    socket.emit('attachment', {
      nickname,
      color,
      filename: result.originalName,
      fileUrl: result.url
    });
  } catch (error) {
    showToast(`Upload failed: ${error.message}`);
  } finally {
    fileInput.value = '';
  }
});
const recordingIndicator = document.getElementById('recordingIndicator');
const toast = document.getElementById('toast');

let mediaRecorder = null;
let audioStream   = null;
let audioChunks   = [];

voiceBtn.addEventListener('click', async () => {
  // --- If not recording, start a new recording ---
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    try {
      // 1. Grab the mic
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // 2. Create recorder & clear old chunks
      mediaRecorder = new MediaRecorder(audioStream);
      audioChunks   = [];

      // 3. When a data chunk’s ready, stash it
      mediaRecorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };

      // 4. When recording stops, upload & emit
      mediaRecorder.onstop = async () => {
        // build the blob
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const form = new FormData();
        form.append('file', blob, `voice-${Date.now()}.webm`);

        try {
          const res = await fetch('/upload', { method: 'POST', body: form });
          if (!res.ok) throw new Error('Upload failed');
          const { url, originalName } = await res.json();

          // emit to server
          socket.emit('voice', {
            nickname,
            color,
            filename: originalName,
            fileUrl: url
          });
          showToast('Voice message sent!');
        } catch (err) {
          console.error('Upload error:', err);
          showToast('Failed to send voice message');
        } finally {
          // cleanup the tracks
          audioStream.getTracks().forEach(t => t.stop());
          audioStream = null;
          mediaRecorder = null;
          voiceBtn.textContent = '🎤';
          recordingIndicator.style.display = 'none';
        }
      };

      // 5. Start!
      mediaRecorder.start();
      voiceBtn.textContent = '⏹️ Stop';
      recordingIndicator.style.display = 'inline';

    } catch (err) {
      console.error('Microphone error:', err);
      showToast("Mic access denied—please allow in browser settings");
    }

  // --- If already recording, stop it ---
  } else if (mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
});

// Toast utility
function showToast(message) {
  toast.textContent = message;
  toast.style.display = 'block';
  setTimeout(() => {
    toast.style.display = 'none';
  }, 2500);
}


// Render message in chat panel
function handleIncomingMessage(data) {
  const {
    nickname: senderNickname,
    color,
    mtype,
    text,
    filename = '',
    fileUrl = '',
    emoji = '😊'
  } = data;

  // 1. Container & sender styling
  const div = document.createElement('div');
  div.className = 'message';
  div.classList.add(senderNickname === nickname ? 'self' : 'other');

  // 2. Render header (sender name + optional timestamp)
  const header = document.createElement('div');
  header.className = 'message-header';
  header.innerHTML = `<strong style="color:${color}">${senderNickname}</strong>`;
  div.appendChild(header);

  // 3. Render body based on type
  let bodyEl;
  if (mtype === 'text') {
    bodyEl = document.createElement('p');
    bodyEl.textContent = text;

  } else if (mtype === 'emoji') {
    bodyEl = document.createElement('p');
    bodyEl.textContent = emoji;

  } else if (mtype === 'file') {
    const isImage = /\.(jpe?g|png|gif|webp)$/i.test(filename);
    if (isImage) {
      bodyEl = document.createElement('img');
      bodyEl.src = fileUrl;
      bodyEl.alt = filename;
      bodyEl.style.maxWidth = '200px';
      bodyEl.style.borderRadius = '8px';
      bodyEl.style.marginTop = '5px';
    } else {
      bodyEl = document.createElement('p');
      const link = document.createElement('a');
      link.href = fileUrl;
      link.download = filename;
      link.textContent = filename || 'download file';
      link.style.color = color;
      link.style.textDecoration = 'underline';
      link.target = '_blank';
      bodyEl.appendChild(document.createTextNode('sent: '));
      bodyEl.appendChild(link);
    }

  } else if (mtype === 'voice') {
    bodyEl = document.createElement('audio');
    bodyEl.controls = true;
    bodyEl.src = fileUrl;
    bodyEl.style.marginTop = '5px';

  } else {
    // fallback
    bodyEl = document.createElement('p');
    bodyEl.textContent = `[unknown message type: ${mtype}]`;
  }

  div.appendChild(bodyEl);

  // 4. Append to chat panel & scroll
  const chatPanel = document.getElementById('chatPanel');
  chatPanel.appendChild(div);
  chatPanel.scrollTop = chatPanel.scrollHeight;
}

// Utility: logs
function addLog(text) {
  const li = document.createElement('li');
  li.textContent = text;
  logsList.appendChild(li);
  logsList.scrollTop = logsList.scrollHeight;
}

// Utility: update users
function updateActive(activeUsers) {
  usersList.innerHTML = '';
  activeUsers.forEach(user => {
    const li = document.createElement('li');
    li.textContent = user;
    usersList.appendChild(li);
  });
}
async function shareLargeFile(url='https://toffeeshare.com?ref=chatroom/') {
  try {
    // ensure window is focused so clipboard API will prompt
    if (!document.hasFocus()) {
      window.focus();
    }
    await navigator.clipboard.writeText(url);
    showToast('Link copied to clipboard!');
  } catch (err) {
    console.error('Clipboard write failed:', err);
    // fallback for browsers that refuse when unfocused
    prompt('Copy this link manually:', url);
  }
}

