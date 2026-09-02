// Celestea Studio frontend - SSE streaming turn viewer (minimal MVP).
// SSE event names: status / text / thinking / tool / tool_result / done.
// Every event data: {turn, seq, payload:{...}}.

'use strict';

var $ = function (sel) { return document.querySelector(sel); };
var messagesEl = $('#messages');
var statusEl = $('#status');
var stepEl = $('#step');
var inputEl = $('#input');
var sendBtn = $('#send');

var currentTurn = null;   // turn id of the current turn
var streaming = false;
var assistant = null;     // current assistant bubble view state

function setStatus(text) { statusEl.textContent = text; }
function autoscroll() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function md(text) {
  if (window.marked) {
    try { return marked.parse(text); } catch (e) { /* fall through */ }
  }
  return '<pre>' + esc(text) + '</pre>';
}

function addUserBubble(text) {
  var div = document.createElement('div');
  div.className = 'msg user';
  var b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  div.appendChild(b);
  messagesEl.appendChild(div);
  autoscroll();
}

function ensureAssistant() {
  if (assistant) return assistant;
  var div = document.createElement('div');
  div.className = 'msg assistant';
  var inner = document.createElement('div');
  inner.className = 'bubble';
  inner.innerHTML =
    '<details class="thinking hidden"><summary>思考</summary><div class="thinking-body"></div></details>' +
    '<div class="toolcards"></div>' +
    '<div class="content"></div>';
  div.appendChild(inner);
  messagesEl.appendChild(div);
  autoscroll();
  assistant = {
    el: div, body: inner, content: inner.querySelector('.content'),
    thinking: inner.querySelector('.thinking'), thinkingBody: inner.querySelector('.thinking-body'),
    cards: inner.querySelector('.toolcards'), cardsById: {},
    text: '', think: ''
  };
  return assistant;
}

function updateStep(a) {
  var n = a ? a.cards.querySelectorAll('.toolcard').length : 0;
  stepEl.textContent = n > 0 ? 'step ' + (n + 1) : '';
}

function finish(phase) {
  streaming = false;
  sendBtn.disabled = false;
  stepEl.textContent = '';
  var label = 'completed';
  if (phase === 'cancelled') label = 'cancelled';
  if (phase === 'error') label = 'error';
  setStatus(label);
  if (assistant) assistant.el.classList.add('complete');
}

// ---- SSE handlers ---------------------------------------------------------

function onStatus(d) {
  if (d.phase === 'start') {
    currentTurn = d.turn;
    ensureAssistant();
    setStatus('streaming');
    return;
  }
  if (d.turn !== undefined && d.turn !== currentTurn) return; // stale
  if (d.phase === 'completed' || d.phase === 'cancelled') finish(d.phase);
  else if (d.phase === 'error') {
    finish('error');
    var a = ensureAssistant();
    var err = document.createElement('div');
    err.className = 'err';
    err.textContent = d.error || 'unknown error (check server log)';
    a.body.appendChild(err);
  }
  // 'lagged' (slow client) is tolerated silently for the MVP.
}

function applyText(d) {
  if (currentTurn === null) currentTurn = d.turn;
  if (d.turn !== currentTurn) return;
  var a = ensureAssistant();
  a.text += d.delta || '';
  a.content.innerHTML = md(a.text);
  setStatus('streaming');
  autoscroll();
}

function applyThinking(d) {
  if (currentTurn === null) currentTurn = d.turn;
  if (d.turn !== currentTurn) return;
  var a = ensureAssistant();
  a.thinking.classList.remove('hidden');
  a.think += d.delta || '';
  a.thinkingBody.textContent = a.think;
  autoscroll();
}

function onTool(d) {
  if (d.turn !== currentTurn) return;
  var a = ensureAssistant();
  var card = document.createElement('div');
  card.className = 'toolcard running';
  card.dataset.id = d.id;
  var head = document.createElement('div');
  head.className = 'tool-head';
  var name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = d.name;
  var state = document.createElement('span');
  state.className = 'tool-state';
  state.textContent = 'running';
  head.appendChild(name);
  head.appendChild(state);
  var args = document.createElement('div');
  args.className = 'tool-args';
  args.textContent = JSON.stringify(d.args, null, 2);
  card.appendChild(head);
  card.appendChild(args);
  a.cards.appendChild(card);
  a.cardsById[d.id] = { card: card, state: state };
  updateStep(a);
  autoscroll();
}

function onToolResult(d) {
  if (!assistant) return;
  if (d.turn !== currentTurn) return;
  var entry = assistant.cardsById[d.id];
  if (!entry) return;
  entry.state.textContent = d.ok ? 'ok' : 'error';
  entry.card.classList.remove('running');
  entry.card.classList.add(d.ok ? 'ok' : 'err');
  var out = document.createElement('div');
  out.className = 'tool-out';
  if (d.render != null) out.textContent = d.render;
  else if (d.value != null) out.textContent = JSON.stringify(d.value);
  else if (d.error) out.textContent = d.error;
  entry.card.appendChild(out);
  updateStep(assistant);
  autoscroll();
}

function onDone(d) {
  // A 'done' event ends one model round. With tools, more rounds may follow;
  // the turn only finishes on status: completed/cancelled/error.
  if (!assistant) return;
  if (d.turn !== currentTurn) return;
  if (d.text && assistant.text !== d.text) {
    assistant.text = d.text;
    assistant.content.innerHTML = md(d.text);
  }
  if (d.tool_calls && d.tool_calls.length > 0) updateStep(assistant);
  autoscroll();
}

var es = new EventSource('/api/events');
es.onopen = function () { setStatus(streaming ? 'streaming' : 'ready'); };
es.onerror = function () { setStatus('reconnecting…'); };
es.addEventListener('status', function (e) { onStatus(JSON.parse(e.data).payload); });
es.addEventListener('text', function (e) { applyText(JSON.parse(e.data).payload); });
es.addEventListener('thinking', function (e) { applyThinking(JSON.parse(e.data).payload); });
es.addEventListener('tool', function (e) { onTool(JSON.parse(e.data).payload); });
es.addEventListener('tool_result', function (e) { onToolResult(JSON.parse(e.data).payload); });
es.addEventListener('done', function (e) { onDone(JSON.parse(e.data).payload); });

// ---- send -----------------------------------------------------------------

function send() {
  var text = inputEl.value.trim();
  if (!text || streaming) return;
  addUserBubble(text);
  inputEl.value = '';
  streaming = true;
  sendBtn.disabled = true;
  stepEl.textContent = '';
  assistant = null;
  setStatus('starting…');
  fetch('/api/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text })
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      return { ok: res.ok, status: res.status, data: data };
    });
  }).then(function (r) {
    if (!r.ok) {
      setStatus('error: ' + (r.data.error || r.status));
      streaming = false;
      sendBtn.disabled = false;
      return;
    }
    if (currentTurn === null) currentTurn = r.data.turn;
    ensureAssistant();
    setStatus('streaming');
  }).catch(function (err) {
    setStatus('error: ' + err.message);
    streaming = false;
    sendBtn.disabled = false;
  });
}

sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

// ---- header info ----------------------------------------------------------

fetch('/api/health').then(function (r) { return r.json(); }).then(function (d) {
  $('#model').textContent = d.model;
  $('#model').title = 'base_url: ' + d.base_url;
}).catch(function () { $('#model').textContent = 'offline'; });

inputEl.focus();
