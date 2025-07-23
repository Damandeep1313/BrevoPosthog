const Brevo = require("@getbrevo/brevo");
require("dotenv").config();

const brevoApi = new Brevo.TransactionalEmailsApi();
brevoApi.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

(async () => {
  try {
    await brevoApi.sendTransacEmail({
      to: [{ email: "damandeepsingh24090@gmail.com" }],
      sender: { email: "info@on-demand.io", name: "On-Demand" },
      templateId: 115, // replace with your active template ID
    });
    console.log("✅ Email sent!");
  } catch (error) {
    console.error("❌ Detailed Error:", JSON.stringify(error, null, 2));
  }
})();
