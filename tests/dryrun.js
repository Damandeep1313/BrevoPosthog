const mongoose = require("mongoose");
const axios = require("axios");
require("dotenv").config();

// ---------- CONFIG ----------
const MONGO_URI =
  "mongodb+srv://Damandeep:MongoDB@cluster0.9j661l9.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
const BASE_URL =
  "https://us.posthog.com/api/projects/128173/session_recordings/";
const LIMIT = 1000;

// ---------- SCHEMA ----------
const userSchema = new mongoose.Schema({
  email: String,
  count: Number,
  start_time: Date,
  end_time: Date,
  session_history: [Date],
  last_template_sent: String,
  last_template_sent_at: Date,
});
const User = mongoose.model("User", userSchema);

const unsubscribedSchema = new mongoose.Schema({ email: String });
const UnsubscribedUser = mongoose.model(
  "UnsubscribedUser",
  unsubscribedSchema,
  "unsubscribed"
);

// ---------- HELPERS ----------
function classifyUser(user) {
  const now = new Date();
  const periodLengthDays = 7;
  const inactiveThresholdDays = 14;
  const sessions = user.session_history;
  if (!sessions || sessions.length <= 1) return null;

  const sortedSessions = sessions
    .map((d) => new Date(d))
    .sort((a, b) => a - b);
  const lastSession = sortedSessions[sortedSessions.length - 1];

  const cutoffP0 = new Date(now - periodLengthDays * 24 * 60 * 60 * 1000);
  const cutoffP1 = new Date(now - 2 * periodLengthDays * 24 * 60 * 60 * 1000);
  const inactiveCutoff = new Date(
    now - inactiveThresholdDays * 24 * 60 * 60 * 1000
  );

  if (lastSession <= inactiveCutoff) return "Dormant";

  const P0 = sortedSessions.filter((d) => d > cutoffP0);
  const P1 = sortedSessions.filter((d) => d <= cutoffP0 && d > cutoffP1);

  if (P0.length > 0 && P1.length === 0) {
    const accountAgeDays =
      (now - new Date(user.start_time)) / (1000 * 60 * 60 * 24);
    if (accountAgeDays >= 14) return "Resurrecting";
  }

  if (P0.length > 0 && P1.length > 0) return "Returning";

  return null;
}

function shouldSendTemplate(user, templateName, cooldownDays = 14) {
  if (user.last_template_sent !== templateName) return true;
  if (!user.last_template_sent_at) return true;
  const diffDays =
    (Date.now() - new Date(user.last_template_sent_at)) /
    (1000 * 60 * 60 * 24);
  return diffDays >= cooldownDays;
}

async function fetchSessionRecordings(apiKey) {
  let allRecordings = [];
  let nextUrl = `${BASE_URL}?limit=${LIMIT}`;
  while (nextUrl) {
    const response = await axios.get(nextUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    allRecordings = allRecordings.concat(response.data.results);
    nextUrl = response.data.next;
  }
  return allRecordings;
}

// ---------- MAIN DRY RUN ----------
(async () => {
  try {
    console.time("🔄 Dry-Run Duration");
    await mongoose.connect(MONGO_URI);
    console.log("✅ MongoDB connected");

    const recordings = await fetchSessionRecordings(POSTHOG_API_KEY);
    console.log(`📦 Total PostHog recordings fetched: ${recordings.length}`);

    // --- Step 1: Group sessions ---
    const sessionMap = new Map();
    for (const rec of recordings) {
      const email = rec.person?.properties?.email;
      if (!email) continue;
      const end_time = new Date(rec.end_time || Date.now());
      if (!sessionMap.has(email)) sessionMap.set(email, []);
      sessionMap.get(email).push(end_time);
    }
    console.log(`📨 Unique emails in PostHog: ${sessionMap.size}`);

    // --- Step 2: DB Dry-Run (Insert/Update simulation) ---
    let toInsert = [],
      toUpdate = [];
    const existingUsers = await User.find(
      { email: { $in: Array.from(sessionMap.keys()) } },
      { email: 1, session_history: 1 }
    ).lean();

    const existingMap = new Map(existingUsers.map((u) => [u.email, u]));

    for (const [email, newSessions] of sessionMap.entries()) {
      const existing = existingMap.get(email);

      if (!existing) {
        toInsert.push({ email, newSessions });
      } else {
        const allSessions = [
          ...existing.session_history.map((d) => new Date(d)),
          ...newSessions,
        ];
        const uniqueSessions = Array.from(
          new Set(allSessions.map((d) => new Date(d).toISOString()))
        ).map((d) => new Date(d));
        const changed =
          uniqueSessions.length !== existing.session_history.length;
        if (changed) {
          toUpdate.push({
            email,
            oldCount: existing.session_history.length,
            newCount: uniqueSessions.length,
          });
        }
      }
    }

    console.log(`\n✅ DB Dry-Run Summary:
➕ To Insert: ${toInsert.length}
🔄 To Update: ${toUpdate.length}`);

    if (toInsert.length > 0) {
      console.log("\nSample Inserts:");
      console.table(toInsert.slice(0, 5));
    }
    if (toUpdate.length > 0) {
      console.log("\nSample Updates:");
      console.table(toUpdate.slice(0, 5));
    }

    // --- Step 3: Classification Dry-Run ---
    const unsubscribedEmails = new Set(
      (await UnsubscribedUser.find().lean()).map((u) => u.email)
    );
    const users = await User.find().lean(); // faster than full mongoose docs

    const emailBuckets = { Dormant: [], Resurrecting: [], Returning: [] };
    const toUpdateTemplate = [];

    for (const user of users) {
      if (unsubscribedEmails.has(user.email)) continue;

      const category = classifyUser(user);
      if (!category) continue;

      if (shouldSendTemplate(user, category)) {
        emailBuckets[category].push(user.email);
        toUpdateTemplate.push({
          email: user.email,
          newTemplate: category,
          oldTemplate: user.last_template_sent,
        });
      }
    }

    console.log(`\n✅ Classification Dry-Run:
Dormant: ${emailBuckets.Dormant.length}
Resurrecting: ${emailBuckets.Resurrecting.length}
Returning: ${emailBuckets.Returning.length}
Total to Update last_template_sent: ${toUpdateTemplate.length}`);

    console.log("\nSample Classified Users:");
    console.table(toUpdateTemplate.slice(0, 10));

    console.timeEnd("🔄 Dry-Run Duration");
    process.exit(0);
  } catch (err) {
    console.error("❌ Dry-Run Error:", err);
    process.exit(1);
  }
})();
