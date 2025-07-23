const mongoose = require("mongoose");

// ---------- CONFIG ----------
const MONGO_URI = "mongodb+srv://Damandeep:MongoDB@cluster0.9j661l9.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

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

// ---------- CLASSIFICATION ----------
function classifyUser(user) {
  const now = new Date();
  const periodLengthDays = 7;
  const inactiveThresholdDays = 14;
  const sessions = user.session_history;
  if (!sessions || sessions.length <= 1) return null;

  const sortedSessions = sessions.sort((a, b) => new Date(a) - new Date(b));
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

// ---------- RUN SCRIPT ----------
(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB");

    const emailArg = process.argv[2]; // email passed as argument

    if (emailArg) {
      // ----- CHECK SINGLE EMAIL -----
      const user = await User.findOne({ email: emailArg });
      if (!user) {
        console.log(`❌ No user found with email: ${emailArg}`);
      } else {
        const category = classifyUser(user) || "None";
        console.log(`✅ User: ${emailArg}`);
        console.log(`📌 Category: ${category}`);
        console.log(`📜 Session History:`, user.session_history);
      }
      process.exit(0);
    } else {
      // ----- RUN FULL CLASSIFICATION -----
      const users = await User.find();
      console.log(`📦 Total users in DB: ${users.length}`);

      const counts = { Dormant: 0, Resurrecting: 0, Returning: 0, None: 0 };
      const samples = { Dormant: [], Resurrecting: [], Returning: [], None: [] };

      for (const user of users) {
        const category = classifyUser(user);
        if (category) {
          counts[category]++;
          if (samples[category].length < 5) samples[category].push(user.email);
        } else {
          counts.None++;
          if (samples.None.length < 5) samples.None.push(user.email);
        }
      }

      console.log("\n✅ Classification Complete:");
      console.table(counts);

      console.log("\n🔍 Sample Users:");
      for (const [cat, emails] of Object.entries(samples)) {
        console.log(`\n${cat}:`);
        console.log(emails.join("\n") || "None");
      }

      process.exit(0);
    }
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
})();
