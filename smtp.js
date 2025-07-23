const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const nodemailer = require("nodemailer");
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

// ---------- SMTP SETUP ----------
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false, // STARTTLS
  auth: {
    user: process.env.BREVO_SMTP_USER, // usually your Brevo email
    pass: process.env.BREVO_SMTP_PASS, // Brevo SMTP key
  },
});

const templateHtml = {
  Dormant: `<p>We noticed you haven't been active. Come back now!</p>`,
  Resurrecting: `<p>Welcome back! Here's what's new...</p>`,
  Returning: `<p>Thanks for returning! Keep exploring...</p>`,
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

// ---------- HELPERS (Same as Before) ----------
function classifyUser(user) { /* same as before */ }
function shouldSendTemplate(user, templateName, cooldownDays = 14) { /* same as before */ }
async function fetchSessionRecordings(apiKey) { /* same as before */ }

// ---------- SMTP EMAIL SENDER ----------
async function sendEmailsInBatches(emails, templateName) {
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);

    const mailOptions = {
      from: `"On-Demand" <info@on-demand.io>`,
      subject: `${templateName} Update`,
      html: templateHtml[templateName],
    };

    try {
      console.log(
        `📧 Sending ${templateName} Batch ${i / BATCH_SIZE + 1} (${batch.length} emails)`
      );

      for (const email of batch) {
        await transporter.sendMail({ ...mailOptions, to: email });
      }
    } catch (err) {
      console.error(`❌ Error sending ${templateName} batch:`, err.message);
    }

    await new Promise((r) => setTimeout(r, 2000)); // 2s delay
  }
}

// ---------- MAIN SYNC (Same as Before except email sending) ----------
app.get("/sync", async (req, res) => {
  const apiKey = req.headers["x-posthog-api-key"];
  if (!apiKey) return res.status(401).send("PostHog API key missing");

  try {
    console.time("🔄 Sync Duration");
    // ... [DB Fetch + Classification same as before] ...

    // Send Emails in Batches (SMTP)
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

// ---------- TEST EMAIL ----------
app.get("/test-email", async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send("Email query param required");

  try {
    await transporter.sendMail({
      from: `"On-Demand" <info@on-demand.io>`,
      to: email,
      subject: "Test Dormant Email",
      html: templateHtml.Dormant,
    });
    res.send(`✅ Test email sent to ${email}`);
  } catch (err) {
    console.error("❌ Test email error:", err.message);
    res.status(500).send(`❌ Error: ${err.message}`);
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
