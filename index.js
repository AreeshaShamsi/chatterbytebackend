import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import session from "express-session";
import cookieParser from "cookie-parser";
import { google } from "googleapis";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// ✅ CORS setup (allow cookies from frontend)
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:3000",
      "https://chatterbytefrontend.vercel.app"
    ],
    credentials: true
  })
);

// ✅ Cookie & Session setup
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // HTTPS only in prod
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", // required for cross-site cookies
      maxAge: 24 * 60 * 60 * 1000 // 1 day
    }
  })
);

// 🌐 Root route
app.get("/", (req, res) => {
  res.send("📡 API is running 🚀");
});

// 🔐 Google OAuth Login
app.get("/api/auth/google", (req, res) => {
  const isLocal =
    req.headers.host?.includes("localhost") || req.headers.host?.includes("127.0.0.1");

  const redirectUri = isLocal
    ? "http://localhost:5000/api/auth/google/callback"
    : "https://chatterbytebackend.vercel.app/api/auth/google/callback";

  const scope = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send"
  ].join(" ");

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=${encodeURIComponent(
    scope
  )}&access_type=offline&prompt=consent`;

  res.redirect(authUrl);
});

// 🔄 Google OAuth Callback
app.get("/api/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing authorization code.");

  const isLocal =
    req.headers.host?.includes("localhost") || req.headers.host?.includes("127.0.0.1");

  const redirectUri = isLocal
    ? "http://localhost:5000/api/auth/google/callback"
    : "https://chatterbytebackend.vercel.app/api/auth/google/callback";

  try {
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();
    const email = userInfo.email;

    // ✅ Save user in session
    req.session.user = { email, tokens };

    const frontendRedirect = isLocal
      ? "http://localhost:5173/inbox"
      : "https://chatterbytefrontend.vercel.app/inbox";

    res.redirect(frontendRedirect);
  } catch (err) {
    console.error("❌ Google OAuth error:", err.message);
    res.status(500).send("Authentication failed.");
  }
});

// 📩 Get logged-in user's emails
app.get("/api/emails", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Not logged in" });
  }

  try {
    const { tokens, email } = req.session.user;
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    oauth2Client.setCredentials(tokens);

    const messages = await fetchEmails(oauth2Client);
    res.json([{ email, messages }]);
  } catch (error) {
    console.error("❌ Error fetching emails:", error.message);
    res.status(500).json({ error: "Failed to fetch emails" });
  }
});

// ❌ Logout route
app.post("/api/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Logout failed" });
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

// 📬 Fetch recent emails
async function fetchEmails(oauth2Client) {
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults: 5
  });

  if (!res.data.messages) return [];

  const messages = await Promise.all(
    res.data.messages.map(async msg => {
      const msgDetail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id
      });

      const headers = msgDetail.data.payload?.headers || [];
      const getHeader = name => headers.find(h => h.name === name)?.value || "";

      let textPlain = "";
      let textHtml = "";

      if (msgDetail.data.payload) {
        if (msgDetail.data.payload.parts && msgDetail.data.payload.parts.length) {
          for (const part of msgDetail.data.payload.parts) {
            if (part.mimeType === "text/plain" && part.body?.data) {
              textPlain = Buffer.from(part.body.data, "base64").toString("utf-8");
            }
            if (part.mimeType === "text/html" && part.body?.data) {
              textHtml = Buffer.from(part.body.data, "base64").toString("utf-8");
            }
          }
        } else if (msgDetail.data.payload.body?.data) {
          textPlain = Buffer.from(msgDetail.data.payload.body.data, "base64").toString("utf-8");
        }
      }

      return {
        subject: getHeader("Subject") || "(No Subject)",
        from: getHeader("From"),
        date: getHeader("Date"),
        snippet: msgDetail.data.snippet || "",
        textPlain,
        textHtml
      };
    })
  );

  return messages;
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
