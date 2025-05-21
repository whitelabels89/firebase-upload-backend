

const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const { google } = require("googleapis");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(bodyParser.json());

// Inisialisasi Firebase Admin SDK
const serviceAccount = require("./serviceAccountKey.json");
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// Helper: ambil data dari Google Sheets PROFILE_ANAK
async function getProfileAnakData() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const spreadsheetId = process.env.SPREADSHEET_ID;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "PROFILE_ANAK!A1:Z",
  });

  const rows = response.data.values;
  if (!rows || rows.length === 0) return [];

  const headers = rows[0];
  return rows.slice(1).map(row => {
    const rowObj = {};
    headers.forEach((header, i) => {
      rowObj[header.trim().toLowerCase()] = (row[i] || "").trim();
    });
    return rowObj;
  });
}

// Login endpoint
app.get("/login", async (req, res) => {
  const { username, password } = req.query;
  const sheetData = await getProfileAnakData();
  const user = sheetData.find(row =>
    row.whatsapp.replace(/\s+/g, "") === username &&
    password === "cerdas123"
  );

  if (user) {
    const migrated = user.migrated?.toLowerCase() === "true";
    return res.json({ success: true, cid: user.cid, migrated });
  }

  res.json({ success: false });
});

// Ganti password + migrasi Firebase
app.post("/ganti-password", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ success: false, message: "Data tidak valid." });
  }

  const sheetData = await getProfileAnakData();
  const userIndex = sheetData.findIndex(row =>
    row.whatsapp.replace(/\s+/g, "") === username
  );

  if (userIndex === -1) {
    return res.status(404).json({ success: false, message: "User tidak ditemukan." });
  }

  const fakeEmail = `${username.replace(/\D/g, "")}@queensacademy.id`;
  const displayName = sheetData[userIndex].nama || fakeEmail;

  try {
    const fbUser = await admin.auth().createUser({
      email: fakeEmail,
      password,
      displayName
    });

    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const client = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });
    const spreadsheetId = process.env.SPREADSHEET_ID;

    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "PROFILE_ANAK!A1:Z",
    });
    const rows = getRes.data.values;
    const headers = rows[0];
    const whatsappCol = headers.findIndex(col => col.toLowerCase() === "whatsapp");
    const passwordCol = headers.findIndex(col => col.toLowerCase() === "password");
    const migratedCol = headers.findIndex(col => col.toLowerCase() === "migrated");

    const rowIndex = rows.findIndex((row, idx) =>
      idx > 0 && (row[whatsappCol] || "").replace(/\s+/g, "") === username
    );

    if (rowIndex === -1) throw new Error("Row tidak ditemukan.");

    // Update password + migrated = TRUE
    const updateRange = `PROFILE_ANAK!${String.fromCharCode(65 + passwordCol)}${rowIndex + 1}`;
    const migratedRange = `PROFILE_ANAK!${String.fromCharCode(65 + migratedCol)}${rowIndex + 1}`;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: updateRange, values: [[password]] },
          { range: migratedRange, values: [["TRUE"]] }
        ]
      }
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("❌ Firebase createUser error:", error);
    return res.status(500).json({ success: false, message: "Firebase error" });
  }
});

// Migrate user endpoint (dummy, implement sesuai kebutuhan)
app.post("/migrate-user", async (req, res) => {
  // Implementasi migrasi user sesuai kebutuhan di sini
  res.json({ success: true, message: "Endpoint migrate-user belum diimplementasi." });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 auth_server berjalan di http://localhost:${PORT}`);
});