const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const Brevo = require("@getbrevo/brevo"); // Brevo (Sendinblue) official SDK
require("dotenv").config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
// ---------- CONFIG ----------
const MONGO_URI = process.env.MONGO_URI;
const BASE_URL =
  "https://us.posthog.com/api/projects/128173/session_recordings/";
const LIMIT = 1000;
const BATCH_SIZE = 100;

// ---------- BREVO SETUP ----------
const brevoClient = new Brevo.TransactionalEmailsApi();
brevoClient.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

const templateIdMap = {
  Dormant: 115, // Replace with actual Brevo template IDs
  Resurrecting: 117,
  Returning: 116,
};

// ---------- SCHEMAS ----------
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

async function sendEmailsInBatches(emails, templateName) {
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    const sendSmtpEmail = {
      sender: { name: "On-Demand", email: "info@on-demand.io" },
      to: batch.map((email) => ({ email })),
      templateId: templateIdMap[templateName],
      params: { subject: `Your ${templateName} email` },
    };

    try {
      console.log(
        `📧 Sending ${templateName} Batch ${
          i / BATCH_SIZE + 1
        } (${batch.length} emails)`
      );
      await brevoClient.sendTransacEmail(sendSmtpEmail);
    } catch (err) {
      console.error(`❌ Error sending ${templateName} batch:`, err.message);
    }

    await new Promise((r) => setTimeout(r, 2000)); // 2s delay
  }
}

// ---------- MAIN SYNC ----------
app.get("/sync", async (req, res) => {
    const apiKey = req.headers["x-posthog-api-key"];
    if (!apiKey) return res.status(401).send("PostHog API key missing");

  try {
    console.time("🔄 Sync Duration");

    const recordings = await fetchSessionRecordings(apiKey);
    console.log(`📦 Total PostHog recordings fetched: ${recordings.length}`);

    // Group sessions
    const sessionMap = new Map();
    for (const rec of recordings) {
      const email = rec.person?.properties?.email;
      if (!email) continue;
      const end_time = new Date(rec.end_time || Date.now());
      if (!sessionMap.has(email)) sessionMap.set(email, []);
      sessionMap.get(email).push(end_time);
    }
    console.log(`📨 Unique emails in PostHog: ${sessionMap.size}`);

    const existingUsers = await User.find(
      { email: { $in: Array.from(sessionMap.keys()) } },
      { email: 1, session_history: 1, start_time: 1, end_time: 1 }
    ).lean();
    const existingMap = new Map(existingUsers.map((u) => [u.email, u]));

    let toInsert = [],
      toUpdate = [];
    for (const [email, newSessions] of sessionMap.entries()) {
      const existing = existingMap.get(email);

      if (!existing) {
        toInsert.push({
          email,
          start_time: newSessions[0],
          end_time: newSessions[newSessions.length - 1],
          count: newSessions.length,
          session_history: [...newSessions],
        });
      } else {
        const allSessions = [
          ...existing.session_history.map((d) => new Date(d)),
          ...newSessions,
        ];
        const uniqueSessions = Array.from(
          new Set(allSessions.map((d) => d.toISOString()))
        ).map((d) => new Date(d));
        if (uniqueSessions.length !== existing.session_history.length) {
          toUpdate.push({
            updateOne: {
              filter: { email },
              update: {
                $set: {
                  session_history: uniqueSessions,
                  count: uniqueSessions.length,
                  end_time: new Date(
                    Math.max(...uniqueSessions.map((d) => d.getTime()))
                  ),
                },
              },
            },
          });
        }
      }
    }

    if (toInsert.length > 0) await User.insertMany(toInsert, { ordered: false });
    if (toUpdate.length > 0) await User.bulkWrite(toUpdate);

    console.log(`✅ DB Updated: Inserted ${toInsert.length}, Updated ${toUpdate.length}`);

    // Classification
    const unsubscribedEmails = new Set(
      (await UnsubscribedUser.find().lean()).map((u) => u.email)
    );
    const users = await User.find().lean();

    const emailBuckets = { Dormant: [], Resurrecting: [], Returning: [] };
    const updatesForTemplates = [];

    for (const user of users) {
      if (unsubscribedEmails.has(user.email)) continue;
      const category = classifyUser(user);
      if (!category) continue;
      if (shouldSendTemplate(user, category)) {
        emailBuckets[category].push(user.email);
        updatesForTemplates.push({
          updateOne: {
            filter: { email: user.email },
            update: {
              $set: {
                last_template_sent: category,
                last_template_sent_at: new Date(),
              },
            },
          },
        });
      }
    }

    if (updatesForTemplates.length > 0)
      await User.bulkWrite(updatesForTemplates);

    console.log(`✅ Classified & Updated Templates: ${updatesForTemplates.length}`);
    console.log(`Dormant: ${emailBuckets.Dormant.length}`);
    console.log(`Resurrecting: ${emailBuckets.Resurrecting.length}`);
    console.log(`Returning: ${emailBuckets.Returning.length}`);

    // Send Emails in Batches
    for (const [segment, emails] of Object.entries(emailBuckets)) {
      if (emails.length > 0) await sendEmailsInBatches(emails, segment);
    }

    console.timeEnd("🔄 Sync Duration");
    res.send("✅ Sync complete & emails sent");
  } catch (err) {
    console.error("❌ Sync Error:", err);
    res.status(500).send("Sync failed");
  }
});








app.get("/dryrun", async (req, res) => {
    const apiKey = req.headers["x-posthog-api-key"];
    if (!apiKey) return res.status(401).send("PostHog API key missing");
  try {
    console.time("🧪 Dry-Run Duration");
    const recordings = await fetchSessionRecordings(apiKey);
    console.log(`📦 Total PostHog recordings fetched: ${recordings.length}`);

    // Group sessions
    const sessionMap = new Map();
    for (const rec of recordings) {
      const email = rec.person?.properties?.email;
      if (!email) continue;
      const end_time = new Date(rec.end_time || Date.now());
      if (!sessionMap.has(email)) sessionMap.set(email, []);
      sessionMap.get(email).push(end_time);
    }
    console.log(`📨 Unique emails in PostHog: ${sessionMap.size}`);

    const existingUsers = await User.find(
      { email: { $in: Array.from(sessionMap.keys()) } },
      { email: 1, session_history: 1, start_time: 1, end_time: 1 }
    ).lean();
    const existingMap = new Map(existingUsers.map((u) => [u.email, u]));

    let toInsert = [],
      toUpdate = [];
    for (const [email, newSessions] of sessionMap.entries()) {
      const existing = existingMap.get(email);

      if (!existing) {
        toInsert.push({
          email,
          newSessions,
        });
      } else {
        const allSessions = [
          ...existing.session_history.map((d) => new Date(d)),
          ...newSessions,
        ];
        const uniqueSessions = Array.from(
          new Set(allSessions.map((d) => d.toISOString()))
        ).map((d) => new Date(d));
        if (uniqueSessions.length !== existing.session_history.length) {
          toUpdate.push({
            email,
            oldCount: existing.session_history.length,
            newCount: uniqueSessions.length,
          });
        }
      }
    }

    console.log(`✅ DB Dry-Run Summary:
➕ To Insert: ${toInsert.length}
🔄 To Update: ${toUpdate.length}`);

    console.table(toInsert.slice(0, 5));
    console.table(toUpdate.slice(0, 5));

    // Classification dry run
    const unsubscribedEmails = new Set(
      (await UnsubscribedUser.find().lean()).map((u) => u.email)
    );
    const users = await User.find().lean();

    const emailBuckets = { Dormant: [], Resurrecting: [], Returning: [] };
    for (const user of users) {
      if (unsubscribedEmails.has(user.email)) continue;
      const category = classifyUser(user);
      if (!category) continue;
      if (shouldSendTemplate(user, category)) {
        emailBuckets[category].push(user.email);
      }
    }

    console.log(`✅ Classification Dry-Run:
Dormant: ${emailBuckets.Dormant.length}
Resurrecting: ${emailBuckets.Resurrecting.length}
Returning: ${emailBuckets.Returning.length}`);

    console.table(
      [...emailBuckets.Dormant, ...emailBuckets.Resurrecting, ...emailBuckets.Returning]
        .slice(0, 10)
        .map((email) => ({ email }))
    );

    console.timeEnd("🧪 Dry-Run Duration");
    res.send("✅ Dry-Run complete. Check logs for details.");
  } catch (err) {
    console.error("❌ Dry-Run Error:", err);
    res.status(500).send("Dry-run failed");
  }
});


app.get("/test-email", async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send("Email query param required");

  try {
    const response = await brevoClient.sendTransacEmail({
      sender: { name: "On-Demand", email: "info@on-demand.io" },
      to: [{ email }],
      templateId: 115, // your Dormant template
      params: {
        name: email.split("@")[0],
        subject: "Test Dormant Email",
      },
    });
    res.send(`✅ Test email sent to ${email}: ${JSON.stringify(response)}`);
  } catch (err) {
    console.error("❌ Test email error:", err.response?.body || err.message);
    res
      .status(500)
      .send(`❌ Error: ${JSON.stringify(err.response?.body || err.message)}`);
  }
});





// ---------- START ----------
mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected");
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch((err) => console.error("❌ MongoDB error:", err));
