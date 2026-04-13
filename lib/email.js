// Email helper — Gmail SMTP via nodemailer.

import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return transporter;
}

export async function sendEmail({ subject, html, attachments } = {}) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log("[email] Not configured, skipping");
    return false;
  }
  const to = (process.env.EMAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length) return false;

  await getTransporter().sendMail({
    from: process.env.GMAIL_USER,
    to,
    subject,
    html,
    attachments,
  });
  console.log(`[email] Sent → ${to.join(", ")}`);
  return true;
}
