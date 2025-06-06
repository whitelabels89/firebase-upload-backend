
// Google Sheets helper
const { google } = require("googleapis");


async function authSheets() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return google.sheets({ version: "v4", auth });
}

// --- Upload gambar robot ke Firebase Storage + metadata ke Firestore ---
const express = require('express');
const app = express();
const fs = require('fs');
const serviceAccountBuffer = Buffer.from(process.env.SERVICE_ACCOUNT_KEY_BASE64, "base64");
fs.writeFileSync("serviceAccountKey.json", serviceAccountBuffer);
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const uploadMemory = multer({ storage: multer.memoryStorage() });

// Middleware
const cors = require("cors");
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

const sheets = google.sheets("v4");

// Endpoint: Generate CID untuk akun baru (CQA)
app.get("/generate-cqa", async (req, res) => {
  try {
    const snapshot = await db.collection("akun").get();
    const count = snapshot.size;
    const cidNumber = 10020000 + count + 1;
    const cid = "CQA" + cidNumber;
    res.json({ cid });
  } catch (err) {
    console.error("Error generating CID:", err);
    res.status(500).json({ error: "Failed to generate CID" });
  }
});

// Deklarasi docPsikotest
const { GoogleSpreadsheet } = require('google-spreadsheet');
const docPsikotest = new GoogleSpreadsheet('1z7ybkdO4eLsV_STdzO8pOVMZNUzdfcScSERyOFNm-GY');

// Endpoint: Daftar akun baru (simpan ke Firestore dan Sheets)
app.post("/api/daftar-akun-baru", async (req, res) => {
  const { uid, cid, nama, email, wa, password, role } = req.body;

  try {
    // Cek apakah CID sudah ada di PROFILE_ANAK
    const auth = new google.auth.GoogleAuth({
      keyFile: "serviceAccountKey.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const client = await auth.getClient();
    const sheetsClient = google.sheets({ version: "v4", auth: client });
    const spreadsheetId = "1z7ybkdO4eLsV_STdzO8pOVMZNUzdfcScSERyOFNm-GY";
    const sheetName = "PROFILE_ANAK";

    // Fetch all CID column
    const getRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A2:A`,
    });
    const rows = getRes.data.values || [];
    const cidExists = rows.some(row => (row[0] || "").toString().trim() === cid);
    if (cidExists) {
      return res.status(400).json({ error: "CID sudah terdaftar." });
    }

    // 1. Simpan ke Firestore
    await db.collection("akun").doc(uid).set({
      cid, nama, email, whatsapp: wa, role: role || "murid", migrated: true
    });

    // 2. Simpan ke Sheets PROFILE_ANAK dengan header eksplisit
    const values = [[
      cid,
      uid,
      nama,
      "", // Usia Anak
      "", // Foto
      wa,
      password, // Password
      email,
      "TRUE", // Migrated
      role || "murid"
    ]];
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A2`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      resource: { values }
    });
    console.log("✅ Data berhasil ditulis ke PROFILE_ANAK");

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Error saving new account:", err);
    res.status(500).json({ error: "Failed to save account" });
  }
});

// (appendToSheet tidak digunakan lagi untuk daftar akun baru)

// Endpoint: Upload gambar robot (Kody)
app.post('/upload-kody-image', uploadMemory.single('image'), async (req, res) => {
  try {
    const { cid, judul } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    if (!cid || !judul) {
      return res.status(400).json({ success: false, message: 'Missing cid or judul' });
    }

    const filename = `kody/${cid}_${uuidv4()}.png`;
    const fileUpload = bucket.file(filename);

    const blobStream = fileUpload.createWriteStream({
      metadata: {
        contentType: file.mimetype
      }
    });

    blobStream.on('error', (err) => {
      console.error('Upload error:', err);
      res.status(500).json({ success: false, message: 'Upload failed' });
    });

    blobStream.on('finish', async () => {
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
      await db.collection('karya_anak').add({
        cid,
        judul,
        link: publicUrl,
        timestamp: new Date()
      });
      res.json({ success: true, link: publicUrl });
    });

    blobStream.end(file.buffer);
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
const fetch = require('node-fetch');
const { Storage } = require("@google-cloud/storage");
const admin = require('firebase-admin');
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const path = require('path');
const serviceAccount = require("./serviceAccountKey.json");

// Init Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'queens-academy-icoding.appspot.com'
});

const db = admin.firestore();
const bucket = admin.storage().bucket();
const PORT = process.env.PORT || 3001;

// Ambil data dari Google Sheets PROFILE_ANAK
async function getProfileAnakData() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "serviceAccountKey.json", 
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  const sheetsClient = google.sheets({ version: "v4", auth: client });
  const spreadsheetId = process.env.SPREADSHEET_ID;

  const response = await sheetsClient.spreadsheets.values.get({
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

// Endpoint: login manual, menerima identifier (email atau nomor WA) dan password (HYBRID fallback)
const axios = require('axios');
app.post("/login", async (req, res) => {
  const { identifier, password } = req.body;
  console.log("📲 Login request by:", identifier);
  try {
    const isEmail = identifier.includes("@");
    let loginEmail = identifier;

    if (!isEmail) {
      const snapshot = await db.collection("akun").where("wa", "==", identifier).limit(1).get();
      if (!snapshot.empty) {
        loginEmail = snapshot.docs[0].data().email;
        console.log("🔍 Resolved email from WA:", loginEmail);
      } else {
        return res.status(400).json({ error: "Nomor WA tidak ditemukan" });
      }
    } else {
      const snapshot = await db.collection("akun").where("email", "==", identifier.toLowerCase()).limit(1).get();
      if (!snapshot.empty) {
        loginEmail = snapshot.docs[0].data().email;
        console.log("🔍 Resolved email direct:", loginEmail);
      } else {
        return res.status(400).json({ error: "Email tidak ditemukan di database" });
      }
    }

    const firebaseConfig = {
      apiKey: "AIzaSyBVO4ajDwkbcTGL33SVMxIoev4veB8itgI",
      authDomain: "queens-academy-icoding.firebaseapp.com",
      projectId: "queens-academy-icoding",
      storageBucket: "queens-academy-icoding.appspot.com",
      messagingSenderId: "1048549258959",
      appId: "1:1048549258959:web:f8dc1c104bb170d7ff69ba",
      measurementId: "G-RJCXM1YL7E"
    };
    const loginRes = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`,
      {
        email: loginEmail,
        password,
        returnSecureToken: true
      }
    ).catch(err => {
      if (err.response && err.response.data && err.response.data.error) {
        return { data: err.response.data };
      }
      throw err;
    });

    if (loginRes.data && loginRes.data.idToken) {
      res.status(200).json({ success: true, token: loginRes.data.idToken });
    } else {
      res.status(400).json({ error: "Gagal login, periksa kembali email/WA dan password Anda." });
    }
  } catch (err) {
    console.error("❌ Error login:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});



// Upload middleware
const upload = multer({ dest: 'uploads/' });

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const { cid, title } = req.body;

    const profileRes = await fetch(`https://firebase-upload-backend.onrender.com/proxy-getprofile?cid=${cid}`);
    const profile = await profileRes.json();
    const nama = profile.nama || "";

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

    const timestamp = Date.now();
    await db.collection("karya_anak").doc(id_karya).set({
      cid,
      nama,
      judul: title,
      url: publicUrl,
      id_karya,
      timestamp
    });
    
    res.status(200).json({ message: '✅ Karya berhasil diupload!', url: publicUrl });

  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).json({ message: '❌ Gagal upload: ' + err.message });
  }
});

// Endpoint: Feed Karya - Ambil 10 karya terbaru dari Firestore
app.get("/feed-karya", async (req, res) => {
  try {
    const snapshot = await db.collection("karya_anak")
      .orderBy("timestamp", "desc")
      .limit(10)
      .get();

    const karyaList = snapshot.docs.map(doc => doc.data());
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(karyaList);
  } catch (err) {
    console.error("❌ Gagal mengambil feed karya dari Firestore:", err);
    res.status(500).json({ message: "❌ Gagal ambil feed karya", error: err.message });
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
    console.log("🔁 Result dari ganti-password:", result);
    res.json(result);

  } catch (err) {
    console.error("❌ Gagal update profil:", err);
    res.status(500).json({ message: "❌ Gagal update profil", error: err.message });
  }
});

// Endpoint: update-following via POST dari frontend
app.post("/update-following", async (req, res) => {
  const { cid, followingList } = req.body;

  if (!cid || !Array.isArray(followingList)) {
    return res.status(400).json({ error: 'Data tidak valid' });
  }

  try {
    const url = `https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec`;

    // 1. Update FOLLOWING_ANAK
    const followingRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'updateFollowing',
        cid,
        followingList
      })
    });

    const followingResult = await followingRes.json();

    // 2. Update FOLLOWER_ANAK untuk semua target CID
    for (const targetCid of followingList) {
      const followerRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateFollower',
          cid: targetCid,
          followerList: [cid]
        })
      });

      const followerText = await followerRes.text();
      if (!followerText.trim().startsWith("{")) {
        console.error("❌ Invalid response from GAS (FOLLOWER):", followerText.slice(0, 100));
      }
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(followingResult);

  } catch (err) {
    console.error("❌ Error update-following/follower:", err);
    res.status(500).json({ error: "Gagal update following/follower", detail: err.message });
  }
});

// Endpoint: update-follower via POST dari frontend
app.post("/update-follower", async (req, res) => {
  try {
    const response = await fetch("https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req.body, action: "updateFollower" })
    });

    const result = await response.json();
    res.json(result);
  } catch (err) {
    console.error("❌ Gagal update follower:", err);
    res.status(500).json({ message: "❌ Gagal update follower", error: err.message });
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

    // Hapus baris dari sheet
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

// Proxy endpoint untuk bypass CORS ke Google Apps Script (GET daftar following)
app.get("/proxy-following", async (req, res) => {
  const { cid, action } = req.query;
  if (!cid) return res.status(400).json({ error: "Missing cid" });

  const url = `https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec?cid=${cid}&action=${action || "getfollowing"}`;

  try {
    const response = await fetch(url);
    const text = await response.text();

    if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) {
      console.error("❌ Invalid response from GAS (FOLLOWING):", text.slice(0, 100));
      return res.status(500).json({ error: "Invalid response from Google Apps Script", preview: text.slice(0, 100) });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(text);
  } catch (err) {
    console.error("❌ Proxy FOLLOWING Error:", err);
    res.status(500).json({ error: "Proxy gagal", detail: err.message });
  }
});

// Proxy endpoint untuk bypass CORS ke Google Apps Script (GET daftar follower)
app.get("/proxy-follower", async (req, res) => {
  const { cid, action } = req.query;
  if (!cid) return res.status(400).json({ error: "Missing cid" });

  const url = `https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec?cid=${cid}&action=${action || "getfollower"}`;

  try {
    const response = await fetch(url);
    const text = await response.text();
    // Handle explicit "CID not found" from Apps Script
    if (text.trim() === "CID not found") {
      console.error("⚠️ Apps Script FOLLOWER returned CID not found");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(404).json({ error: "CID not found" });
    }
    if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) {
      console.error("❌ Invalid response from GAS (FOLLOWER):", text.slice(0, 100));
      return res.status(500).json({ error: "Invalid response from Google Apps Script", preview: text.slice(0, 100) });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(text);
  } catch (err) {
    console.error("❌ Proxy FOLLOWER Error:", err);
    res.status(500).json({ error: "Proxy gagal", detail: err.message });
  }
});

// Proxy endpoint untuk bypass CORS ke Google Apps Script (GET profil by CID)
app.get('/proxy-getprofile', async (req, res) => {
  const { cid } = req.query;
  if (!cid) return res.status(400).json({ error: "Missing cid" });

  const url = `https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec?cid=${cid}`;

  try {
    const response = await fetch(url);
    const text = await response.text();
    // Handle explicit "CID not found" from Apps Script
    if (text.trim() === "CID not found") {
      console.error("⚠️ Apps Script PROFILE returned CID not found");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(404).json({ error: "CID not found" });
    }
    if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) {
      console.error("❌ Invalid response from GAS (PROFILE):", text.slice(0, 100));
      return res.status(500).json({ error: "Invalid response from Google Apps Script", preview: text.slice(0, 100) });
    }

    let profileData = JSON.parse(text);

    // Tambahkan role dari Firestore jika ada
    try {
      const docSnap = await db.collection("akun").doc(cid).get();
      if (docSnap.exists) {
        profileData.role = docSnap.data().role || "";
      }
    } catch (firestoreErr) {
      console.warn("⚠️ Gagal ambil role dari Firestore:", firestoreErr.message);
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(profileData);
  } catch (err) {
    console.error("❌ Proxy GETPROFILE Error:", err);
    res.status(500).json({ error: "Proxy gagal", detail: err.message });
  }
});

// Proxy untuk login ke Google Apps Script (validasi via Sheets)

app.post("/proxy-login-sheet", async (req, res) => {
  try {
    const response = await fetch("https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req.body, action: "loginSheet" }),
    });

    const result = await response.json();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(result);
  } catch (err) {
    console.error("❌ Proxy login sheet error:", err);
    res.status(500).json({ error: "Proxy gagal", detail: err.message });
  }
});

// Proxy endpoint: Cek apakah email terdaftar di Google Sheet
app.get("/proxy-check-email-sheet", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Missing email query parameter" });

  try {
    const authSheets = new google.auth.GoogleAuth({
      keyFile: "serviceAccountKey.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheetsClient = google.sheets({ version: "v4", auth: await authSheets.getClient() });
    const spreadsheetId = process.env.SPREADSHEET_ID || "1z7ybkdO4eLsV_STdzO8pOVMZNUzdfcScSERyOFNm-GY";
    const sheetName = "PROFILE_ANAK";

    // Fetch all rows
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A2:H`,
    });

    const rows = response.data.values || [];

    const matchedRow = rows.find(row => (row[6] || "").toLowerCase() === email.toLowerCase());
    if (!matchedRow) {
      return res.json({ exists: false });
    }

    const cid = matchedRow[0]; // kolom A = CID
    const migrated = matchedRow[7] === "TRUE"; // kolom H = Migrated

    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.json({ exists: true, cid, migrated });
  } catch (err) {
    console.error("❌ Error di /proxy-check-email-sheet:", err);
    return res.status(500).json({ error: err.message });
  }
});
// Proxy endpoint: Update 'Migrated' flag in Google Sheet
app.post("/proxy-update-migrated", async (req, res) => {
  const { email, migrated } = req.body;
  if (!email || typeof migrated !== "boolean") {
    return res.status(400).json({ error: "Invalid payload: email and migrated flag required" });
  }
  try {
    const authSheets = new google.auth.GoogleAuth({
      keyFile: "serviceAccountKey.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheetsClient = google.sheets({ version: "v4", auth: await authSheets.getClient() });
    const spreadsheetId = process.env.SPREADSHEET_ID || "1z7ybkdO4eLsV_STdzO8pOVMZNUzdfcScSERyOFNm-GY";
    const sheetName = "PROFILE_ANAK";

    // Read Email column (G)
    const readRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!G:G`,
    });
    const rows = readRes.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === email);
    if (rowIndex < 1) {
      return res.status(404).json({ error: "Email not found in sheet" });
    }

    // Update 'Migrated' column (column H)
    const targetCell = `${sheetName}!H${rowIndex + 1}`;
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: targetCell,
      valueInputOption: "RAW",
      requestBody: { values: [[ migrated ? "TRUE" : "FALSE" ]] }
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error in /proxy-update-migrated:", err);
    res.status(500).json({ error: err.message });
  }
});


app.get('/', (req, res) => {
  res.send('🔥 Firebase Upload Server Ready');
});

// Fungsi: Membuat atau update user email/password di Firebase Auth
const { getAuth } = require("firebase-admin/auth");
async function ensureEmailPasswordUser(email, password) {
  const auth = getAuth();
  try {
    const user = await auth.getUserByEmail(email);
    await auth.updateUser(user.uid, { password });
    console.log(`🔐 Updated password for existing user ${email}`);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      await auth.createUser({ email, password });
      console.log(`🆕 Created new user with email ${email}`);
    } else {
      console.error('❌ Firebase Admin Error:', err);
      throw err;
    }
  }
}

// Endpoint: ganti-password
app.post("/ganti-password", async (req, res) => {
  try {
    const { cid, email, password: newPassword } = req.body;
    if (!cid || !email || !newPassword) {
      return res.status(400).json({ success: false, message: "CID, email, dan password wajib diisi." });
    }
    console.log("📥 Ganti Password Diterima:", { cid, email, password: newPassword });

    // PATCH: Update Sheet PROFILE_ANAK dan Firestore terlebih dahulu agar hybrid login aktif
    const authSheets = new google.auth.GoogleAuth({
      keyFile: "serviceAccountKey.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheetsClient = google.sheets({ version: "v4", auth: await authSheets.getClient() });

    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = "PROFILE_ANAK";

    // Ambil data
    const getSheet = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:Z`,
    });
    const rows = getSheet.data.values;
    if (!rows || rows.length === 0) throw new Error("Sheet kosong");

    const headers = rows[0];
    // Cari kolom CID
    const cidIndex = headers.findIndex(h => h.toLowerCase() === "cid");
    // Cari baris berdasarkan CID
    const rowIndex = rows.findIndex((row, i) => i > 0 && row[cidIndex] === cid);
    if (rowIndex === -1) {
      console.error("❌ Row dengan CID tidak ditemukan:", cid);
      return res.status(404).json({ success: false, message: "CID tidak ditemukan di sheet" });
    }

    // Cari kolom password, migrated, email (dan tambahkan email jika belum ada)
    const passwordCol = headers.findIndex(h => h.toLowerCase() === "password");
    const migratedCol = headers.findIndex(h => h.toLowerCase() === "migrated");
    let emailCol = headers.findIndex(h => h.toLowerCase() === "email");

    if (emailCol === -1) {
      headers.push("Email");
      emailCol = headers.length - 1;
      rows[0] = headers;
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] }
      });
    }

    // Update kolom password, migrated, dan email menggunakan batchUpdate
    const updates = [];

    // Update kolom password
    if (passwordCol >= 0) {
      const colLetter = String.fromCharCode(65 + passwordCol);
      updates.push({
        range: `${sheetName}!${colLetter}${rowIndex + 1}`,
        values: [[newPassword]],
      });
    }

    // Update kolom migrated
    if (migratedCol >= 0) {
      const colLetter = String.fromCharCode(65 + migratedCol);
      updates.push({
        range: `${sheetName}!${colLetter}${rowIndex + 1}`,
        values: [["TRUE"]],
      });
    }

    // Update kolom email
    if (emailCol >= 0) {
      const colLetter = String.fromCharCode(65 + emailCol);
      updates.push({
        range: `${sheetName}!${colLetter}${rowIndex + 1}`,
        values: [[email]],
      });
    }

    await sheetsClient.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: updates,
      },
    });

    // Simpan juga ke Firestore
    await db.collection("akun").doc(cid).set({
      email,
      migrated: true,
    }, { merge: true });

    // Setelah Sheet/Firestore, update password resmi via Firebase Admin SDK
    await ensureEmailPasswordUser(email, newPassword);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Gagal proses ganti password:", err);
    res.status(500).json({ success: false, message: "Internal error", error: err.message });
  }
});

// Endpoint: simpan-email ke Google Sheets dan Firestore
app.post("/simpan-email", async (req, res) => {
  try {
    const { cid, email, nama } = req.body;
    if (!cid || !email) {
      return res.status(400).json({ success: false, message: "Missing cid or email." });
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: "serviceAccountKey.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = "PROFILE_ANAK";

    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:Z`,
    });

    const rows = getRes.data.values || [];
    if (rows.length === 0) throw new Error("Sheet kosong.");

    const headers = rows[0];
    let emailColIndex = headers.findIndex(h => h.toLowerCase() === "email");

    // Tambahkan kolom Email jika belum ada
    if (emailColIndex === -1) {
      headers.push("Email");
      emailColIndex = headers.length - 1;
      rows[0] = headers;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] }
      });
    }

    // Temukan baris sesuai CID
    const cidColIndex = headers.findIndex(h => h.toLowerCase() === "cid");
    const rowIndex = rows.findIndex((r, i) => i > 0 && r[cidColIndex] === cid);
    if (rowIndex === -1) throw new Error("CID tidak ditemukan.");

    // Update email di baris yang ditemukan
    const updateRange = `${sheetName}!${String.fromCharCode(65 + emailColIndex)}${rowIndex + 1}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: updateRange,
      valueInputOption: "RAW",
      requestBody: { values: [[email]] }
    });

    // Tambahkan/Update di Firestore
    await db.collection("akun").doc(cid).set({
      email,
      nama,
      role: "user"
    }, { merge: true });

    res.json({ success: true, message: "✅ Email berhasil disimpan ke Sheet & Firestore" });

  } catch (err) {
    console.error("❌ Gagal simpan email:", err);
    res.status(500).json({ success: false, message: "❌ Gagal simpan email", error: err.message });
  }
});

// Endpoint: Ambil CID berdasarkan email
app.get('/proxy-get-cid-by-email', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Missing email" });
  try {
    const snapshot = await db.collection("akun").where("email", "==", email.toLowerCase()).limit(1).get();
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      const cid = doc.id;
      res.json({ cid });
    } else {
      res.status(404).json({ error: "Email tidak ditemukan" });
    }
  } catch (err) {
    console.error("❌ Gagal mengambil CID dari email:", err);
    res.status(500).json({ error: "Gagal mengambil CID", detail: err.message });
  }
});


// Endpoint: Ambil role, cid, nama, email berdasarkan UID (Firestore)
app.get("/api/get-role-by-uid", async (req, res) => {
  const uid = req.query.uid;

  if (!uid) return res.status(400).json({ error: "Missing uid" });

  try {
    const akunRef = admin.firestore().collection("akun").doc(uid);
    const akunSnap = await akunRef.get();

    if (!akunSnap.exists) {
      return res.status(404).json({ error: "Akun tidak ditemukan" });
    }

    const akunData = akunSnap.data();

    return res.json({
      uid,
      cid: akunData.cid || "",
      role: akunData.role || "",
      nama: akunData.nama || "",
      email: akunData.email || "",
    });
  } catch (err) {
    console.error("❌ Error fetching role by UID:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// Endpoint: Admin get-users (protected by FIREBASE_API_KEY)
app.get("/admin/get-users", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== FIREBASE_API_KEY) {
    return res.status(403).json({ status: "unauthorized" });
  }

  try {
    const listUsers = await admin.auth().listUsers();
    const users = listUsers.users.map(userRecord => ({
      uid: userRecord.uid,
      email: userRecord.email
    }));
    res.json({ status: "success", users });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Endpoint: Ambil CID berdasarkan nomor WhatsApp
app.get('/proxy-get-cid-by-wa', async (req, res) => {
  const { wa } = req.query;
  if (!wa) return res.status(400).json({ error: "Missing wa" });
  try {
    // Cari dokumen akun dengan field wa = nomor wa
    const snapshot = await db.collection("akun").where("wa", "==", wa).limit(1).get();
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      const cid = doc.id;
      res.json({ cid });
    } else {
      res.json({ cid: null });
    }
  } catch (err) {
    console.error("❌ Gagal mengambil CID dari WA:", err);
    res.status(500).json({ error: "Gagal mengambil CID dari WA", detail: err.message });
  }
});

// Endpoint: Simpan metadata karya ke Sheet dan Firestore
app.post("/api/save-karya", async (req, res) => {
  try {
    const { cid, judul, link, id_karya, timestamp } = req.body;
    if (!cid || !judul || !link || !id_karya || !timestamp) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    // Simpan ke Google Sheets
    await fetch("https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cid, title: judul, url: link, id_karya })
    });

    // Simpan ke Firestore
    await db.collection("karya_anak").doc(id_karya).set({
      cid,
      judul,
      url: link,
      id_karya,
      timestamp
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Gagal simpan karya:", err);
    res.status(500).json({ success: false, message: "Gagal simpan karya", error: err.message });
  }
});

// Endpoint: Simpan progress ke Sheet
app.post("/api/update-progress", async (req, res) => {
  try {
    const { cid, id_modul, status, skor, timestamp } = req.body;
    if (!cid || !id_modul || !status || timestamp == null) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    await fetch("https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "updateProgress",
        cid,
        id_modul,
        status,
        skor,
        timestamp
      })
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Gagal update progress:", err);
    res.status(500).json({ success: false, message: "Gagal update progress", error: err.message });
  }
});

// Endpoint: Kirim notifikasi WhatsApp ke orang tua
app.post("/api/notify-ortu", async (req, res) => {
  try {
    const { cid, link, judul } = req.body;
    if (!cid || !link || !judul) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const profile = await fetch(`https://firebase-upload-backend.onrender.com/proxy-getprofile?cid=${cid}`);
    const data = await profile.json();
    const wa = data.whatsapp;
    const nama = data.nama || "";

    const msg = `👋 Halo, karya terbaru ${nama} sudah selesai dibuat!\n📘 Judul: ${judul}\n🔗 Link: ${link}\n🎉 Cek di dashboard Queen’s Academy ya!`;

    await fetch("https://app.whacenter.com/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: "f435a4f1b1a5bd29a38f38b408789a27",
        api_key: "792f407ba2b52aee94effa9432397a60",
        number: wa,
        message: msg
      })
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Gagal kirim WA:", err);
    res.status(500).json({ success: false, message: "Gagal kirim WA", error: err.message });
  }
});


// Fungsi: Ambil akun berdasarkan email dari Firestore
async function getAccountByEmail(email) {
  const usersRef = db.collection("akun");
  const snapshot = await usersRef.where("email", "==", email).limit(1).get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { uid: doc.id, ...doc.data() };
}

// Fungsi: Ambil WhatsApp berdasarkan CID dari spreadsheet PROFILE_ANAK
async function getWhatsappFromSheetByCID(cid) {
  const sheetId = '1z7ybkdO4eLsV_STdzO8pOVMZNUzdfcScSERyOFNm-GY'; // QA Psikotest
  const tabName = 'PROFILE_ANAK';
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheetsClient = google.sheets({ version: 'v4', auth });
  const range = `${tabName}!A2:H`;

  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: range,
  });

  const rows = response.data.values;
  if (!rows) return null;

  for (let row of rows) {
    const sheetCID = row[1]?.trim(); // Kolom B = CID
    const whatsapp = row[3]?.trim(); // Kolom D = WhatsApp
    if (sheetCID === cid && whatsapp) return whatsapp;
  }

  return null;
}

// Fungsi: Update WhatsApp ke Firestore jika belum ada
async function updateWhatsappIfNeeded(email) {
  const akun = await getAccountByEmail(email);
  if (!akun || akun.whatsapp) return;

  const whatsapp = await getWhatsappFromSheetByCID(akun.cid);
  if (whatsapp) {
    await db.collection("akun").doc(akun.uid).update({ whatsapp });
    console.log(`✅ Whatsapp updated for ${akun.uid}`);
  }
}

// --- Fungsi loginWithGoogle (frontend, bukan backend) ---

// Fungsi: Tambah ke Sheet PROFILE_ANAK menggunakan Google Sheets API (tidak dipakai di endpoint daftar-akun-baru)