<script>
  (function () {
    const API_URL = "https://pjifitness-chat-api.vercel.app/api/chat";
    const TTS_URL = "https://pjifitness-chat-api.vercel.app/api/generate-speech";

    const input = document.getElementById("pj-chat-input");
    const chatLog = document.getElementById("pj-chat-log");
    const sendBtn = document.getElementById("pj-chat-send");
    const micBtn = document.getElementById("pj-mic-btn");
    const textBtn = document.getElementById("pj-keyboard-btn");
    const muteBtn = document.getElementById("pj-mute-btn");
    const stopBtn = document.getElementById("pj-stop-btn");
    const statusText = document.getElementById("pj-status-text");

    const inlineTip = document.getElementById("pj-inline-tip");
    const inlineTipClose = document.getElementById("pj-inline-tip-close");

    // upload elements
    const uploadBtn = document.getElementById("pj-upload-btn");
    const fileInput = document.getElementById("pj-file-input");

    // typing indicator element
    const typingIndicator = document.getElementById("pj-typing-indicator");

    // first-time panel elements
    const firstTimePanel = document.getElementById("pj-first-time-panel");
    const firstTimeClose = document.getElementById("pj-first-time-close");
    const quickStartButtons = document.querySelectorAll(".pj-quick-start");

    // checklist elements
    const checklistItems = document.querySelectorAll(".pj-check-item");
    const checklistCard = document.getElementById("pj-daily-checklist");

    let currentThreadId = null;
    let isSending = false;
    let isMuted = false;
    let audioPlayer = null;

    // ---------- Shared identifiers (email-based keys) ----------
    const customerEmail = (window.pjCustomerEmail || "guest").toLowerCase();
    const CHECKLIST_KEY_PREFIX = "pjifit_daily_checklist_" + customerEmail + "_";
    const FIRST_TIME_KEY = "pjifit_first_time_done_" + customerEmail;
    const ONBOARDING_SAVED_KEY = "pjifit_onboarding_saved_" + customerEmail;

    // ---------- Helpers: daily checklist & onboarding state ----------
    function getTodayKey() {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      return CHECKLIST_KEY_PREFIX + today;
    }

    function loadChecklistState() {
      const key = getTodayKey();
      try {
        const raw = localStorage.getItem(key);
        if (!raw) {
          return { weight: false, calories: false, steps: false, mood: false };
        }
        const parsed = JSON.parse(raw);
        return Object.assign({ weight: false, calories: false, steps: false, mood: false }, parsed);
      } catch (e) {
        return { weight: false, calories: false, steps: false, mood: false };
      }
    }

    function saveChecklistState(state) {
      const key = getTodayKey();
      localStorage.setItem(key, JSON.stringify(state));
    }

    let checklistState = loadChecklistState();

    function updateChecklistUI() {
      if (!checklistItems) return;
      checklistItems.forEach((item) => {
        const taskId = item.getAttribute("data-task-id");
        const done = checklistState[taskId];
        if (done) {
          item.classList.add("completed");
        } else {
          item.classList.remove("completed");
        }
      });
    }

    function toggleTask(taskId) {
      if (!taskId) return;
      checklistState[taskId] = !checklistState[taskId];
      saveChecklistState(checklistState);
      updateChecklistUI();
    }

    function markTaskComplete(taskId) {
      if (!taskId) return;
      if (checklistState[taskId]) return; // already done
      checklistState[taskId] = true;
      saveChecklistState(checklistState);
      updateChecklistUI();
    }

    // basic heuristic to detect which tasks are covered in a message
    function analyzeMessageForChecklist(message) {
      const text = (message || "").toLowerCase();

      // weight
      if (/\bweight\b|\bweigh\b|\blbs?\b|\bpounds?\b/.test(text)) {
        markTaskComplete("weight");
      }

      // calories / meals
      if (/\bcalories?\b|\bcals?\b|\bkcal\b|\bmeal\b|\bmeals\b|\bate\b/.test(text)) {
        markTaskComplete("calories");
      }

      // steps
      if (/\bsteps?\b|\bstep count\b|\bwalking\b|\bwalked\b/.test(text)) {
        markTaskComplete("steps");
      }

      // mood / struggle / feeling
      if (/\bmood\b|\bstruggle\b|\bstruggling\b|\bfeel\b|\bfeeling\b|\bstress(ed)?\b|\banxious\b|\bmotivated\b|\btired\b/.test(text)) {
        markTaskComplete("mood");
      }
    }

    // init checklist completion UI
    updateChecklistUI();

    // determine if onboarding already done for this user
    const alreadySeenOnboarding = localStorage.getItem(FIRST_TIME_KEY) === "1";

    // show/hide checklist & onboarding panel appropriately
    if (checklistCard) {
      checklistCard.style.display = alreadySeenOnboarding ? "block" : "none";
    }

    if (firstTimePanel) {
      firstTimePanel.style.display = alreadySeenOnboarding ? "none" : "block";
    }

    // manual click handling for checklist (user can manually tick/untick)
    if (checklistItems && checklistItems.length) {
      checklistItems.forEach((item) => {
        item.addEventListener("click", () => {
          const taskId = item.getAttribute("data-task-id");
          toggleTask(taskId);
        });
      });
    }

    // ---------- Onboarding parsing & save to Shopify ----------

    function parseOnboardingFromText(message) {
      if (!message) return null;
      const text = message.toLowerCase();

      // current/start weight (e.g. "I'm 190 pounds", "weight is 190 lbs")
      let startWeight = null;
      const weightMatch = text.match(/(\d{2,3})\s*(?:lbs?|pounds?)/);
      if (weightMatch) {
        startWeight = parseInt(weightMatch[1], 10);
      }

      // goal weight (e.g. "goal is 175", "want to get to 175", "down to 175")
      let goalWeight = null;
      const goalMatch = text.match(/(?:goal|to|get to|down to)\s*(\d{2,3})/);
      if (goalMatch) {
        goalWeight = parseInt(goalMatch[1], 10);
      }

      // age (e.g. "I'm 42", "I am 42 years old")
      let age = null;
      const ageMatch = text.match(/(?:age|i'm|i am)\s*(\d{2})\b/);
      if (ageMatch) {
        age = parseInt(ageMatch[1], 10);
      }

      // height (e.g. "5'9", "5’9", "5 foot 9")
      let heightFeet = null;
      let heightInches = null;
      const heightMatch1 = text.match(/(\d)\s*(?:'|’)\s*(\d{1,2})/);
      const heightMatch2 = text.match(/(\d)\s*foot\s*(\d{1,2})/);
      if (heightMatch1) {
        heightFeet = parseInt(heightMatch1[1], 10);
        heightInches = parseInt(heightMatch1[2], 10);
      } else if (heightMatch2) {
        heightFeet = parseInt(heightMatch2[1], 10);
        heightInches = parseInt(heightMatch2[2], 10);
      }

      // avg steps (e.g. "8000 steps", "about 8,000 steps a day")
      let avgSteps = null;
      const stepsMatch = text.match(/(\d{3,6})\s*steps/);
      if (stepsMatch) {
        avgSteps = parseInt(stepsMatch[1].replace(/,/g, ""), 10);
      }

      // alcohol nights (e.g. "1 night of alcohol", "2 nights of drinking")
      let alcoholNights = null;
      const alcoholMatch = text.match(/(\d+)\s*night[s]?\s*(?:of)?\s*(?:alcohol|drinking)/);
      if (alcoholMatch) {
        alcoholNights = parseInt(alcoholMatch[1], 10);
      }

      // meals out (e.g. "1 meal out", "2 meals out per week")
      let mealsOut = null;
      const mealsOutMatch = text.match(/(\d+)\s*meal[s]?\s*out/);
      if (mealsOutMatch) {
        mealsOut = parseInt(mealsOutMatch[1], 10);
      }

      // If we don't at least have weight + goal, skip
      if (!startWeight && !goalWeight && !age && !heightFeet && !avgSteps) {
        return null;
      }

      return {
        startWeight,
        goalWeight,
        age,
        heightFeet,
        heightInches,
        avgSteps,
        alcoholNights,
        mealsOut,
      };
    }

    async function saveOnboardingToShopify(onboarding) {
      try {
        await fetch("/api/save-onboarding", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: customerEmail,
            ...onboarding,
          }),
        });
        localStorage.setItem(ONBOARDING_SAVED_KEY, "1");
      } catch (err) {
        console.error("Error saving onboarding:", err);
      }
    }

    // ---------- Message Helpers (modern UI) ----------
    function appendMessage(role, text) {
      const wrapper = document.createElement("div");
      wrapper.className = "pj-message " + (role === "user" ? "pj-message-user" : "pj-message-assistant");

      const name = document.createElement("div");
      name.className = "pj-message-name";
      name.textContent = role === "user" ? "You" : "Coach";

      const bubble = document.createElement("div");
      bubble.className = "pj-message-bubble";
      bubble.textContent = text;

      wrapper.appendChild(name);
      wrapper.appendChild(bubble);
      chatLog.appendChild(wrapper);
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    // image bubble for user uploads
    function appendImageMessage(role, imageBase64) {
      const wrapper = document.createElement("div");
      wrapper.className = "pj-message " + (role === "user" ? "pj-message-user" : "pj-message-assistant");

      const name = document.createElement("div");
      name.className = "pj-message-name";
      name.textContent = role === "user" ? "You" : "Coach";

      const bubble = document.createElement("div");
      bubble.className = "pj-message-bubble";

      const img = document.createElement("img");
      img.src = imageBase64;

      bubble.appendChild(img);
      wrapper.appendChild(name);
      wrapper.appendChild(bubble);
      chatLog.appendChild(wrapper);
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    // ---------- TTS ----------
    async function playAssistantAudio(text) {
      if (!text || isMuted) return;

      try {
        const res = await fetch(TTS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text })
        });

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);

        if (audioPlayer) {
          audioPlayer.pause();
          URL.revokeObjectURL(audioPlayer.src);
        }

        audioPlayer = new Audio(url);
        audioPlayer.play();
      } catch (err) {
        console.error("TTS error:", err);
      }
    }

    // ---------- Send to API (supports optional image) ----------
    async function sendToAPI(message, imageBase64, imageName) {
      if ((!message && !imageBase64) || isSending) return;

      isSending = true;

      // 🔵 Show clear "Coach is replying…" state (orange)
      statusText.textContent = "Coach is replying…";
      statusText.style.color = "#f97316";
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending...";
      if (typingIndicator) {
        typingIndicator.classList.add("visible");
      }

      try {
        const body = {
          message: message || "",
          threadId: currentThreadId
        };

        if (imageBase64) {
          body.imageBase64 = imageBase64;
          if (imageName) body.imageName = imageName;
        }

        const res = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });

        const data = await res.json();
        currentThreadId = data.threadId || currentThreadId;

        const reply = data.reply || "...";
        appendMessage("assistant", reply);
        playAssistantAudio(reply);

      } catch (err) {
        console.error("TTS error:", err);
        appendMessage("assistant", "Network error. Try again.");
      } finally {
        isSending = false;
        statusText.textContent = "ready";
        statusText.style.color = "#cbd5f5";
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
        if (typingIndicator) {
          typingIndicator.classList.remove("visible");
        }
      }
    }

    // ---------- Send handlers ----------
    function handleSend() {
      // stop any current voice playback when sending a new message
      if (audioPlayer) {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
      }

      const msg = input.value.trim();
      if (!msg) return;

      // 🔁 Try to parse onboarding from this message (only once per user)
      if (!localStorage.getItem(ONBOARDING_SAVED_KEY)) {
        const onboarding = parseOnboardingFromText(msg);
        if (onboarding) {
          saveOnboardingToShopify(onboarding);
        }
      }

      appendMessage("user", msg);
      analyzeMessageForChecklist(msg); // auto-complete checklist
      input.value = "";
      sendToAPI(msg, null, null);
    }

    sendBtn.addEventListener("click", handleSend);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // ---------- Image upload handlers ----------
    uploadBtn.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        const imageBase64 = reader.result; // data:image/...;base64,xxxx

        // Show image in the chat as "You"
        appendImageMessage("user", imageBase64);

        // Use whatever is in the text box as caption or a default prompt
        const caption =
          input.value.trim() ||
          "Please analyze this photo for calories, nutrition, or what you see.";

        analyzeMessageForChecklist(caption); // might include calories info
        input.value = "";
        sendToAPI(caption, imageBase64, file.name);
      };
      reader.readAsDataURL(file);
    });

    // ---------- One-time inline tip close ----------
    if (inlineTipClose) {
      inlineTipClose.addEventListener("click", () => {
        inlineTip.style.display = "none";
        localStorage.setItem("pjifit_inline_tip_seen", "1");
      });
    }

    // ---------- Voice Chat button ----------
    micBtn.addEventListener("click", () => {
      // Focus text box & highlight
      input.focus();
      input.style.boxShadow = "0 0 0 2px #f97316";
      input.style.borderColor = "#f97316";

      statusText.textContent = "Tap the mic on your keyboard to talk, then press Send.";
      statusText.style.color = "#f97316";

      // Show inline tip only the first time
      if (!localStorage.getItem("pjifit_inline_tip_seen")) {
        inlineTip.style.display = "block";
      }

      setTimeout(() => {
        input.style.boxShadow = "none";
        input.style.borderColor = "rgba(148,163,184,0.8)";
        statusText.textContent = "ready";
        statusText.style.color = "#cbd5f5";
      }, 5000);
    });

    // ---------- Text mode ----------
    textBtn.addEventListener("click", () => input.focus());

    // ---------- Mute ----------
    muteBtn.addEventListener("click", () => {
      isMuted = !isMuted;
      muteBtn.textContent = isMuted ? "Unmute" : "Mute";
      if (audioPlayer) audioPlayer.pause();
    });

    // ---------- Stop Voice ----------
    stopBtn.addEventListener("click", () => {
      if (audioPlayer) {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
      }
    });

    // ---------- First-time guide logic ----------
    function hideFirstTimePanel() {
      if (firstTimePanel) {
        firstTimePanel.style.display = "none";
      }
      if (checklistCard) {
        checklistCard.style.display = "block"; // show checklist AFTER onboarding done
      }
      localStorage.setItem(FIRST_TIME_KEY, "1");
    }

    if (firstTimeClose) {
      firstTimeClose.addEventListener("click", hideFirstTimePanel);
    }

    // Quick-start buttons: drop in a smart first message and send it
    if (quickStartButtons && quickStartButtons.length) {
      quickStartButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const template = btn.getAttribute("data-pj-quick-start") || "";
          if (!template) return;

          input.value = template;
          hideFirstTimePanel();

          const msg = input.value.trim();
          if (!msg) return;

          // Try to parse/save onboarding from the quick-start message
          if (!localStorage.getItem(ONBOARDING_SAVED_KEY)) {
            const onboarding = parseOnboardingFromText(msg);
            if (onboarding) {
              saveOnboardingToShopify(onboarding);
            }
          }

          appendMessage("user", msg);
          analyzeMessageForChecklist(msg); // onboarding message may hit some tasks
          input.value = "";
          sendToAPI(msg, null, null);
        });
      });
    }
  })();
</script>
