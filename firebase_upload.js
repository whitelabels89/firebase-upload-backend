const express = require('express');
const multer = require('multer');
const cors = require("cors"); // ⬅️ Tambahin ini
const { Storage } = require("@google-cloud/storage");
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { google } = require("googleapis");

// Tulis file kredensial lebih awal
const serviceAccountBuffer = Buffer.from(process.env.SERVICE_ACCOUNT_KEY_BASE64, "base64");
fs.writeFileSync("serviceAccountKey.json", serviceAccountBuffer);

const serviceAccount = require("./serviceAccountKey.json");


// Init Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'socmed-karya-anak.firebasestorage.app'
});

const bucket = admin.storage().bucket();
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors()); // ⬅️ Ini juga WAJIB
app.use(express.json({ limit: "5mb" })); // Bisa sesuaikan hingga 10mb kalau perlu
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// Ambil data dari Google Sheets PROFILE_ANAK
async function getProfileAnakData() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "serviceAccountKey.json", // ⬅️ INI YANG BELUM ADA
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

// Endpoint: login dengan nomor WhatsApp dan password
app.get("/login", async (req, res) => {
  const { username, password } = req.query;

  try {
    const sheetData = await getProfileAnakData();
    const user = sheetData.find(row =>
      row.whatsapp.replace(/\s+/g, "") === username &&
      row.password === password
    );

    if (user) {
      const migrated = user.migrated?.toLowerCase() === "true";
      return res.json({ success: true, cid: user["cid"], migrated });
    }

    res.json({ success: false });
  } catch (err) {
    console.error("❌ Error login:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});



// Upload middleware
const upload = multer({ dest: 'uploads/' });

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const { cid, title } = req.body;

    if (!file || !cid || !title) {
      return res.status(400).json({ message: 'Missing file, cid, or title.' });
    }

    const filename = `karya/${cid}/${Date.now()}_${file.originalname}`;
    const uploaded = await bucket.upload(file.path, {
      destination: filename,
      public: true,
      metadata: { contentType: file.mimetype }
    });

    fs.unlinkSync(file.path); // hapus file temp

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
    const id_karya = `KID-${cid}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    console.log('✅ Uploaded to Firebase:', publicUrl);

    await fetch("https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cid, title, url: publicUrl, id_karya })
    });
    
    res.status(200).json({ message: '✅ Karya berhasil diupload!', url: publicUrl });

  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).json({ message: '❌ Gagal upload: ' + err.message });
  }
});

// Tambahkan di firebase-upload-backend
app.post("/update-profil", async (req, res) => {
  try {
    const response = await fetch("https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });

    const result = await response.json();
    res.json(result);

  } catch (err) {
    console.error("❌ Gagal update profil:", err);
    res.status(500).json({ message: "❌ Gagal update profil", error: err.message });
  }
});


app.post("/hapus-karya", async (req, res) => {
  try {
    const { cid, id_karya } = req.body;
    if (!cid || !id_karya) {
      return res.status(400).json({ success: false, message: "Missing CID or id_karya" });
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: "serviceAccountKey.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

    const sheetId = "1z7ybkdO4eLsV_STdzO8pOVMZNUzdfcScSERyOFNm-GY";
    const tabName = "KARYA_ANAK";
    const sheetIdInternal = 368316898;

    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tabName}!A2:E`,
    });

    const rows = getRes.data.values || [];
    console.log("📥 Mencari ID_KARYA:", id_karya);
    const rowIndex = rows.findIndex((r, i) => {
      const id = (r[4] || "").toString().trim().toUpperCase();
      console.log(`🔍 Row ${i}:`, id);
      return id === id_karya.toUpperCase();
    });

    if (rowIndex === -1) {
      console.error("❌ ID_KARYA tidak ditemukan di sheet");
      return res.status(404).json({ success: false, message: "ID_KARYA tidak ditemukan di sheet" });
    }

    let deleted = false;
    try {
      const fileUrl = rows[rowIndex][3];
      console.log("📦 fileUrl dari Sheet:", fileUrl);
      if (!fileUrl || typeof fileUrl !== "string" || !fileUrl.startsWith("http")) {
        throw new Error("fileUrl tidak valid: " + fileUrl);
      }
      const urlObj = new URL(fileUrl);
      const pathParts = urlObj.pathname.split('/');
      const filename = decodeURIComponent(pathParts.slice(2).join('/'));

      console.log("🧹 Deleting file:", filename);
      await bucket.file(filename).delete();
      deleted = true;
      // Logging output rowIndex, filename, and deleted before res.json
      console.log("✅ rowIndex ditemukan:", rowIndex);
      console.log("✅ filename parsed:", filename);
      console.log("✅ deleted status:", deleted);
    } catch (err) {
      console.warn("⚠️ Gagal menghapus file:", err.message);
    }

    // Hapus baris dari sheettttt
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: sheetIdInternal,
              dimension: "ROWS",
              startIndex: rowIndex + 1,
              endIndex: rowIndex + 2,
            },
          },
        }],
      },
    });

    res.json({
      success: true,
      message: deleted ? "Berhasil hapus karya dan file" : "Berhasil hapus karya (file tidak ditemukan)"
    });

  } catch (e) {
    console.error("❌ Gagal hapus karya (fatal):", e);
    if (e.response && e.response.data) {
      console.error("📦 Error detail dari Google API:", e.response.data);
    }
    res.status(500).json({ success: false, message: "Internal error", error: e.message });
  }
});

// Proxy endpoint untuk bypass CORS ke Google Apps Script
app.get("/proxy-following", async (req, res) => {
  const { cid } = req.query;
  if (!cid) return res.status(400).json({ error: "Missing cid" });

  const url = `https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec?cid=${cid}`;
  try {
    const response = await fetch(url);
    const text = await response.text();

    if (!text.startsWith("{") && !text.startsWith("[")) {
      console.error("❌ Invalid response from Google Script:", text.slice(0, 100));
      return res.status(500).json({ error: "Invalid response from Google Apps Script", preview: text.slice(0, 100) });
    }

    const json = JSON.parse(text);
    res.json(json);
  } catch (err) {
    console.error("❌ Proxy Error:", err);
    res.status(500).json({ error: "Proxy gagal", detail: err.message });
  }
});

// Proxy endpoint untuk bypass CORS ke Google Apps Script (GET profil by CID)
app.get('/proxy-getprofile', async (req, res) => {
  const { cid } = req.query;

  if (!cid) {
    return res.status(400).json({ error: "Missing cid" });
  }

  const url = `https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec?cid=${cid}`;

  try {
    const response = await fetch(url);
    const text = await response.text();

    if (!text.startsWith("{") && !text.startsWith("[")) {
      console.error("❌ Invalid response from Google Script:", text.slice(0, 100));
      return res.status(500).json({ error: "Invalid response from Google Apps Script", preview: text.slice(0, 100) });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(text);
  } catch (err) {
    console.error("❌ Proxy GetProfile Error:", err);
    res.status(500).json({ error: "Proxy gagal", detail: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('🔥 Firebase Upload Server Ready');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
