(() => {
  const $ = (id) => document.getElementById(id);

  const screenHome = $('screen-home');
  const screenWait = $('screen-wait');
  const screenChat = $('screen-chat');

  const nameInput = $('name');
  const roomInput = $('room');
  const joinRow = $('join-row');

  const btnCreate = $('btn-create');
  const btnJoin = $('btn-join');
  const btnJoinGo = $('btn-join-go');

  const bigCode = $('big-code');
  const roomCode = $('room-code');

  const btnCopy = $('btn-copy');
  const btnLeave = $('btn-leave');
  const btnLeave2 = $('btn-leave-2');

  const lblYou = $('lbl-you');
  const lblOther = $('lbl-other');

  const lastFrom = $('last-from');
  const lastText = $('last-text');
  const btnSpeak = $('btn-speak');

  const btnMic = $('btn-mic');
  const msgInput = $('msg');
  const btnSend = $('btn-send');
  const status = $('status');

  let clientId = null;
  let room = null;
  let users = [];
  let polling = false;
  let pollAbort = null;

  let lastMsg = { from: null, text: '' };

  // --- Utilities
  function setScreen(which) {
    screenHome.classList.add('hidden');
    screenWait.classList.add('hidden');
    screenChat.classList.add('hidden');
    which.classList.remove('hidden');
  }

  function setStatus(text) {
    status.textContent = text || '';
  }

  function safeName() {
    return (nameInput.value || '').trim().slice(0, 20);
  }

  function safeRoom() {
    return (roomInput.value || '').replace(/\D/g, '').slice(0, 5);
  }

  function updateStars(fromId) {
    const youStar = fromId === clientId ? ' ⭐' : '';
    const otherStar = fromId && fromId !== clientId ? ' ⭐' : '';

    lblYou.textContent = 'You' + youStar;

    const other = users.find((u) => u.id !== clientId);
    const otherName = other?.name ? other.name : 'Other';
    lblOther.textContent = otherName + otherStar;
  }

  function updatePresence(p) {
    users = p.users || [];

    bigCode.textContent = p.room || room || '00000';
    roomCode.textContent = p.room || room || '00000';

    if ((p.count || users.length) <= 1) {
      setScreen(screenWait);
    } else {
      setScreen(screenChat);
    }

    updateStars(lastMsg.from);
  }

  // --- Long-polling for events ---
  async function poll() {
    if (!polling || !clientId) return;

    try {
      pollAbort = new AbortController();
      const res = await fetch('/api/room/poll?clientId=' + encodeURIComponent(clientId), {
        signal: pollAbort.signal
      });

      if (!res.ok) {
        if (res.status === 400) {
          stopPolling();
          setScreen(screenHome);
          setStatus('Disconnected');
          return;
        }
        throw new Error('Poll failed');
      }

      const data = await res.json();
      const events = data.events || [];

      for (const event of events) {
        handleEvent(event);
      }

      if (polling) {
        setTimeout(poll, 100);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Poll error:', err);
      if (polling) {
        setTimeout(poll, 2000);
      }
    }
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    poll();
  }

  function stopPolling() {
    polling = false;
    if (pollAbort) {
      pollAbort.abort();
      pollAbort = null;
    }
  }

  function handleEvent(data) {
    if (data.type === 'hello') {
      clientId = data.clientId;
      return;
    }

    if (data.type === 'created' || data.type === 'joined') {
      room = data.room;
      bigCode.textContent = room;
      roomCode.textContent = room;
      setScreen(screenWait);
      setStatus('Connected');
      return;
    }

    if (data.type === 'presence') {
      updatePresence(data);
      return;
    }

    if (data.type === 'msg') {
      const isMe = data.from === clientId;
      const who = isMe ? 'You' : (data.fromName || 'Other');

      lastMsg = { from: data.from, text: data.text };

      lastFrom.textContent = who;
      lastText.textContent = data.text;

      updateStars(data.from);
      return;
    }

    if (data.type === 'error') {
      alert(data.message || 'Error');
      setScreen(screenHome);
      return;
    }
  }

  // --- API calls ---
  async function apiCreate() {
    try {
      setStatus('Creating room…');
      const res = await fetch('/api/room/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: safeName() })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create room');
      }

      const data = await res.json();
      clientId = data.clientId;
      room = data.room;

      bigCode.textContent = room;
      roomCode.textContent = room;
      setScreen(screenWait);
      setStatus('Connected');

      startPolling();
    } catch (err) {
      alert(err.message || 'Could not create room');
      setStatus('');
    }
  }

  async function apiJoin(roomCodeVal) {
    try {
      setStatus('Joining room…');
      const res = await fetch('/api/room/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: roomCodeVal, name: safeName() })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to join room');
      }

      const data = await res.json();
      clientId = data.clientId;
      room = data.room;

      bigCode.textContent = room;
      roomCode.textContent = room;
      setScreen(screenWait);
      setStatus('Connected');

      startPolling();
    } catch (err) {
      alert(err.message || 'Could not join room');
      setStatus('');
    }
  }

  async function apiLeave() {
    if (!clientId) return;

    stopPolling();

    try {
      await fetch('/api/room/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId })
      });
    } catch {}

    clientId = null;
    room = null;
    users = [];
    lastMsg = { from: null, text: '' };
    lastFrom.textContent = '—';
    lastText.textContent = 'No messages yet.';
    updateStars(null);
    setScreen(screenHome);
    setStatus('');
  }

  async function apiSend(text) {
    if (!clientId || !text) return;

    try {
      const res = await fetch('/api/room/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, text })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to send');
      }
    } catch (err) {
      console.error('Send error:', err);
      setStatus('Failed to send');
      setTimeout(() => setStatus(''), 2000);
    }
  }

  // --- Home actions
  btnJoin.addEventListener('click', () => {
    joinRow.classList.toggle('hidden');
    if (!joinRow.classList.contains('hidden')) roomInput.focus();
  });

  btnCreate.addEventListener('click', () => {
    apiCreate();
  });

  btnJoinGo.addEventListener('click', () => {
    const code = safeRoom();
    if (code.length !== 5) {
      alert('Room code must be 5 digits.');
      return;
    }
    apiJoin(code);
  });

  roomInput.addEventListener('input', () => {
    roomInput.value = safeRoom();
  });

  // --- Copy link
  function roomLink() {
    const url = new URL(location.href);
    url.searchParams.set('room', room || bigCode.textContent || '');
    return url.toString();
  }

  btnCopy.addEventListener('click', async () => {
    const link = roomLink();
    try {
      await navigator.clipboard.writeText(link);
      setStatus('Copied!');
      setTimeout(() => setStatus(''), 1200);
    } catch {
      prompt('Copy this link:', link);
    }
  });

  btnLeave.addEventListener('click', apiLeave);
  btnLeave2.addEventListener('click', apiLeave);

  // --- Send text
  function doSendText() {
    const text = (msgInput.value || '').trim();
    if (!text) return;
    apiSend(text);
    msgInput.value = '';
    msgInput.focus();
  }

  btnSend.addEventListener('click', doSendText);
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSendText();
  });

  // --- TTS (speak last message)
  btnSpeak.addEventListener('click', () => {
    const text = (lastMsg.text || '').trim();
    if (!text) return;
    fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    })
      .then((res) => {
        if (!res.ok) throw new Error('TTS not available');
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.play();
        audio.onended = () => URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (!('speechSynthesis' in window)) {
          alert('Text-to-speech is not available.');
          return;
        }
        try {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(text);
          u.rate = 1.0;
          u.pitch = 1.0;
          window.speechSynthesis.speak(u);
        } catch {
          alert('Could not speak this message.');
        }
      });
  });

  // --- Voice-to-text via server-side STT
  const MAX_RECORD_DURATION = 20000;
  let mediaRecorder = null;
  let audioChunks = [];
  let recordingTimeout = null;
  let isRecording = false;

  function getMimeType() {
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      return 'audio/webm;codecs=opus';
    }
    if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
      return 'audio/ogg;codecs=opus';
    }
    if (MediaRecorder.isTypeSupported('audio/webm')) {
      return 'audio/webm';
    }
    return '';
  }

  function setMicUI(recording, transcribing = false) {
    isRecording = recording;
    btnMic.classList.toggle('recording', recording);
    btnMic.classList.toggle('transcribing', transcribing);
    if (transcribing) {
      btnMic.textContent = '⏳';
      btnMic.disabled = true;
    } else if (recording) {
      btnMic.textContent = '⏺';
      btnMic.disabled = false;
    } else {
      btnMic.textContent = '🎤';
      btnMic.disabled = false;
    }
  }

  function showToast(msg, duration = 3000) {
    setStatus(msg);
    setTimeout(() => setStatus(''), duration);
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getMimeType();
      if (!mimeType) {
        showToast('Audio recording not supported');
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream, { mimeType });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        clearTimeout(recordingTimeout);

        if (audioChunks.length === 0) {
          setMicUI(false);
          return;
        }

        const blob = new Blob(audioChunks, { type: mimeType });
        audioChunks = [];

        if (blob.size > 8 * 1024 * 1024) {
          showToast('Recording too large');
          setMicUI(false);
          return;
        }

        setMicUI(false, true);
        setStatus('Transcribing…');

        try {
          const formData = new FormData();
          formData.append('audio', blob, 'audio.webm');

          const res = await fetch('/api/stt', {
            method: 'POST',
            body: formData
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Server error');
          }

          const data = await res.json();
          const text = (data.text || '').trim();

          if (text) {
            msgInput.value = text;
            msgInput.focus();
            showToast('Transcribed ✓', 1500);
          } else {
            showToast('No speech detected');
          }
        } catch (err) {
          console.error('STT error:', err);
          showToast('Transcription failed');
        } finally {
          setMicUI(false);
        }
      };

      mediaRecorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearTimeout(recordingTimeout);
        setMicUI(false);
        showToast('Recording error');
      };

      mediaRecorder.start();
      setMicUI(true);
      setStatus('Recording… (tap to stop)');

      recordingTimeout = setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
        }
      }, MAX_RECORD_DURATION);

    } catch (err) {
      console.error('Mic error:', err);
      if (err.name === 'NotAllowedError') {
        showToast('Microphone access denied');
      } else {
        showToast('Could not access microphone');
      }
      setMicUI(false);
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  }

  btnMic.addEventListener('click', () => {
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  });

  // --- Auto join from URL
  const url = new URL(location.href);
  const autoRoom = url.searchParams.get('room');
  if (autoRoom && /^[0-9]{5}$/.test(autoRoom)) {
    setScreen(screenHome);
    joinRow.classList.remove('hidden');
    roomInput.value = autoRoom;
  }

  setScreen(screenHome);
})();
