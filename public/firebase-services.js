/* Firebase is loaded with the compat build so the existing single-page app can
 * use one small service boundary instead of spreading SDK calls throughout UI code. */
(function initialiseFirebaseServices() {
  const config = window.SAPC_FIREBASE_CONFIG;
  const isConfigured = config && !Object.values(config).some(value => String(value).startsWith("REPLACE_WITH"));

  if (!isConfigured || !window.firebase) {
    window.sapcFirebase = {
      configured: false,
      getCurrentUser: () => null,
      getIdToken: async () => null
    };
    return;
  }

  firebase.initializeApp(config);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const provider = new firebase.auth.GoogleAuthProvider();

  const profileRef = user => db.collection("users").doc(user.uid);
  const deckCollection = user => profileRef(user).collection("decks");
  const publicProfileRef = uid => db.collection("publicProfiles").doc(uid);

  async function ensureProfile(user) {
    const ref = profileRef(user);
    const snapshot = await ref.get();
    const existing = snapshot.exists ? snapshot.data() : {};
    const profile = {
      email: user.email || existing.email || "",
      displayName: existing.displayName || user.displayName || user.email?.split("@")[0] || "Paduan",
      username: existing.username || "",
      photoURL: existing.photoURL || user.photoURL || "",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (!snapshot.exists) profile.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    await ref.set(profile, { merge: true });
    await publicProfileRef(user.uid).set({
      displayName: profile.displayName,
      displayNameLower: String(profile.displayName || "").toLowerCase(),
      email: profile.email,
      username: profile.username,
      usernameLower: String(profile.username || "").toLowerCase(),
      photoURL: profile.photoURL,
      gradeLevel: existing.gradeLevel || "",
      strand: existing.strand || "",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { ...existing, ...profile };
  }

  async function saveDeck(user, deck) {
    const ref = deck.id ? deckCollection(user).doc(deck.id) : deckCollection(user).doc();
    const payload = {
      title: String(deck.title || "Saved Reviewer Deck").trim().slice(0, 120),
      subjectMode: deck.subjectMode || "general",
      gradeLevel: deck.gradeLevel || "Grade 11",
      academicStrand: deck.academicStrand || "General",
      tags: Array.isArray(deck.tags) ? deck.tags.slice(0, 20) : [],
      cards: Array.isArray(deck.cards) ? deck.cards : [],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (!deck.id) payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    await ref.set(payload, { merge: true });
    return { id: ref.id, ...payload };
  }

  async function recordStudySession(user, data) {
    const session = {
      deckId: data.deckId || "local-session",
      correct: Number(data.correct) || 0,
      total: Number(data.total) || 0,
      durationSeconds: Number(data.durationSeconds) || 0,
      completedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    await profileRef(user).collection("studySessions").add(session);
    await profileRef(user).set({
      lastStudiedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  window.sapcFirebase = {
    configured: true,
    auth,
    db,
    provider,
    getCurrentUser: () => auth.currentUser,
    getIdToken: () => auth.currentUser ? auth.currentUser.getIdToken() : null,
    ensureProfile,
    signIn: (email, password) => auth.signInWithEmailAndPassword(email, password),
    resolveLoginEmail: async identifier => {
      const value = String(identifier || "").trim().toLowerCase();
      if (value.includes("@")) return value;
      const snapshot = await db.collection("publicProfiles")
        .where("usernameLower", "==", value)
        .limit(1)
        .get();
      if (snapshot.empty) throw new Error("No account was found with that username.");
      return snapshot.docs[0].data().email;
    },
    isUsernameAvailable: async username => {
      const snapshot = await db.collection("publicProfiles")
        .where("usernameLower", "==", String(username || "").trim().toLowerCase())
        .limit(1)
        .get();
      return snapshot.empty;
    },
    register: (email, password) => auth.createUserWithEmailAndPassword(email, password),
    signInWithGoogle: () => auth.signInWithPopup(provider),
    linkGoogle: user => user.linkWithPopup(provider),
    sendPasswordReset: email => auth.sendPasswordResetEmail(email, {
      url: "https://ai-driven-academic-flashcards.web.app/reset-password.html",
      handleCodeInApp: false
    }),
    signOut: () => auth.signOut(),
    listDecks: async user => {
      const snapshot = await deckCollection(user).orderBy("updatedAt", "desc").limit(100).get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },
    saveDeck,
    deleteDeck: (user, deckId) => deckCollection(user).doc(deckId).delete(),
    recordStudySession,
    saveProfile: async (user, profile) => {
      const safeProfile = {
        displayName: String(profile.displayName || "").trim().slice(0, 80),
        username: String(profile.username || "").trim().toLowerCase().slice(0, 24),
        bio: String(profile.bio || "").trim().slice(0, 300),
        gradeLevel: String(profile.gradeLevel || "").slice(0, 30),
        strand: String(profile.strand || "").slice(0, 50),
        photoURL: String(profile.photoURL || "").slice(0, 400000),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      await profileRef(user).set(safeProfile, { merge: true });
      await publicProfileRef(user.uid).set({
        displayName: safeProfile.displayName,
        displayNameLower: String(safeProfile.displayName || "").toLowerCase(),
        username: safeProfile.username,
        usernameLower: safeProfile.username,
        email: user.email || "",
        photoURL: safeProfile.photoURL,
        gradeLevel: safeProfile.gradeLevel,
        strand: safeProfile.strand,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return safeProfile;
    },
    getProfile: async user => {
      const snapshot = await profileRef(user).get();
      return snapshot.exists ? snapshot.data() : {};
    },
    createShare: async (user, deck) => {
      const shareRef = db.collection("sharedDecks").doc();
      await shareRef.set({
        ownerId: user.uid,
        title: deck.title || "Shared Reviewer Deck",
        cards: deck.cards || [],
        subjectMode: deck.subjectMode || "general",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return shareRef.id;
    },
    getSharedDeck: async shareId => {
      const snapshot = await db.collection("sharedDecks").doc(shareId).get();
      return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
    },
    searchUsers: async (query, currentUser) => {
      const normalized = String(query || "").trim().toLowerCase();
      if (normalized.length < 2) return [];
      const snapshot = await db.collection("publicProfiles")
        .orderBy("displayNameLower")
        .startAt(normalized)
        .endAt(`${normalized}\uf8ff`)
        .limit(20)
        .get();
      return snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(profile => profile.id !== currentUser.uid);
    },
    sendFriendRequest: async (user, target) => {
      const requestId = `${user.uid}_${target.id}`;
      await db.collection("friendRequests").doc(requestId).set({
        fromId: user.uid,
        toId: target.id,
        fromName: user.displayName || user.email || "Paduan",
        toName: target.displayName || "Paduan",
        participants: [user.uid, target.id],
        status: "pending",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    },
    listFriendRequests: async user => {
      const snapshot = await db.collection("friendRequests")
        .where("toId", "==", user.uid)
        .limit(50)
        .get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(request => request.status === "pending");
    },
    respondToFriendRequest: async (requestId, status) => {
      if (!["accepted", "rejected"].includes(status)) throw new Error("Invalid friend request response.");
      await db.collection("friendRequests").doc(requestId).update({ status });
    },
    listFriends: async user => {
      const snapshot = await db.collection("friendRequests")
        .where("participants", "array-contains", user.uid)
        .limit(100)
        .get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(friend => friend.status === "accepted");
    }
  };
})();
