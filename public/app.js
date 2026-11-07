// --- HARDCODED DEVELOPER CONFIGURATION FOR GRADE SECTIONS AND STRANDS ---
const grade11Sections = ["Excellence", "Resilience", "Discipline", "Accountability", "Stewardship"];
const grade12Strands = ["STEM", "ABM", "HUMSS", "TVL-ICT", "TVL-HE"];

function getElement(id) {
  return document.getElementById(id);
}

function apiUrl(path) {
  const base = String(window.SAPC_API_BASE_URL || "").replace(/\/+$/, "");
  return `${base}${path}`;
}

let cards = [];
let i = 0;
let typingTimeout = null;
let choiceFlipTimeout = null;
let selectedImages = [];
const notesInput = getElement("notes");
const notesCount = getElement("notes-count");
if (notesInput && notesCount) {
  const updateNotesCount = () => {
    const count = notesInput.value.length;
    notesCount.textContent = `${count.toLocaleString()} character${count === 1 ? "" : "s"}`;
  };
  notesInput.addEventListener("input", updateNotesCount);
  updateNotesCount();
}

let selectedGrade = "Grade 11";
let selectedStrand = grade11Sections[0];
let selectedSubjectMode = "general";
let editingIndex = null;

// --- SCORE COUNTER & ANSWER TRACKING STATE ---
let answeredState = {}; 
let studyStartedAt = Date.now();
let activeDeckId = null;

function updateSpacedRepetition(card, isCorrect) {
  const previous = card.srs || { interval: 0, ease: 2.5, repetitions: 0 };
  if (isCorrect) {
    previous.repetitions += 1;
    previous.interval = previous.interval === 0 ? 1 : Math.max(1, Math.round(previous.interval * previous.ease));
    previous.ease = Math.min(3, previous.ease + 0.1);
  } else {
    previous.repetitions = 0;
    previous.interval = 0;
    previous.ease = Math.max(1.3, previous.ease - 0.2);
  }
  previous.dueAt = Date.now() + previous.interval * 24 * 60 * 60 * 1000;
  card.srs = previous;
}

function saveLocalProgress() {
  const progress = JSON.parse(localStorage.getItem("sapc_progress") || '{"sessions":[],"reviews":{}}');
  progress.sessions = Array.isArray(progress.sessions) ? progress.sessions : [];
  progress.reviews = progress.reviews || {};
  cards.forEach((card, index) => {
    if (card.srs) progress.reviews[card.question] = card.srs;
  });
  localStorage.setItem("sapc_progress", JSON.stringify(progress));
}

function resetQuizScore() {
  answeredState = {};
  updateScoreUI();
}

function getCorrectCount() {
  return Object.values(answeredState).filter(st => st.isCorrect).length;
}

function updateScoreUI() {
  const liveScorePill = getElement("live-score-pill");
  if (liveScorePill) {
    liveScorePill.textContent = `Score: ${getCorrectCount()} / ${cards.length}`;
  }
}

// --- CONFETTI & WRONG FEEDBACK EFFECTS ---
function triggerConfetti() {
  if (typeof confetti === "function") {
    confetti({
      particleCount: 75,
      spread: 70,
      origin: { y: 0.6 },
      colors: ['#7a1c1c', '#d4af37', '#ffffff', '#e5b842']
    });
  }
}

function triggerWrongXEffect(parentContainer) {
  if (!parentContainer) parentContainer = getElement("card");
  
  const existingX = parentContainer.querySelector(".wrong-x-overlay");
  if (existingX) existingX.remove();

  const xBadge = document.createElement("div");
  xBadge.className = "wrong-x-overlay";
  xBadge.textContent = "âŒ";
  parentContainer.appendChild(xBadge);

  setTimeout(() => {
    xBadge.remove();
  }, 750);
}

// --- SUMMARY END-OF-DECK SCREEN ---
function showDeckSummary() {
  stopSpeech(true);
  getElement("card").classList.add("hidden");
  getElement("typed-answer-entry").classList.add("hidden");
  getElement("hint-text").classList.add("hidden");
  getElement("study-controls").classList.add("hidden");

  const quizSummary = getElement("quiz-summary");
  const summaryPercentage = getElement("summary-percentage");
  const summaryScoreText = getElement("summary-score-text");
  const summaryMessage = getElement("summary-message");

  const totalCards = cards.length;
  const correctCount = getCorrectCount();
  const percentage = totalCards > 0 ? Math.round((correctCount / totalCards) * 100) : 0;

  summaryPercentage.textContent = `${percentage}%`;
  summaryScoreText.textContent = `${correctCount} of ${totalCards} Correct`;

  if (percentage >= 90) {
    summaryMessage.textContent = "ðŸŒŸ Outstanding! You have thoroughly mastered this study material!";
    triggerConfetti();
  } else if (percentage >= 75) {
    summaryMessage.textContent = "ðŸ‘ Great job! You have a solid grasp of most concepts.";
  } else if (percentage >= 50) {
    summaryMessage.textContent = "ðŸ‘ Good effort! Review the missed cards again to build full recall.";
  } else {
    summaryMessage.textContent = "ðŸ’ª Keep practicing! Go over the lesson notes and try the deck again.";
  }

  quizSummary.classList.remove("hidden");
  const session = {
    date: new Date().toISOString(),
    correct: correctCount,
    total: totalCards,
    durationSeconds: Math.round((Date.now() - studyStartedAt) / 1000)
  };
  const progress = JSON.parse(localStorage.getItem("sapc_progress") || '{"sessions":[],"reviews":{}}');
  progress.sessions = [...(progress.sessions || []).slice(-99), session];
  localStorage.setItem("sapc_progress", JSON.stringify(progress));
  saveLocalProgress();
  const user = window.sapcFirebase?.getCurrentUser();
  if (user) {
    window.sapcFirebase.recordStudySession(user, session).catch(error => {
      console.error("Could not save study session:", error);
    });
  }
  renderProgressDashboard();
}

const restartDeckBtn = getElement("restart-deck-btn");
if (restartDeckBtn) {
  restartDeckBtn.addEventListener("click", () => {
    getElement("quiz-summary").classList.add("hidden");
    getElement("card").classList.remove("hidden");
    getElement("hint-text").classList.remove("hidden");
    getElement("study-controls").classList.remove("hidden");
    resetQuizScore();
    i = 0;
    show(true);
  });
}

// --- Browser Speech API TTS & Auto-Narration System ---
let selectedVoiceURI = localStorage.getItem("sapc_selected_voice") || "";
let currentSpeakingBtn = null;
let currentUtterance = null;
let isPaused = false;
let isAutoNarrating = false;
let autoNarrateTimeout = null;

function populateVoiceList() {
  if (!('speechSynthesis' in window)) return;
  const voiceSelect = getElement("voice-select");
  if (!voiceSelect) return;

  const voices = window.speechSynthesis.getVoices();
  voiceSelect.replaceChildren();

  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "Auto / System Default";
  voiceSelect.append(defaultOpt);

  voices.forEach(voice => {
    const option = document.createElement("option");
    option.value = voice.voiceURI;
    option.textContent = `${voice.name} (${voice.lang})`;
    if (voice.voiceURI === selectedVoiceURI) {
      option.selected = true;
    }
    voiceSelect.append(option);
  });
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = populateVoiceList;
  populateVoiceList();
}

function resetSpeakingState() {
  if (currentSpeakingBtn) {
    currentSpeakingBtn.classList.remove("active");
    currentSpeakingBtn.innerHTML = "ðŸ”Š";
    currentSpeakingBtn.setAttribute("title", "Listen to narration");
    currentSpeakingBtn = null;
  }
  isPaused = false;
  currentUtterance = null;
}

function stopSpeech(clearAuto = true) {
  if (autoNarrateTimeout) {
    clearTimeout(autoNarrateTimeout);
    autoNarrateTimeout = null;
  }
  if (clearAuto) {
    isAutoNarrating = false;
  }
  if ('speechSynthesis' in window) {
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
    window.speechSynthesis.cancel();
  }
  resetSpeakingState();
}

function handleAutoNarrateNext() {
  if (!isAutoNarrating || cards.length === 0) return;

  const isFlipped = getElement("card").classList.contains("flipped");

  if (!isFlipped) {
    autoNarrateTimeout = setTimeout(() => {
      if (!isAutoNarrating) return;
      getElement("card").classList.add("flipped");

      autoNarrateTimeout = setTimeout(() => {
        if (!isAutoNarrating) return;
        let fullAnswer = cards[i].answer;
        if (cards[i].explanation) {
          fullAnswer += ". Explanation: " + cards[i].explanation;
        }
        const backPlayBtn = getElement("back").querySelector(".play-pause-btn");
        speakText(fullAnswer, backPlayBtn);
      }, 600);
    }, 1200);
  } else {
    autoNarrateTimeout = setTimeout(() => {
      if (!isAutoNarrating) return;
      if (i >= cards.length - 1) {
        showDeckSummary();
        return;
      }
      i++;
      show(false);

      autoNarrateTimeout = setTimeout(() => {
        if (!isAutoNarrating) return;
        const frontPlayBtn = getElement("front").querySelector(".play-pause-btn");
        if (frontPlayBtn) {
          speakText(cleanQuestionDisplay(cards[i].question), frontPlayBtn);
        }
      }, 600);
    }, 1500);
  }
}

function speakText(text, btnElement) {
  stopSpeech(false);
  if (!text) return;

  setTimeout(() => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;

    const voices = window.speechSynthesis.getVoices();
    if (selectedVoiceURI) {
      const matchedVoice = voices.find(v => v.voiceURI === selectedVoiceURI);
      if (matchedVoice) utterance.voice = matchedVoice;
    } else {
      utterance.lang = 'en-US';
    }

    currentSpeakingBtn = btnElement;
    currentUtterance = utterance;
    isPaused = false;

    if (btnElement) {
      btnElement.classList.add("active");
      btnElement.innerHTML = "â¸ï¸";
      btnElement.setAttribute("title", "Stop narration");
    }

    utterance.onend = () => {
      if (currentUtterance === utterance) {
        resetSpeakingState();
      }
    };

    utterance.onerror = () => {
      if (currentUtterance === utterance) {
        resetSpeakingState();
      }
    };

    window.speechSynthesis.speak(utterance);
  }, 50);
}

function toggleSpeech(text, btnElement) {
  if (!('speechSynthesis' in window)) {
    alert("Text-to-speech is not supported in this browser.");
    return;
  }

  if (window.speechSynthesis.speaking || isPaused) {
    stopSpeech(true);
    return;
  }

  speakText(text, btnElement);
}

function createAudioControlsGroup(getTextToSpeak) {
  const container = document.createElement("div");
  container.className = "card-audio-controls";

  const rewindBtn = document.createElement("button");
  rewindBtn.type = "button";
  rewindBtn.className = "narrate-btn rewind-btn";
  rewindBtn.title = "Rewind to beginning";
  rewindBtn.setAttribute("aria-label", "Rewind narration to beginning");
  rewindBtn.innerHTML = "âª";
  rewindBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stopSpeech(false);
    const playBtn = container.querySelector(".play-pause-btn");
    setTimeout(() => {
      speakText(getTextToSpeak(), playBtn);
    }, 60);
  });

  const playPauseBtn = document.createElement("button");
  playPauseBtn.type = "button";
  playPauseBtn.className = "narrate-btn play-pause-btn";
  playPauseBtn.title = "Listen to narration";
  playPauseBtn.setAttribute("aria-label", "Listen to narration");
  playPauseBtn.innerHTML = "ðŸ”Š";
  playPauseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSpeech(getTextToSpeak(), playPauseBtn);
  });

  container.append(rewindBtn, playPauseBtn);
  return container;
}

const voiceSelectElem = getElement("voice-select");
if (voiceSelectElem) {
  voiceSelectElem.addEventListener("change", (e) => {
    selectedVoiceURI = e.target.value;
    localStorage.setItem("sapc_selected_voice", selectedVoiceURI);
  });
}

// --- Persistence Helpers ---
function saveCardsToStorage() {
  localStorage.setItem("sapc_flashcards", JSON.stringify(cards));
}

function loadCardsFromStorage() {
  const saved = localStorage.getItem("sapc_flashcards");
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        cards = parsed;
        i = 0;
        resetQuizScore();
        getElement("study").classList.remove("hidden");
        show();
      }
    } catch (e) {
      console.error("Failed to load saved cards", e);
    }
  }
}

// --- Landing Page Handler ---
const landingView = getElement("landing-view");
const appView = getElement("app-view");
const studyPanel = getElement("study");
const fullscreenToggle = getElement("fullscreen-toggle");

function showAppWorkspace() {
  if (landingView) landingView.classList.add("hidden");
  if (appView) appView.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showLandingPage() {
  if (appView) appView.classList.add("hidden");
  if (landingView) landingView.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

if (getElement("hero-start-btn")) getElement("hero-start-btn").addEventListener("click", showAppWorkspace);
if (getElement("nav-launch-btn")) getElement("nav-launch-btn").addEventListener("click", showAppWorkspace);
if (getElement("nav-brand-btn")) getElement("nav-brand-btn").addEventListener("click", showLandingPage);

function syncFullscreenToggle() {
  const isFullscreen = document.fullscreenElement === studyPanel || studyPanel.classList.contains("study-fullscreen");
  fullscreenToggle.textContent = isFullscreen ? "Exit fullscreen" : "Fullscreen";
  fullscreenToggle.setAttribute("aria-pressed", String(isFullscreen));
}

if (fullscreenToggle) {
  fullscreenToggle.addEventListener("click", async () => {
    if (document.fullscreenElement === studyPanel) {
      await document.exitFullscreen();
    } else if (studyPanel.classList.contains("study-fullscreen")) {
      studyPanel.classList.remove("study-fullscreen");
    } else if (document.fullscreenEnabled && studyPanel.requestFullscreen) {
      try {
        await studyPanel.requestFullscreen();
      } catch {
        studyPanel.classList.add("study-fullscreen");
      }
    } else {
      studyPanel.classList.add("study-fullscreen");
    }
    syncFullscreenToggle();
  });
}

document.addEventListener("fullscreenchange", syncFullscreenToggle);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && studyPanel.classList.contains("study-fullscreen")) {
    studyPanel.classList.remove("study-fullscreen");
    syncFullscreenToggle();
  }
});

// --- Theme Toggle ---
const themeToggle = getElement("theme-toggle");
if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    document.body.classList.toggle("dark-theme");
    const isDark = document.body.classList.contains("dark-theme");
    const themeLabel = getElement("theme-label");
    if (themeLabel) themeLabel.textContent = isDark ? "Light" : "Dark";
  });
}

// --- Firebase Authentication & User Session Management ---
let isRegisterMode = false;
const authScreen = getElement("auth-screen");
const authForm = getElement("auth-form");
const authTitle = getElement("auth-title");
const authSubmitBtn = getElement("auth-submit-btn");
const authSwitchBtn = getElement("auth-switch-btn");
const authError = getElement("auth-error");
const authPassword = getElement("auth-password");
const togglePasswordBtn = getElement("toggle-password-btn");
const authPasswordHint = getElement("auth-password-hint");

if (togglePasswordBtn && authPassword) {
  togglePasswordBtn.addEventListener("click", () => {
    const isPassword = authPassword.type === "password";
    authPassword.type = isPassword ? "text" : "password";
    const label = isPassword ? "Hide" : "Show";
    togglePasswordBtn.textContent = label;
    togglePasswordBtn.setAttribute("title", `${label} password`);
    togglePasswordBtn.setAttribute("aria-label", `${label} password`);
  });
}

function validatePasswordComplexity(password) {
  const hasMinLength = password.length >= 8;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);

  return hasMinLength && hasUpper && hasLower && hasNumber && hasSpecial;
}

function updateProfileUI(username, picture) {
  const userProfile = getElement("user-profile");
  const userNameDisplay = getElement("user-name-display");
  const userAvatar = getElement("user-avatar");
  const userAvatarImg = getElement("user-avatar-img");

  if (!userProfile) return;

  if (username) {
    if (userNameDisplay) userNameDisplay.textContent = username;

    if (picture && userAvatarImg) {
      userAvatarImg.src = picture;
      userAvatarImg.classList.remove("hidden");
      if (userAvatar) userAvatar.classList.add("hidden");
    } else if (userAvatar) {
      if (userAvatarImg) userAvatarImg.classList.add("hidden");
      userAvatar.textContent = username.charAt(0).toUpperCase();
      userAvatar.classList.remove("hidden");
    }

    userProfile.classList.remove("hidden");
  } else {
    userProfile.classList.add("hidden");
  }
}

function checkAuthSession() {
  const user = window.sapcFirebase?.getCurrentUser();
  if (user) {
    if (authScreen) authScreen.classList.add("hidden");
    document.body.classList.remove("auth-active");
    updateProfileUI(user.displayName || user.email || "Paduan", user.photoURL);
  } else {
    if (authScreen) authScreen.classList.remove("hidden");
    document.body.classList.add("auth-active");
    updateProfileUI(null, null);
  }
}

checkAuthSession();

const logoutBtn = getElement("logout-btn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    await window.sapcFirebase?.signOut();
    checkAuthSession();
    showLandingPage();
  });
}

if (authSwitchBtn) {
  authSwitchBtn.addEventListener("click", () => {
    isRegisterMode = !isRegisterMode;
    const usernameField = getElement("auth-display-username");
    const loginField = getElement("auth-username");
    usernameField?.classList.toggle("hidden", !isRegisterMode);
    if (usernameField) usernameField.required = isRegisterMode;
    if (loginField) {
      loginField.placeholder = isRegisterMode ? "Email address" : "Email address or username";
      loginField.autocomplete = isRegisterMode ? "email" : "username";
    }
    authTitle.textContent = isRegisterMode ? "Create Account" : "Welcome Paduan";
    authSubmitBtn.textContent = isRegisterMode ? "Sign Up" : "Log In";
    authSwitchBtn.textContent = isRegisterMode ? "Switch to Login" : "Register";
    authError.classList.add("hidden");

    authPassword.setAttribute("autocomplete", isRegisterMode ? "new-password" : "current-password");
    if (authPasswordHint) {
      authPasswordHint.classList.toggle("hidden", !isRegisterMode);
    }
  });
}

const emailField = getElement("auth-username");
const passwordReset = getElement("password-reset-btn");
if (authForm) {
  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    authError.classList.add("hidden");
    if (!window.sapcFirebase?.configured) {
      authError.textContent = "Firebase is not configured. Add your project values to public/firebase-config.js.";
      authError.classList.remove("hidden");
      return;
    }

    const identifier = getElement("auth-username").value.trim();
    const username = getElement("auth-display-username")?.value.trim().toLowerCase();
    const password = authPassword.value;

    if (isRegisterMode && !/^[a-z0-9._-]{3,24}$/.test(username || "")) {
      authError.textContent = "Username must be 3–24 characters using lowercase letters, numbers, dots, underscores, or hyphens.";
      authError.classList.remove("hidden");
      return;
    }
    if (isRegisterMode && !validatePasswordComplexity(password)) {
      authError.textContent = "Password must be at least 8 characters long and contain at least 1 uppercase letter, 1 lowercase letter, 1 number, and 1 special character.";
      authError.classList.remove("hidden");
      return;
    }

    try {
      if (isRegisterMode) {
        const available = await window.sapcFirebase.isUsernameAvailable(username);
        if (!available) throw new Error("That username is already taken.");
        const email = identifier.toLowerCase();
        if (!email.includes("@")) throw new Error("Registration requires an email address.");
        await window.sapcFirebase.register(email, password);
        await window.sapcFirebase.saveProfile(window.sapcFirebase.getCurrentUser(), {
          username,
          displayName: username
        });
        alert("Registration successful. You are now signed in.");
        isRegisterMode = false;
        authTitle.textContent = "Welcome Paduan";
        authSubmitBtn.textContent = "Log In";
        authSwitchBtn.textContent = "Register";
        authPassword.setAttribute("autocomplete", "current-password");
        if (authPasswordHint) authPasswordHint.classList.add("hidden");
      }
      if (!isRegisterMode) {
        const email = await window.sapcFirebase.resolveLoginEmail(identifier);
        await window.sapcFirebase.signIn(email, password);
        showAppWorkspace();
      }
    } catch (err) {
      authError.textContent = err.code === "auth/invalid-credential"
        ? "Invalid email or password."
        : (err.message || "Authentication failed.");
      authError.classList.remove("hidden");
    }
  });
}

const passwordResetBtn = getElement("password-reset-btn");
if (passwordResetBtn) {
  passwordResetBtn.addEventListener("click", async () => {
    if (!window.sapcFirebase?.configured) {
      authError.textContent = "Firebase is not configured yet.";
      authError.classList.remove("hidden");
      return;
    }
    const identifier = getElement("auth-username").value.trim();
    if (!identifier) {
      authError.textContent = "Enter your email address or username first.";
      authError.classList.remove("hidden");
      return;
    }
    try {
      const email = await window.sapcFirebase.resolveLoginEmail(identifier);
      await window.sapcFirebase.sendPasswordReset(email);
      authError.textContent = "Password reset email sent.";
      authError.classList.remove("hidden");
    } catch (err) {
      authError.textContent = err.message;
      authError.classList.remove("hidden");
    }
  });
}

async function handleGoogleSignIn() {
  try {
    if (!window.sapcFirebase?.configured) throw new Error("Firebase is not configured yet.");
    await window.sapcFirebase.signInWithGoogle();
    showAppWorkspace();
  } catch (err) {
    alert("Google Login Error: " + err.message);
  }
}

window.handleGoogleSignIn = handleGoogleSignIn;
getElement("google-signin-btn")?.addEventListener("click", handleGoogleSignIn);

if (window.sapcFirebase?.configured) {
  window.sapcFirebase.auth.onAuthStateChanged(async user => {
    if (user) {
      const profile = await window.sapcFirebase.ensureProfile(user);
      checkAuthSession();
      updateProfileUI(profile.displayName || user.email || "Paduan", profile.photoURL || user.photoURL);
      renderProgressDashboard();
      loadSavedDecks();
      loadFriends();
    } else {
      checkAuthSession();
    }
  });
}

// --- Subject API Mode Switcher ---
document.querySelectorAll("#subject-mode-container .subject-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#subject-mode-container .subject-btn").forEach(b => {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    selectedSubjectMode = btn.getAttribute("data-subject");
    stopSpeech(true);
    updateSelectionSummary();
    if (cards.length > 0) show(true);
  });
});

// --- Dynamic Strand / Section Renderer ---
function renderStrandSectionOptions() {
  const container = getElement("strand-container");
  const header = getElement("strand-section-header");
  const sub = getElement("strand-section-sub");

  if (!container) return;
  container.replaceChildren();

  const isGrade11 = selectedGrade === "Grade 11";
  const items = isGrade11 ? grade11Sections : grade12Strands;

  header.textContent = isGrade11 ? "Grade 11 Section" : "Academic Strand";
  sub.textContent = isGrade11 ? "Select class section focus:" : "Target testing focus for reviewer:";

  if (!items.includes(selectedStrand)) {
    selectedStrand = items[0];
  }

  items.forEach(itemText => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `selector-badge ${itemText === selectedStrand ? "active" : ""}`;
    btn.setAttribute("aria-pressed", itemText === selectedStrand ? "true" : "false");
    btn.setAttribute("data-value", itemText);

    const textSpan = document.createElement("span");
    textSpan.textContent = itemText;
    btn.append(textSpan);

    btn.addEventListener("click", () => {
      container.querySelectorAll(".selector-badge").forEach(b => {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");
      selectedStrand = itemText;
      updateSelectionSummary();
    });

    container.append(btn);
  });

  updateSelectionSummary();
}

function updateSelectionSummary() {
  const subjectDisplayNames = {
    general: "General",
    math: "Mathematics",
    filipino: "Filipino"
  };
  getElement("selection-summary").textContent = `Generating for ${selectedGrade} / ${selectedStrand} (${subjectDisplayNames[selectedSubjectMode]})`;
}

document.querySelectorAll("#grade-container .selector-badge").forEach(badge => {
  badge.addEventListener("click", () => {
    document.querySelectorAll("#grade-container .selector-badge").forEach(b => {
      b.classList.remove("active");
      b.setAttribute("aria-pressed", "false");
    });
    badge.classList.add("active");
    badge.setAttribute("aria-pressed", "true");
    selectedGrade = badge.getAttribute("data-value");
    renderStrandSectionOptions();
  });
});

renderStrandSectionOptions();

// --- Document Processing & File Previews ---
const imageInput = getElement("image");
const uploadDropZone = getElement("upload-drop-zone");
const imagePreviewUrls = new Map();

function isImageFile(file) {
  return file.type.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|heic|heif|avif|svg)$/i.test(file.name);
}

function renderImagePreviews() {
  const previewContainer = getElement("image-previews");
  imagePreviewUrls.forEach((url, file) => {
    if (!selectedImages.includes(file)) {
      URL.revokeObjectURL(url);
      imagePreviewUrls.delete(file);
    }
  });
  previewContainer.replaceChildren();
  previewContainer.classList.toggle("hidden", selectedImages.length === 0);

  selectedImages.forEach((file, index) => {
    const preview = document.createElement("div");
    preview.className = "image-preview";

    if (isImageFile(file)) {
      const image = document.createElement("img");
      if (!imagePreviewUrls.has(file)) {
        imagePreviewUrls.set(file, URL.createObjectURL(file));
      }
      image.src = imagePreviewUrls.get(file);
      image.alt = file.name || `Selected image ${index + 1}`;
      preview.append(image);
    } else {
      const docBadge = document.createElement("div");
      docBadge.style.cssText = "display:grid;place-items:center;aspect-ratio:4/3;background:var(--cream);border-radius:4px;font-weight:800;color:var(--primary);font-size:1.1rem;";
      const ext = (file.name.split(".").pop() || "DOC").toUpperCase();
      docBadge.textContent = `ðŸ“„ ${ext}`;
      preview.append(docBadge);
    }

    const name = document.createElement("span");
    name.className = "image-preview-name";
    name.textContent = file.name || `File ${index + 1}`;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-image-btn";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => {
      selectedImages = selectedImages.filter((_, fileIndex) => fileIndex !== index);
      setSelectedImages(selectedImages);
    });

    preview.append(name, removeButton);
    previewContainer.append(preview);
  });
}

function setSelectedImages(files) {
  selectedImages = Array.from(files);
  const fileStatus = getElement("file-name");

  if (selectedImages.length === 1) {
    fileStatus.textContent = selectedImages[0].name || "1 file selected";
  } else if (selectedImages.length > 1) {
    fileStatus.textContent = `${selectedImages.length} files selected`;
  } else {
    fileStatus.textContent = "No files selected";
  }

  renderImagePreviews();
}

if (imageInput) {
  imageInput.addEventListener("change", () => {
    setSelectedImages(imageInput.files);
    imageInput.value = "";
  });
}

if (getElement("notes")) {
  getElement("notes").addEventListener("paste", (event) => {
    const pastedFiles = Array.from(event.clipboardData?.items || [])
      .filter(item => item.kind === "file")
      .map(item => item.getAsFile())
      .filter(Boolean);

    if (pastedFiles.length === 0) return;

    event.preventDefault();
    setSelectedImages([...selectedImages, ...pastedFiles]);
  });
}

if (uploadDropZone) {
  uploadDropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      imageInput.click();
    }
  });

  uploadDropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    uploadDropZone.classList.add("drag-over");
  });

  uploadDropZone.addEventListener("dragleave", (event) => {
    if (!uploadDropZone.contains(event.relatedTarget)) {
      uploadDropZone.classList.remove("drag-over");
    }
  });

  uploadDropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    uploadDropZone.classList.remove("drag-over");
    setSelectedImages([...selectedImages, ...Array.from(event.dataTransfer.files)]);
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = (error) => reject(error);
  });
}

async function extractTextFromDocument(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();

  if (ext === "txt" || file.type === "text/plain") {
    return await file.text();
  }

  if (ext === "pdf" || file.type === "application/pdf") {
    if (!window.pdfjsLib) throw new Error("PDF library not loaded.");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let extracted = "";

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(" ");
      extracted += `\n--- Page ${pageNum} ---\n${pageText}`;
    }
    return extracted.trim();
  }

  if (ext === "pptx" || file.name.endsWith(".pptx")) {
    if (!window.JSZip) throw new Error("JSZip library not loaded for PPTX.");
    const arrayBuffer = await file.arrayBuffer();
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const slideFiles = Object.keys(zip.files)
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((a, b) => {
        const numA = parseInt(a.match(/slide(\d+)\.xml/i)[1], 10);
        const numB = parseInt(b.match(/slide(\d+)\.xml/i)[1], 10);
        return numA - numB;
      });

    let extracted = "";
    const parser = new DOMParser();

    for (const slidePath of slideFiles) {
      const xmlText = await zip.files[slidePath].async("string");
      const xmlDoc = parser.parseFromString(xmlText, "application/xml");
      const textNodes = Array.from(xmlDoc.getElementsByTagName("a:t"));
      const slideText = textNodes.map(node => node.textContent).join(" ");
      if (slideText.trim()) {
        extracted += `\n--- Slide ---\n${slideText.trim()}`;
      }
    }
    return extracted.trim();
  }

  return "";
}

function typeWriter(element, text, speed = 15) {
  element.textContent = "";
  let index = 0;
  if (typingTimeout) clearTimeout(typingTimeout);

  function type() {
    if (index < text.length) {
      element.textContent += text.charAt(index);
      index++;
      typingTimeout = setTimeout(type, speed);
    }
  }
  type();
}

function cleanQuestionDisplay(text) {
  if (!text) return "";
  return text
    .replace(/(\b\d+[.)]\s*)+$/g, '')
    .replace(/\(\s*(prompt|hint|note|instruction)\s*:.*?\)/gi, '')
    .replace(/^(\s*(true\s*(or|\/)?\s*false|tama\s*(o|\/)?\s*mali|t\s*\/\s*f)\s*[:.-]?\s*)+/gi, '')
    .replace(/[\s(--]*\b(true\s*(or|\/)?\s*false|tama\s*(o|\/)?\s*mali|t\s*\/\s*f)\b[\s)]*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeString(str) {
  if (!str) return "";
  return str.toString()
    .toLowerCase()
    .replace(/^(answer|correct answer|term|definition|key|a)\s*[:.-]\s*/gi, "")
    .replace(/^\s*\d+[\s.)-]+\s*/, "")
    .replace(/[.,;:!?()"'`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function checkIdentificationMatch(userTyped, expectedAnswer) {
  const u = normalizeString(userTyped);
  const e = normalizeString(expectedAnswer);

  if (!u || !e) return false;
  if (u === e) return true;
  if (e.includes(u) && u.length >= 2) return true;
  if (u.includes(e) && e.length >= 2) return true;

  return false;
}

function getEnumerationItems(value) {
  return value.split(/\r?\n|[,;]+/)
    .map(item => item.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean)
    .map(normalizeString);
}

// Visual Answer Feedback with Delay
function attachChoiceFeedback(choiceButtons) {
  choiceButtons.forEach(option => {
    option.addEventListener("click", event => {
      event.stopPropagation();
      if (choiceButtons.some(choice => choice.disabled)) return;

      choiceButtons.forEach(choice => { choice.disabled = true; });
      const isCorrect = option.dataset.correct === "true";

      if (!answeredState[i]) {
        answeredState[i] = { isCorrect };
        updateSpacedRepetition(cards[i], isCorrect);
        saveLocalProgress();
        updateScoreUI();
      }

      const cardElem = getElement("card");

      if (isCorrect) {
        option.classList.add("correct");
        cardElem.style.border = "2px solid #2f7544";
        triggerConfetti();

        choiceFlipTimeout = setTimeout(() => {
          stopSpeech(true);
          cardElem.classList.add("flipped");
          cardElem.style.border = "";
          choiceFlipTimeout = null;
        }, 1200);
        return;
      }

      option.classList.add("incorrect");
      cardElem.style.border = "2px solid #a33434";
      triggerWrongXEffect(cardElem);

      const correctChoice = choiceButtons.find(choice => choice.dataset.correct === "true");
      if (correctChoice) correctChoice.classList.add("correct");
      getElement("back").classList.add("revealed-correct");
      
      choiceFlipTimeout = setTimeout(() => {
        stopSpeech(true);
        cardElem.classList.add("flipped");
        cardElem.style.border = "";
        choiceFlipTimeout = null;
      }, 1500);
    });
  });
}

// --- FLASHCARD GENERATOR WITH PROGRESS BAR ---
if (getElement("generate")) {
  getElement("generate").addEventListener("click", async () => {
    const notes = getElement("notes").value;
    const count = getElement("count").value;
    const difficulty = getElement("difficulty").value;

    const loadingContainer = getElement("generation-loading-container");
    const progressBar = getElement("generation-progress-bar");
    const loadingText = getElement("loading-text");
    const statusElem = getElement("status");

    if (!notes.trim() && selectedImages.length === 0) {
      statusElem.textContent = "Please provide study notes or attach at least one file.";
      return;
    }

    statusElem.textContent = "";
    loadingContainer.classList.remove("hidden");
    progressBar.style.width = "10%";
    loadingText.textContent = `Analyzing ${selectedSubjectMode.toUpperCase()} material & generating cards...`;
    getElement("generate").disabled = true;

    let progress = 10;
    const progressInterval = setInterval(() => {
      if (progress < 88) {
        progress += Math.floor(Math.random() * 6) + 2;
        progressBar.style.width = progress + "%";
      }
    }, 280);

    try {
      const imageFiles = selectedImages.filter(isImageFile);
      const docFiles = selectedImages.filter(f => !isImageFile(f));

      let extractedDocsText = "";
      for (const docFile of docFiles) {
        loadingText.textContent = `Reading ${docFile.name}...`;
        const docText = await extractTextFromDocument(docFile);
        if (docText) {
          extractedDocsText += `\n\n[Content from ${docFile.name}]:\n${docText}`;
        }
      }

      const combinedNotes = (notes + "\n" + extractedDocsText).trim();

      const images = await Promise.all(imageFiles.map(async file => ({
        data: await fileToBase64(file),
        mimeType: file.type || "image/jpeg",
        name: file.name
      })));

      const headers = { "Content-Type": "application/json" };
      const token = await window.sapcFirebase?.getIdToken();
      if (!token) throw new Error("Please sign in before generating flashcards.");
      headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(apiUrl("/api/flashcards"), {
        method: "POST",
        headers,
        body: JSON.stringify({ 
          notes: combinedNotes, 
          count: Number(count),
          images,
          gradeLevel: selectedGrade,
          academicStrand: selectedStrand,
          difficulty,
          subjectMode: selectedSubjectMode
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate cards.");

      clearInterval(progressInterval);
      progressBar.style.width = "100%";
      loadingText.textContent = "Flashcards generated successfully!";

      cards = data.cards;
      i = 0;
      resetQuizScore();
      saveCardsToStorage();
      getElement("study").classList.remove("hidden");

      setTimeout(() => {
        loadingContainer.classList.add("hidden");
        progressBar.style.width = "0%";
        statusElem.textContent = cards.length < Number(count)
          ? `Done! ${cards.length} unique cards ready.`
          : `Done! ${cards.length} cards ready.`;
      }, 700);

      show(true);
    } catch (err) {
      clearInterval(progressInterval);
      loadingContainer.classList.add("hidden");
      progressBar.style.width = "0%";
      statusElem.textContent = "Error: " + err.message;
    } finally {
      getElement("generate").disabled = false;
    }
  });
}

function show(stopAuto = true) {
  stopSpeech(stopAuto);
  if (typingTimeout) {
    clearTimeout(typingTimeout);
    typingTimeout = null;
  }
  if (choiceFlipTimeout) {
    clearTimeout(choiceFlipTimeout);
    choiceFlipTimeout = null;
  }

  getElement("quiz-summary").classList.add("hidden");
  getElement("card").classList.remove("hidden");
  getElement("hint-text").classList.remove("hidden");
  getElement("study-controls").classList.remove("hidden");

  getElement("card").classList.remove("flipped");
  getElement("card").style.border = "";
  getElement("back").classList.remove("revealed-correct");
  const answerEntry = getElement("typed-answer-entry");
  answerEntry.replaceChildren();
  answerEntry.classList.add("hidden");

  const front = getElement("front");
  const cleanedQuestion = cleanQuestionDisplay(cards[i].question);
  const questionLines = cleanedQuestion.split(/\r?\n/);
  const optionPattern = /^\s*[A-D][.)]\s+/;
  const firstOptionIndex = questionLines.findIndex(line => optionPattern.test(line));

  const isTrueFalse = cards[i].type === "true-false" || /^(true|false|tama|mali)$/i.test(cards[i].answer.trim());
  const isMultipleChoice = cards[i].type === "multiple-choice" || firstOptionIndex !== -1;
  const isLongQuestion = cleanedQuestion.length > 260 || questionLines.length > 7;
  const isEnumeration = cards[i].type === "enumeration";

  front.replaceChildren();
  front.classList.toggle("multiple-choice", isMultipleChoice);
  front.classList.toggle("true-false", isTrueFalse);
  front.classList.toggle("long-content", isLongQuestion);

  front.append(createAudioControlsGroup(() => cleanedQuestion));

  if (isTrueFalse) {
    const question = document.createElement("div");
    question.className = "question-text";
    front.append(question);
    typeWriter(question, cleanedQuestion);

    const options = document.createElement("div");
    options.className = "choice-options true-false-options";

    const rawAnswerMatch = cards[i].answer.trim().match(/^(true|false|tama|mali)/i);
    const correctAnswer = rawAnswerMatch ? rawAnswerMatch[1].toLowerCase() : normalizeString(cards[i].answer);
    const isFilipinoAnswer = rawAnswerMatch && /^(tama|mali)$/i.test(rawAnswerMatch[1]);
    const labels = isFilipinoAnswer ? ["Tama", "Mali"] : ["True", "False"];

    const choiceButtons = labels.map(choiceText => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "choice-option";
      option.textContent = choiceText;
      
      const choiceNormalized = choiceText.toLowerCase();
      const isMatch = (choiceNormalized === 'true' && correctAnswer === 'true') ||
                      (choiceNormalized === 'false' && correctAnswer === 'false') ||
                      (choiceNormalized === 'tama' && correctAnswer === 'tama') ||
                      (choiceNormalized === 'mali' && correctAnswer === 'mali');

      option.dataset.correct = String(isMatch);
      options.append(option);
      return option;
    });
    attachChoiceFeedback(choiceButtons);
    front.append(options);

  } else if (!isMultipleChoice) {
    const question = document.createElement("div");
    question.className = "question-text";
    front.append(question);
    typeWriter(question, cleanedQuestion);

    const expectedAnswer = isEnumeration
      ? getEnumerationItems(cards[i].answer).sort()
      : [cards[i].answer];

    const form = document.createElement("form");
    form.className = "typed-answer-form";

    const label = document.createElement("label");
    label.htmlFor = "typed-answer-1";
    label.textContent = isEnumeration
      ? `Enter all ${expectedAnswer.length} items, one per box, in any order`
      : "Your answer";

    const answerFields = [];
    let answerControl = isEnumeration ? document.createElement("div") : document.createElement("input");
    if (isEnumeration) answerControl.className = "enumeration-answer-fields";
    
    expectedAnswer.forEach((_, index) => {
      const field = document.createElement("input");
      field.type = "text";
      field.id = `typed-answer-${index + 1}`;
      field.name = `typed-answer-${index + 1}`;
      field.autocomplete = "off";
      field.placeholder = isEnumeration ? "Enter one item" : "Type your answer";
      field.setAttribute("aria-label", isEnumeration ? `Enumeration item ${index + 1}` : "Your answer");
      answerFields.push(field);
      if (isEnumeration) answerControl.append(field);
      else answerControl = field;
    });

    const checkButton = document.createElement("button");
    checkButton.type = "submit";
    checkButton.className = "primary-btn";
    checkButton.textContent = "Check answer";

    const feedback = document.createElement("p");
    feedback.className = "typed-answer-feedback";
    feedback.setAttribute("aria-live", "polite");

    form.addEventListener("submit", event => {
      event.preventDefault();

      let isCorrect = false;
      if (isEnumeration) {
        const submittedAnswer = answerFields
          .map(field => normalizeString(field.value))
          .filter(Boolean)
          .sort();
        isCorrect = submittedAnswer.length === expectedAnswer.length &&
          JSON.stringify(submittedAnswer) === JSON.stringify(expectedAnswer);
      } else {
        const userTyped = answerFields[0]?.value || "";
        isCorrect = checkIdentificationMatch(userTyped, cards[i].answer);
      }

      if (!answeredState[i]) {
        answeredState[i] = { isCorrect };
        updateSpacedRepetition(cards[i], isCorrect);
        saveLocalProgress();
        updateScoreUI();
      }

      const cardElem = getElement("card");

      if (isCorrect) {
        form.classList.add("is-correct");
        form.classList.remove("is-incorrect");
        cardElem.style.border = "2px solid #2f7544";
        feedback.textContent = "Correct!";
        triggerConfetti();
        answerFields.forEach(field => { field.disabled = true; });
        checkButton.disabled = true;
      } else {
        form.classList.add("is-incorrect");
        form.classList.remove("is-correct");
        cardElem.style.border = "2px solid #a33434";
        feedback.textContent = "Not quite. Try again.";
        triggerWrongXEffect(cardElem);
      }
    });

    form.append(label, answerControl, checkButton, feedback);
    answerEntry.append(form);
    answerEntry.classList.remove("hidden");
  } else {
    const question = document.createElement("div");
    question.className = "question-text";
    front.append(question);

    let mainQuestionText = cleanedQuestion;
    let rawOptions = questionLines.slice(firstOptionIndex);

    if (firstOptionIndex === -1) {
      const matchInline = cleanedQuestion.match(/(.*?)\s+([A-D][.)]\s+.+)/);
      if (matchInline) {
        mainQuestionText = matchInline[1].trim();
        rawOptions = cleanedQuestion.slice(mainQuestionText.length).split(/(?=[A-D][.)]\s+)/).map(s => s.trim()).filter(Boolean);
      }
    } else {
      mainQuestionText = questionLines.slice(0, firstOptionIndex).join("\n").trim();
    }

    typeWriter(question, mainQuestionText);

    const options = document.createElement("div");
    options.className = "choice-options";
    const answer = cards[i].answer.trim();
    const answerLetter = answer.match(/^([A-D])(?:[.)]\s*|$)/i)?.[1]?.toUpperCase();
    const answerText = answer.replace(/^[A-D][.)]\s*/i, "").trim().toLowerCase();
    const choiceButtons = [];

    rawOptions.filter(line => optionPattern.test(line)).forEach(line => {
      const choiceMatch = line.trim().match(/^([A-D])[.)]\s*(.+)$/i);
      const option = document.createElement("button");
      option.type = "button";
      option.className = "choice-option";
      option.textContent = line.trim();
      const isCorrect = answerLetter
        ? choiceMatch?.[1].toUpperCase() === answerLetter
        : choiceMatch?.[2].trim().toLowerCase() === answerText;
      option.dataset.correct = String(Boolean(isCorrect));
      if (choiceMatch) option.dataset.choice = choiceMatch[1].toUpperCase();
      choiceButtons.push(option);
      options.append(option);
    });
    attachChoiceFeedback(choiceButtons);
    front.append(options);
  }

  const back = getElement("back");
  back.replaceChildren();

  back.append(createAudioControlsGroup(() => {
    let fullAnswer = cards[i].answer;
    if (cards[i].explanation) {
      fullAnswer += ". Explanation: " + cards[i].explanation;
    }
    return fullAnswer;
  }));

  const answerLength = cards[i].answer.length + (cards[i].explanation?.length || 0);
  const answerLineCount = cards[i].answer.split(/\r?\n/).length;
  back.classList.toggle("long-content", answerLength > 260 || answerLineCount > 7);
  
  const answerText = document.createElement("div");
  answerText.className = "answer-result";
  answerText.textContent = cards[i].answer;
  back.append(answerText);

  if (cards[i].explanation) {
    const explanation = document.createElement("p");
    explanation.className = "answer-explanation";
    explanation.textContent = cards[i].explanation;
    back.append(explanation);
  }

  getElement("counter").textContent = `Card ${i + 1} of ${cards.length}`;
  getElement("bar").style.width = ((i + 1) / cards.length) * 100 + "%";
  updateScoreUI();
}

if (getElement("card")) {
  getElement("card").addEventListener("click", () => {
    stopSpeech(true);
    getElement("card").classList.toggle("flipped");
  });
}

if (getElement("next")) {
  getElement("next").addEventListener("click", () => {
    if (i >= cards.length - 1) {
      showDeckSummary();
    } else {
      i++;
      show(true);
    }
  });
}

if (getElement("prev")) {
  getElement("prev").addEventListener("click", () => { 
    i = (i - 1 + cards.length) % cards.length; 
    show(true); 
  });
}

if (getElement("shuffle")) {
  getElement("shuffle").addEventListener("click", () => {
    cards.sort(() => Math.random() - 0.5);
    i = 0;
    resetQuizScore();
    saveCardsToStorage();
    show(true);
  });
}

// --- Cross-Platform Export and Import JSON Flashcards ---
const mainExportBtn = getElement("main-export-btn");
const importFileInput = getElement("import-file-input");

async function handleExportCards() {
  if (cards.length === 0) {
    alert("No flashcards available to export.");
    return;
  }

  const fileName = `SAPC_Flashcards_${selectedSubjectMode}_${Date.now()}.json`;
  const jsonBlob = new Blob([JSON.stringify({ cards }, null, 2)], { type: "application/json" });
  const file = new File([jsonBlob], fileName, { type: "application/json" });

  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title: 'SAPC Flashcards Export',
        text: 'Here is your exported flashcard deck file.',
        files: [file]
      });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  const blobUrl = URL.createObjectURL(jsonBlob);
  const downloadAnchor = document.createElement("a");
  downloadAnchor.setAttribute("href", blobUrl);
  downloadAnchor.setAttribute("download", fileName);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  URL.revokeObjectURL(blobUrl);
}

if (mainExportBtn) {
  mainExportBtn.addEventListener("click", handleExportCards);
}

if (importFileInput) {
  importFileInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const importedData = JSON.parse(e.target.result);
        const newCards = Array.isArray(importedData) ? importedData : importedData.cards;

        const isValidDeck = Array.isArray(newCards) && newCards.length > 0 && newCards.every(card =>
          card && typeof card === "object" &&
          typeof card.question === "string" && card.question.trim() &&
          typeof card.answer === "string" && card.answer.trim()
        );

        if (isValidDeck) {
          cards = newCards;
          i = 0;
          resetQuizScore();
          saveCardsToStorage();
          const studyElement = getElement("study");
          if (studyElement) studyElement.classList.remove("hidden");
          const statusElement = getElement("status");
          if (statusElement) statusElement.textContent = `Successfully imported ${cards.length} cards from JSON!`;
          show(true);
        } else {
          alert("Invalid flashcard JSON format.");
        }
      } catch (err) {
        alert("Failed to parse JSON file: " + err.message);
      }
    };

    reader.readAsText(file);
    importFileInput.value = "";
  });
}

// --- Modal Management ---
const cardModal = getElement("card-modal");
const modalTitle = getElement("modal-title");
const modalQuestion = getElement("modal-question");
const modalAnswer = getElement("modal-answer");
const modalCardType = getElement("modal-card-type");

function inferCardType(card) {
  if (["identification", "multiple-choice", "enumeration", "true-false"].includes(card.type)) {
    return card.type;
  }
  return "identification";
}

function updateModalCardTypeFields() {
  document.querySelectorAll(".custom-card-fields").forEach(fields => {
    fields.classList.toggle("hidden", fields.dataset.cardType !== modalCardType.value);
  });
}

if (modalCardType) {
  modalCardType.addEventListener("change", updateModalCardTypeFields);
}

function openModal(isEdit = false) {
  if (!cardModal) return;
  cardModal.classList.remove("hidden");
  
  if (isEdit && cards.length > 0) {
    const card = cards[i];
    const cardType = inferCardType(card);
    const questionLines = card.question.split(/\r?\n/);
    const firstOptionIndex = questionLines.findIndex(line => /^\s*[A-D][.)]\s+/.test(line));

    modalTitle.textContent = "Edit Flashcard";
    modalCardType.value = cardType;
    
    modalQuestion.value = cardType === "true-false"
      ? cleanQuestionDisplay(card.question)
      : cardType === "multiple-choice" && firstOptionIndex !== -1
        ? questionLines.slice(0, firstOptionIndex).join("\n").trim()
        : cleanQuestionDisplay(card.question);

    modalAnswer.value = cardType === "identification" ? card.answer : "";
    if (getElement("modal-id-explanation")) {
      getElement("modal-id-explanation").value = cardType === "identification" ? (card.explanation || "") : "";
    }
    getElement("modal-enumeration-answer").value = cardType === "enumeration"
      ? card.answer.split(/\r?\n/).map(line => line.replace(/^\s*\d+[.)]\s*/, "")).join("\n")
      : "";
    getElement("modal-explanation").value = cardType === "true-false" ? (card.explanation || "") : "";
    getElement("modal-mc-explanation").value = cardType === "multiple-choice" ? (card.explanation || "") : "";
    
    const correctOption = card.answer.match(/^\s*([A-D])[.)]\s*/i)?.[1]?.toUpperCase() || "A";
    getElement("modal-correct-option").value = correctOption;

    ["a", "b", "c", "d"].forEach((letter) => {
      const optionLine = cardType === "multiple-choice"
        ? questionLines.slice(firstOptionIndex).find(line => new RegExp(`^\\s*${letter}[.)]\\s+`, "i").test(line))
        : null;
      getElement(`modal-option-${letter}`).value = optionLine ? optionLine.replace(/^\s*[A-D][.)]\s+/i, "") : "";
    });

    getElement("modal-true-false-answer").value = /^(false|mali)$/i.test(card.answer.trim()) ? "False" : "True";
    updateModalCardTypeFields();
    editingIndex = i;
  } else {
    modalTitle.textContent = "Create Custom Flashcard";
    modalCardType.value = "identification";
    modalQuestion.value = "";
    modalAnswer.value = "";
    if (getElement("modal-id-explanation")) getElement("modal-id-explanation").value = "";
    getElement("modal-enumeration-answer").value = "";
    getElement("modal-explanation").value = "";
    getElement("modal-mc-explanation").value = "";
    ["a", "b", "c", "d"].forEach(letter => { getElement(`modal-option-${letter}`).value = ""; });
    getElement("modal-correct-option").value = "A";
    getElement("modal-true-false-answer").value = "True";
    updateModalCardTypeFields();
    editingIndex = null;
  }
}

function closeModal() {
  if (cardModal) cardModal.classList.add("hidden");
}

if (getElement("manual-add-btn")) getElement("manual-add-btn").addEventListener("click", () => openModal(false));
if (getElement("edit-card-btn")) getElement("edit-card-btn").addEventListener("click", () => {
  const cardActionsMenu = getElement("card-actions");
  if (cardActionsMenu) cardActionsMenu.open = false;
  openModal(true);
});
if (getElement("close-modal-btn")) getElement("close-modal-btn").addEventListener("click", closeModal);
if (getElement("cancel-modal-btn")) getElement("cancel-modal-btn").addEventListener("click", closeModal);

if (getElement("save-card-btn")) {
  getElement("save-card-btn").addEventListener("click", () => {
    const question = modalQuestion.value.trim();
    const cardType = modalCardType.value;
    if (!question) return alert("Please enter a question.");

    let card;
    if (cardType === "multiple-choice") {
      const letters = ["A", "B", "C", "D"];
      const choices = letters.map(letter => getElement(`modal-option-${letter.toLowerCase()}`).value.trim());
      if (choices.some(choice => !choice)) return alert("Please fill in all four choices.");
      const correctOption = getElement("modal-correct-option").value;
      const mcExplanation = getElement("modal-mc-explanation").value.trim();
      card = {
        question: `${question}\n${choices.map((choice, index) => `${letters[index]}. ${choice}`).join("\n")}`,
        answer: `${correctOption}. ${choices[letters.indexOf(correctOption)]}`,
        explanation: mcExplanation,
        type: cardType
      };
    } else if (cardType === "enumeration") {
      const items = getElement("modal-enumeration-answer").value.split(/\r?\n/)
        .map(item => item.replace(/^\s*\d+[.)]\s*/, "").trim())
        .filter(Boolean);
      if (items.length < 2) return alert("Please enter at least two expected items, one per line.");
      card = { question, answer: items.map((item, index) => `${index + 1}. ${item}`).join("\n"), type: cardType };
    } else if (cardType === "true-false") {
      card = {
        question: question,
        answer: getElement("modal-true-false-answer").value,
        explanation: getElement("modal-explanation").value.trim(),
        type: cardType
      };
    } else {
      const answer = modalAnswer.value.trim();
      const idExplanation = getElement("modal-id-explanation")?.value.trim() || "";
      if (!answer) return alert("Please enter the answer.");
      card = { question, answer, explanation: idExplanation, type: "identification" };
    }

    if (editingIndex !== null) {
      cards[editingIndex] = card;
    } else {
      cards.push(card);
      i = cards.length - 1;
      getElement("study").classList.remove("hidden");
    }
    saveCardsToStorage();
    show(true);
    closeModal();
  });
}

if (getElement("delete-card-btn")) {
  getElement("delete-card-btn").addEventListener("click", () => {
    const cardActionsMenu = getElement("card-actions");
    if (cardActionsMenu) cardActionsMenu.open = false;

    if (cards.length === 0) return;
    if (confirm("Are you sure you want to delete this flashcard?")) {
      cards.splice(i, 1);
      saveCardsToStorage();
      if (cards.length === 0) {
        getElement("study").classList.add("hidden");
      } else {
        i = Math.max(0, i - 1);
        show(true);
      }
    }
  });
}

const clearAllCardsBtn = getElement("clear-all-cards-btn");

if (clearAllCardsBtn) {
  clearAllCardsBtn.addEventListener("click", () => {
    const cardActionsMenu = getElement("card-actions");
    if (cardActionsMenu) cardActionsMenu.open = false;

    if (cards.length === 0) {
      alert("No flashcards available to clear.");
      return;
    }

    if (confirm("Are you sure you want to delete ALL flashcards?")) {
      cards = [];
      i = 0;
      resetQuizScore();
      localStorage.removeItem("sapc_flashcards");
      
      const studyElement = getElement("study");
      if (studyElement) studyElement.classList.add("hidden");
      
      const statusElement = getElement("status");
      if (statusElement) statusElement.textContent = "All flashcards have been cleared.";
    }
  });
}

function renderProgressDashboard() {
  const progress = JSON.parse(localStorage.getItem("sapc_progress") || '{"sessions":[],"reviews":{}}');
  const sessions = Array.isArray(progress.sessions) ? progress.sessions : [];
  const total = sessions.reduce((sum, session) => sum + Number(session.total || 0), 0);
  const correct = sessions.reduce((sum, session) => sum + Number(session.correct || 0), 0);
  const due = cards.filter(card => card.srs && Number(card.srs.dueAt) <= Date.now()).length;
  const dates = new Set(sessions.map(session => String(session.date).slice(0, 10)));
  let streak = 0;
  const day = new Date();
  while (dates.has(day.toISOString().slice(0, 10))) {
    streak += 1;
    day.setDate(day.getDate() - 1);
  }
  const stats = {
    "stat-streak": streak,
    "stat-accuracy": `${total ? Math.round((correct / total) * 100) : 0}%`,
    "stat-sessions": sessions.length,
    "stat-due": due
  };
  Object.entries(stats).forEach(([id, value]) => {
    const element = getElement(id);
    if (element) element.textContent = value;
  });
}

const weakCardsBtn = getElement("weak-cards-btn");
if (weakCardsBtn) weakCardsBtn.addEventListener("click", () => {
  const weakCards = cards.filter(card => card.srs?.repetitions === 0 || card.srs?.ease < 2.2);
  if (!weakCards.length) {
    alert("No weak cards found yet. Answer some cards incorrectly to build a focused review.");
    return;
  }
  cards = weakCards;
  i = 0;
  resetQuizScore();
  getElement("study").classList.remove("hidden");
  show(true);
});

const saveDeckBtn = getElement("save-deck-btn");
if (saveDeckBtn) saveDeckBtn.addEventListener("click", async () => {
  const user = window.sapcFirebase?.getCurrentUser();
  if (!user || !cards.length) {
    alert("Sign in and generate or import cards before saving a deck.");
    return;
  }
  try {
    const tagText = prompt("Optional tags, separated by commas:", "");
    const saved = await window.sapcFirebase.saveDeck(user, {
      id: activeDeckId,
      title: `${selectedSubjectMode.toUpperCase()} Reviewer`,
      subjectMode: selectedSubjectMode,
      gradeLevel: selectedGrade,
      academicStrand: selectedStrand,
      cards,
      tags: tagText ? tagText.split(",").map(tag => tag.trim()).filter(Boolean) : []
    });
    activeDeckId = saved.id;
    getElement("status").textContent = "Deck saved to your Firebase account.";
  } catch (error) {
    console.error("Could not save deck:", error);
    getElement("status").textContent = "Could not save deck: " + error.message;
  }
});

let savedDecks = [];
async function loadSavedDecks() {
  const user = window.sapcFirebase?.getCurrentUser();
  if (!user || !window.sapcFirebase?.listDecks) return;
  try {
    savedDecks = await window.sapcFirebase.listDecks(user);
    renderSavedDecks();
  } catch (error) {
    console.error("Could not load saved decks:", error);
  }
}
function renderSavedDecks() {
  const list = getElement("saved-decks-list");
  if (!list) return;
  const query = (getElement("deck-search")?.value || "").trim().toLowerCase();
  list.replaceChildren();
  savedDecks.filter(deck => {
    const text = `${deck.title || ""} ${(deck.tags || []).join(" ")}`.toLowerCase();
    return !query || text.includes(query);
  }).forEach(deck => {
    const button = document.createElement("button");
    button.className = "saved-deck-item";
    button.type = "button";
    const icon = document.createElement("span");
    icon.className = "deck-item-icon";
    icon.textContent = "âœ¦";
    const content = document.createElement("span");
    content.className = "deck-item-content";
    const title = document.createElement("strong");
    title.textContent = deck.title || "Untitled deck";
    const meta = document.createElement("small");
    meta.textContent = `${deck.cards?.length || 0} cards Â· ${(deck.tags || []).join(", ") || "No tags"}`;
    content.append(title, meta);
    const arrow = document.createElement("span");
    arrow.className = "deck-item-arrow";
    arrow.textContent = "â€º";
    button.append(icon, content, arrow);
    button.addEventListener("click", () => {
      cards = Array.isArray(deck.cards) ? deck.cards : [];
      activeDeckId = deck.id;
      i = 0;
      resetQuizScore();
      getElement("study").classList.remove("hidden");
      show(true);
    });
    list.append(button);
  });
}
getElement("deck-search")?.addEventListener("input", renderSavedDecks);

const shareDeckBtn = getElement("share-deck-btn");
if (shareDeckBtn) shareDeckBtn.addEventListener("click", async () => {
  const user = window.sapcFirebase?.getCurrentUser();
  if (!user || !cards.length) {
    alert("Sign in and prepare a deck before sharing.");
    return;
  }
  try {
    const shareId = await window.sapcFirebase.createShare(user, {
      title: `${selectedSubjectMode.toUpperCase()} Reviewer`,
      subjectMode: selectedSubjectMode,
      cards
    });
    const link = `${window.location.origin}${window.location.pathname}?share=${shareId}`;
    await navigator.clipboard.writeText(link);
    getElement("status").textContent = "Read-only deck link copied to clipboard.";
  } catch (error) {
    alert("Could not create share link: " + error.message);
  }
});

function friendName(friend, userId) {
  return friend.fromId === userId ? friend.toName : friend.fromName;
}
function renderFriendItems(items, containerId, renderItem) {
  const container = getElement(containerId);
  if (!container) return;
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("small");
    empty.textContent = "None yet.";
    container.append(empty);
    return;
  }
  items.forEach(item => container.append(renderItem(item)));
}
async function loadFriends() {
  const user = window.sapcFirebase?.getCurrentUser();
  if (!user || !window.sapcFirebase?.listFriends) return;
  try {
    const [requests, friends] = await Promise.all([
      window.sapcFirebase.listFriendRequests(user),
      window.sapcFirebase.listFriends(user)
    ]);
    renderFriendItems(requests, "friend-requests-list", request => {
      const wrapper = document.createElement("div");
      wrapper.className = "saved-deck-item";
      const identity = document.createElement("span");
      identity.className = "friend-item-content";
      const name = document.createElement("strong");
      name.textContent = request.fromName || "Paduan";
      const note = document.createElement("small");
      note.textContent = "sent you a friend request";
      identity.append(name, note);
      const actions = document.createElement("div");
      actions.className = "friend-action-row";
      ["accepted", "rejected"].forEach(status => {
        const button = document.createElement("button");
        button.className = status === "accepted" ? "primary-btn" : "ghost";
        button.type = "button";
        button.textContent = status === "accepted" ? "Accept" : "Decline";
        button.addEventListener("click", async () => {
          await window.sapcFirebase.respondToFriendRequest(request.id, status);
          loadFriends();
        });
        actions.append(button);
      });
      wrapper.append(actions);
      return wrapper;
    });
    renderFriendItems(friends, "friends-list", friend => {
      const wrapper = document.createElement("div");
      wrapper.className = "saved-deck-item";
      const avatar = document.createElement("span");
      avatar.className = "friend-avatar";
      avatar.textContent = friendName(friend, user.uid).charAt(0).toUpperCase();
      const name = document.createElement("strong");
      name.textContent = friendName(friend, user.uid);
      wrapper.append(avatar, name);
      return wrapper;
    });
  } catch (error) {
    console.error("Could not load friends:", error);
  }
}
async function searchFriends() {
  const user = window.sapcFirebase?.getCurrentUser();
  const query = getElement("friend-search")?.value || "";
  if (!user || query.trim().length < 2) return;
  try {
    const results = await window.sapcFirebase.searchUsers(query, user);
    renderFriendItems(results, "friend-search-results", profile => {
      const wrapper = document.createElement("div");
      wrapper.className = "saved-deck-item";
      const avatar = document.createElement("span");
      avatar.className = "friend-avatar";
      avatar.textContent = (profile.displayName || "P").charAt(0).toUpperCase();
      const identity = document.createElement("span");
      identity.className = "friend-item-content";
      const name = document.createElement("strong");
      name.textContent = profile.displayName || "Paduan";
      const note = document.createElement("small");
      note.textContent = profile.gradeLevel || "Student";
      identity.append(name, note);
      const button = document.createElement("button");
      button.className = "ghost";
      button.type = "button";
      button.textContent = "Add friend";
      button.addEventListener("click", async () => {
        try {
          await window.sapcFirebase.sendFriendRequest(user, profile);
          button.disabled = true;
          button.textContent = "Request sent";
        } catch (error) {
          alert("Could not send request: " + error.message);
        }
      });
      wrapper.append(avatar, identity, button);
      return wrapper;
    });
  } catch (error) {
    console.error("Could not search users:", error);
  }
}
getElement("friend-search-btn")?.addEventListener("click", searchFriends);
getElement("friend-search")?.addEventListener("keydown", event => {
  if (event.key === "Enter") searchFriends();
});

const aiHintBtn = getElement("ai-hint-btn");
if (aiHintBtn) aiHintBtn.addEventListener("click", async () => {
  const token = await window.sapcFirebase?.getIdToken();
  if (!token || !cards[i]) return;
  aiHintBtn.disabled = true;
  try {
    const response = await fetch(apiUrl("/api/ai-hint"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        question: cards[i].question,
        answer: cards[i].answer,
        subjectMode: selectedSubjectMode
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Hint request failed.");
    alert(data.hint);
  } catch (error) {
    alert(error.message);
  } finally {
    aiHintBtn.disabled = false;
  }
});

let quizTimer = null;
let quizSeconds = 0;
function startQuizTimer() {
  clearInterval(quizTimer);
  const value = Number(getElement("quiz-time-limit")?.value || 0);
  if (!value) return;
  quizSeconds = value;
  const status = getElement("status");
  quizTimer = setInterval(() => {
    quizSeconds -= 1;
    if (status) status.textContent = `Timed quiz: ${quizSeconds}s remaining`;
    if (quizSeconds <= 0) {
      clearInterval(quizTimer);
      showDeckSummary();
    }
  }, 1000);
}
const quizTimeLimit = getElement("quiz-time-limit");
if (quizTimeLimit) quizTimeLimit.addEventListener("change", startQuizTimer);

const profileModal = getElement("profile-modal");
const profilePhotoFile = getElement("profile-photo-file");
const profilePhotoPreview = getElement("profile-photo-preview");
if (profilePhotoFile) {
  profilePhotoFile.addEventListener("change", () => {
    const file = profilePhotoFile.files?.[0];
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      alert("Please choose a PNG, JPG, or WebP image.");
      profilePhotoFile.value = "";
      return;
    }
    const image = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      image.onload = () => {
        const canvas = document.createElement("canvas");
        const size = 256;
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        const scale = Math.max(size / image.width, size / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        getElement("profile-photo-url").value = dataUrl;
        profilePhotoPreview.src = dataUrl;
        profilePhotoPreview.classList.remove("hidden");
      };
      image.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}
function closeProfileModal() {
  profileModal?.classList.add("hidden");
}
function openProfileModal() {
  const user = window.sapcFirebase?.getCurrentUser();
  if (!user || !window.sapcFirebase?.getProfile) return;
  const googleLinked = user.providerData?.some(provider => provider.providerId === "google.com");
  const googleLinkButton = getElement("link-google-btn");
  const googleLinkStatus = getElement("google-link-status");
  if (googleLinkButton) {
    googleLinkButton.textContent = googleLinked ? "Google linked" : "Link Google";
    googleLinkButton.disabled = googleLinked;
  }
  if (googleLinkStatus) {
    googleLinkStatus.textContent = googleLinked
      ? "Your Google account is connected to this account."
      : "Link Google to this account for faster sign-in.";
  }
  window.sapcFirebase.getProfile(user).then(profile => {
    getElement("profile-display-name").value = profile.displayName || user.displayName || "";
    getElement("profile-username").value = profile.username || "";
    getElement("profile-photo-url").value = profile.photoURL || user.photoURL || "";
    if (profile.photoURL || user.photoURL) {
      profilePhotoPreview.src = profile.photoURL || user.photoURL;
      profilePhotoPreview.classList.remove("hidden");
    } else {
      profilePhotoPreview.classList.add("hidden");
    }
    getElement("profile-grade").value = profile.gradeLevel || "Grade 11";
    getElement("profile-strand").value = profile.strand || "";
    getElement("profile-bio").value = profile.bio || "";
    profileModal.classList.remove("hidden");
  }).catch(error => alert("Could not load profile: " + error.message));
}
getElement("profile-btn")?.addEventListener("click", openProfileModal);
getElement("close-profile-btn")?.addEventListener("click", closeProfileModal);
getElement("cancel-profile-btn")?.addEventListener("click", closeProfileModal);
getElement("link-google-btn")?.addEventListener("click", async event => {
  const user = window.sapcFirebase?.getCurrentUser();
  const button = event.currentTarget;
  if (!user || !window.sapcFirebase?.linkGoogle) return;
  button.disabled = true;
  button.textContent = "Connecting...";
  try {
    await window.sapcFirebase.linkGoogle(user);
    const status = getElement("google-link-status");
    if (status) status.textContent = "Your Google account is connected to this account.";
    button.textContent = "Google linked";
  } catch (error) {
    button.disabled = false;
    button.textContent = "Link Google";
    const message = error.code === "auth/credential-already-in-use"
      ? "That Google account is already connected to another account."
      : error.code === "auth/popup-blocked"
        ? "Allow pop-ups for this site, then try linking Google again."
        : error.message;
    alert(`Could not link Google: ${message}`);
  }
});
getElement("save-profile-btn")?.addEventListener("click", async () => {
  const user = window.sapcFirebase?.getCurrentUser();
  if (!user) return;
  try {
    const username = getElement("profile-username").value.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,24}$/.test(username)) {
      throw new Error("Username must be 3–24 characters using lowercase letters, numbers, dots, underscores, or hyphens.");
    }
    const currentProfile = await window.sapcFirebase.getProfile(user);
    if (username !== currentProfile.username && !(await window.sapcFirebase.isUsernameAvailable(username))) {
      throw new Error("That username is already taken.");
    }
    const profile = await window.sapcFirebase.saveProfile(user, {
      displayName: getElement("profile-display-name").value,
      username: getElement("profile-username").value,
      photoURL: getElement("profile-photo-url").value,
      gradeLevel: getElement("profile-grade").value,
      strand: getElement("profile-strand").value,
      bio: getElement("profile-bio").value
    });
    updateProfileUI(profile.displayName || "Paduan", profile.photoURL);
    closeProfileModal();
  } catch (error) {
    alert("Could not save profile: " + error.message);
  }
});

document.addEventListener("keydown", (e) => {
  if (cardModal && !cardModal.classList.contains("hidden")) return;
  if (e.target.closest("button, summary, input, textarea, select")) return;

  if (e.code === "Space") { 
    e.preventDefault(); 
    if (cards.length > 0) {
      stopSpeech(true);
      getElement("card").classList.toggle("flipped"); 
    }
  }
  if (e.key === "ArrowRight" && cards.length > 0) getElement("next").click();
  if (e.key === "ArrowLeft" && cards.length > 0) getElement("prev").click();
});

async function loadSharedDeck() {
  const shareId = new URLSearchParams(window.location.search).get("share");
  if (!shareId || !window.sapcFirebase?.getSharedDeck) return;
  try {
    const shared = await window.sapcFirebase.getSharedDeck(shareId);
    if (!shared || !Array.isArray(shared.cards) || !shared.cards.length) return;
    cards = shared.cards;
    selectedSubjectMode = shared.subjectMode || "general";
    i = 0;
    resetQuizScore();
    getElement("study").classList.remove("hidden");
    showAppWorkspace();
    show(true);
    getElement("status").textContent = `Viewing shared deck: ${shared.title}`;
  } catch (error) {
    console.error("Could not load shared deck:", error);
  }
}

loadCardsFromStorage();
renderProgressDashboard();
loadSharedDeck();
