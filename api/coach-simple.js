/* chat.js — PJ Coach Frontend
   - ChatGPT-like UI
   - Sends history + onboarded flag
   - Typewriter assistant
   - LocalStorage persistence
*/

(function () {
  "use strict";

  // =========================
  // CONFIG
  // =========================
  const API_URL = "https://pjifitness-chat-api.vercel.app/api/coach-simple";

  // DOM selectors (works with your existing HTML if ids match; otherwise it will create UI)
  const SEL = {
    root: "#pj-coach-chat",           // optional root container
    messages: "#pj-chat-messages",    // messages container
    form: "#pj-chat-form",            // form
    input: "#pj-chat-input",          // textarea/input
    send: "#pj-chat-send"             // send button
  };

  // LocalStorage keys
  const LS = {
    history: "PJ_CHAT_HISTORY_V1",
    onboarded: "PJ_ONBOARDED"
  };

  // History settings
  const MAX_HISTORY = 20;

  // Typewriter settings
  const TYPE_MS = 10;          // per-character delay
  const TYPE_CHUNK = 3;        // chars per tick
  const TYPE_MAX_MS = 4000;    // hard cap so long replies don't take forever

  // If your theme already has styling, set this false.
  const INJECT_BASE_STYLES = true;

  // =========================
  // Utilities
  // =========================
  function $(q, root) {
    return (root || document).querySelector(q);
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatTextToHtml(text) {
    return escapeHtml(text).replace(/\n/g, "<br>");
  }

  function normalizeText(s) {
    return String(s || "").trim();
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(LS.history);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-MAX_HISTORY);
    } catch {
      return [];
    }
  }

  function saveHistory(history) {
    try {
      localStorage.setItem(LS.history, JSON.stringify(history.slice(-MAX_HISTORY)));
    } catch {}
  }

  function isOnboarded() {
    return localStorage.getItem(LS.onboarded) === "1";
  }

  function setOnboarded() {
    try { localStorage.setItem(LS.onboarded, "1"); } catch {}
  }

  function scrollToBottom(el) {
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  // =========================
  // UI creation / styling
  // =========================
  function injectStyles() {
    if (!INJECT_BASE_STYLES) return;
    if (document.getElementById("pj-chatjs-style")) return;

    const css = `
      #pj-coach-chat{max-width:720px;margin:0 auto;padding:12px;}
      #pj-chat-messages{display:flex;flex-direction:column;gap:10px;min-height:260px;max-height:60vh;overflow:auto;padding:10px;border:1px solid rgba(0,0,0,.08);border-radius:14px;background:#fff;}
      .pj-msg{display:flex;flex-direction:column;gap:4px;max-width:85%;}
      .pj-msg--user{align-self:flex-end;text-align:left;}
      .pj-msg--assistant{align-self:flex-start;}
      .pj-bubble{padding:10px 12px;border-radius:14px;line-height:1.35;font-size:15px;word-wrap:break-word;white-space:normal;}
      .pj-bubble--user{background:#f1f5f9;color:#0f172a;border-top-right-radius:6px;}
      .pj-text--assistant{color:#334155;font-size:15px;line-height:1.45;padding:2px 2px;}
      #pj-chat-form{display:flex;gap:10px;align-items:flex-end;margin-top:10px;}
      #pj-chat-input{flex:1;min-height:44px;max-height:140px;resize:vertical;padding:10px 12px;border-radius:12px;border:1px solid rgba(0,0,0,.12);font-size:16px;line-height:1.3;outline:none;}
      #pj-chat-input:focus{border-color:rgba(34,197,94,.6);box-shadow:0 0 0 3px rgba(34,197,94,.12);}
      #pj-chat-send{background:#22c55e;border:none;color:#fff;padding:10px 14px;border-radius:12px;font-weight:700;cursor:pointer;min-width:92px;}
      #pj-chat-send:disabled{opacity:.6;cursor:not-allowed;}
      .pj-typing{font-size:14px;color:#64748b;padding:2px 2px;}
      .pj-welcome{color:#334155;font-size:14px;margin:0 0 10px 2px;}
    `;

    const style = document.createElement("style");
    style.id = "pj-chatjs-style";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function ensureUI() {
    injectStyles();

    let root = $(SEL.root);
    if (!root) {
      root = document.createElement("div");
      root.id = SEL.root.replace("#", "");
      document.body.appendChild(root);
    }

    let messages = $(SEL.messages, root);
    let form = $(SEL.form, root);
    let input = $(SEL.input, root);
    let send = $(SEL.send, root);

    // Create minimal UI if not present
    if (!messages || !form || !input || !send) {
      root.innerHTML = `
        <div class="pj-welcome" id="pj-chat-welcome">
          Log meals or ask anything — I’ll keep a running total and give you easy lower-cal swaps.
        </div>
        <div id="pj-chat-messages"></div>
        <form id="pj-chat-form" autocomplete="off">
          <textarea id="pj-chat-input" placeholder="Type a meal log or a question…"></textarea>
          <button id="pj-chat-send" type="submit">Send</button>
        </form>
      `;
      messages = $("#pj-chat-messages", root);
      form = $("#pj-chat-form", root);
      input = $("#pj-chat-input", root);
      send = $("#pj-chat-send", root);
    }

    // iOS zoom prevention
    try { input.style.fontSize = "16px"; } catch {}

    return { root, messages, form, input, send };
  }

  // =========================
  // Render messages
  // =========================
  function renderMessage(messagesEl, role, content) {
    const wrap = document.createElement("div");
    wrap.className = `pj-msg ${role === "user" ? "pj-msg--user" : "pj-msg--assistant"}`;

    if (role === "user") {
      const bubble = document.createElement("div");
      bubble.className = "pj-bubble pj-bubble--user";
      bubble.innerHTML = formatTextToHtml(content);
      wrap.appendChild(bubble);
    } else {
      const txt = document.createElement("div");
      txt.className = "pj-text--assistant";
      txt.innerHTML = formatTextToHtml(content);
      wrap.appendChild(txt);
    }

    messagesEl.appendChild(wrap);
    scrollToBottom(messagesEl);
    return wrap;
  }

  function renderHistory(messagesEl, history) {
    messagesEl.innerHTML = "";
    history.forEach(m => renderMessage(messagesEl, m.role, m.content));
    scrollToBottom(messagesEl);
  }

  // =========================
  // Typewriter assistant
  // =========================
  function typewriter(messagesEl, fullText) {
    return new Promise(resolve => {
      const wrap = document.createElement("div");
      wrap.className = "pj-msg pj-msg--assistant";
      const txt = document.createElement("div");
      txt.className = "pj-text--assistant";
      wrap.appendChild(txt);
      messagesEl.appendChild(wrap);
      scrollToBottom(messagesEl);

      const start = Date.now();
      let i = 0;

      function tick() {
        const elapsed = Date.now() - start;
        if (i >= fullText.length || elapsed >= TYPE_MAX_MS) {
          txt.innerHTML = formatTextToHtml(fullText);
          scrollToBottom(messagesEl);
          return resolve();
        }
        i = Math.min(fullText.length, i + TYPE_CHUNK);
        txt.innerHTML = formatTextToHtml(fullText.slice(0, i));
        scrollToBottom(messagesEl);
        setTimeout(tick, TYPE_MS);
      }

      tick();
    });
  }

  function showTyping(messagesEl) {
    const el = document.createElement("div");
    el.className = "pj-typing";
    el.textContent = "PJ Coach is typing…";
    messagesEl.appendChild(el);
    scrollToBottom(messagesEl);
    return el;
  }

  // =========================
  // Send message
  // =========================
  async function sendMessage(ui, history, userText) {
    const msg = normalizeText(userText);
    if (!msg) return;

    renderMessage(ui.messages, "user", msg);
    history.push({ role: "user", content: msg });
    saveHistory(history);

    ui.send.disabled = true;
    const typingEl = showTyping(ui.messages);

    try {
      const payload = {
        message: msg,
        history: history.slice(-MAX_HISTORY),
        onboarded: isOnboarded()
      };

      const resp = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await resp.json().catch(() => ({}));

      if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);

      if (!resp.ok) {
        const errText = data?.reply || data?.error || "Request failed.";
        renderMessage(ui.messages, "assistant", `Something went wrong: ${errText}`);
        return;
      }

      if (data && data.set_onboarded) setOnboarded();

      const reply = String(data?.reply || "I didn't catch that — try again.").trim();

      await typewriter(ui.messages, reply);

      history.push({ role: "assistant", content: reply });
      saveHistory(history);

    } catch (e) {
      if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
      renderMessage(ui.messages, "assistant", "Network error — please try again.");
    } finally {
      ui.send.disabled = false;
      ui.input.focus();
    }
  }

  // =========================
  // Boot
  // =========================
  function boot() {
    const ui = ensureUI();
    let history = loadHistory();
    renderHistory(ui.messages, history);

    // Welcome message only when there's no history
    if (history.length === 0) {
      const welcome =
        "Welcome — log meals in plain English and I’ll estimate calories, keep a running total, and give you 1–2 realistic lower-cal swaps. You can also ask anything about cravings, motivation, plateaus, or what to do next.\n\nFor now, just focus on logging your next meal.";
      renderMessage(ui.messages, "assistant", welcome);
      history.push({ role: "assistant", content: welcome });
      saveHistory(history);
    }

    ui.form.addEventListener("submit", function (e) {
      e.preventDefault();
      const text = ui.input.value;
      ui.input.value = "";
      sendMessage(ui, history, text);
    });

    // Enter to send; Shift+Enter for newline
    ui.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        ui.form.requestSubmit();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
