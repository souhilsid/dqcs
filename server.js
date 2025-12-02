const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// --- Firebase Admin init ---
const servicePath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || "./serviceAccountKey.json";

if (!fs.existsSync(servicePath)) {
  console.error(
    `Firebase service account file not found at ${servicePath}. Set GOOGLE_APPLICATION_CREDENTIALS env var to the mounted path on Render.`
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(path.resolve(servicePath))),
});

const db = admin.firestore();
const players = db.collection("players");
const events = db.collection("playerEvents");

// --- Helpers ---
const normalizePhone = (p = "") => p.replace(/[^0-9+]/g, "");
const requireSecret = (req, res, next) => {
  const needed = process.env.BIN_SECRET;
  if (!needed) return next(); // open if no secret set
  const provided = req.headers["x-bin-secret"] || req.query.secret;
  if (provided !== needed) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
};

// --- App ---
const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

// Register/attach profile
app.post("/register", requireSecret, async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });
    const phoneNorm = normalizePhone(phone);
    const docRef = players.doc(phoneNorm);
    await docRef.set(
      {
        name: name || "",
        phone: phoneNorm,
        lastSource: "registration",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Save party result + award coins
app.post("/partyResult", requireSecret, async (req, res) => {
  try {
    const { phone, gameId, score, coins } = req.body;
    if (!phone || !gameId)
      return res.status(400).json({ error: "phone and gameId required" });

    const phoneNorm = normalizePhone(phone);
    const docRef = players.doc(phoneNorm);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const bestPath = `partyScores.${gameId}.bestScore`;
      const currentBest =
        snap.exists && snap.get(bestPath) ? snap.get(bestPath) : 0;
      const newBest = Math.max(currentBest, score || 0);

      tx.set(
        docRef,
        {
          [`partyScores.${gameId}.lastScore`]: score || 0,
          [`partyScores.${gameId}.bestScore`]: newBest,
          coins: admin.firestore.FieldValue.increment(coins || 0),
          lastSource: `party:${gameId}`,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      tx.set(events.doc(), {
        phone: phoneNorm,
        source: `party:${gameId}`,
        score: score || 0,
        amount: coins || 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Spend coins (server-side check)
app.post("/spend", requireSecret, async (req, res) => {
  try {
    const { phone, amount, reason } = req.body;
    if (!phone || !amount)
      return res.status(400).json({ error: "phone and amount required" });
    const phoneNorm = normalizePhone(phone);
    const docRef = players.doc(phoneNorm);

    const ok = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const balance = snap.exists && snap.get("coins") ? snap.get("coins") : 0;
      if (balance < amount) return false;

      tx.update(docRef, {
        coins: admin.firestore.FieldValue.increment(-amount),
        lastSource: reason || "spend",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(events.doc(), {
        phone: phoneNorm,
        source: reason || "spend",
        amount: -amount,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return true;
    });

    if (!ok) return res.status(400).json({ error: "insufficient funds" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Get balance
app.get("/coins", requireSecret, async (req, res) => {
  try {
    const phoneNorm = normalizePhone(req.query.phone);
    if (!phoneNorm) return res.status(400).json({ error: "phone required" });
    const snap = await players.doc(phoneNorm).get();
    res.json({ coins: snap.exists ? snap.get("coins") || 0 : 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`API running on ${PORT}`));
